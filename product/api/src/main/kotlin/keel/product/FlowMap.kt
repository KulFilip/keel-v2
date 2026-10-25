package keel.product

import keel.api.common.BadRequest
import keel.api.common.Conflict
import keel.api.common.NotFound
import keel.api.common.Time
import keel.api.events.EngineEvent
import keel.api.flow.FlowService
import keel.api.projects.ProjectService
import org.springframework.stereotype.Service

data class FlowsBody(val projects: List<String> = emptyList())

data class FlowEdit(val name: String? = null, val summary: String? = null, val hidden: Boolean? = null)

/** A business flow as the Product map shows it, with the tickets whose commits changed its files. */
data class FlowView(
    val projectId: String,
    val id: String,
    val name: String,
    val summary: String?,
    val team: String?,
    val steps: Any?,
    val endpoints: Any?,
    val tables: Any?,
    val edited: Boolean,
    val hidden: Boolean,
    val updatedAt: String,
    val tickets: List<String>,
)

data class MapTeam(val id: String, val name: String, val lead: String?, val projects: List<String>, val jiraProject: String?, val keys: String?)

/** The Product map: teams, their repos' business flows, and the tickets and work found in git. */
data class ProductMap(
    val teams: List<MapTeam>,
    val flows: List<FlowView>,
    val tickets: TeamTickets,
    val runs: List<FlowRun>,
    /** The team projects with no flows yet. */
    val notAnalysed: List<String>,
    /** B6: the team projects' tickets on the Tasks boards (Jira), with their initiatives and git work. */
    val board: List<LinkedTicket> = emptyList(),
)

/**
 * The business flows a product manager sees on the Product map: a flow analyst per repo finds them (product-flows on the
 * product repo, read only), keel keeps them here and as flows/<project>.json. A flow the product manager renamed or hid
 * keeps that when the flows are found again; a flow that is gone from the code goes, unless it was edited.
 */
@Service
class FlowMap(
    private val store: ProductStore,
    private val repo: ProductRepo,
    private val flows: FlowService,
    private val projects: ProjectService,
    private val links: TicketLinks,
    private val tickets: InitiativeTickets,
) {
    companion object {
        const val WORKFLOW = "product-flows"
    }

    fun start(b: FlowsBody): FlowRun {
        store.flowRuns().firstOrNull { it.status == "running" }?.let { throw Conflict("keel is finding the flows already", "Wait for that run, or stop it.") }
        val teams = store.teams()
        val pids = b.projects.ifEmpty { teams.flatMap { it.projects }.distinct() }
        if (pids.isEmpty()) throw BadRequest("No team has a project yet", "Add the teams' projects first (Teams).")
        val repos = pids.map { pid ->
            val p = projects.find(pid) ?: throw NotFound("No project $pid")
            val t = teams.firstOrNull { pid in it.projects }
            mapOf("id" to p.id, "title" to p.name, "root" to p.root, "team" to (t?.id ?: "unassigned"), "team_title" to (t?.name ?: "No team yet"))
        }
        val started = flows.start(repo.projectId(), WORKFLOW, "Business flows · ${pids.size} repo${if (pids.size == 1) "" else "s"}", null,
            allowFake = true, allowDirty = true, request = "Find the business flows of these repos: ${pids.joinToString()}.",
            options = mapOf("repos" to repos, "stage" to "flows"), where = "shared", ownBranch = false)
        val tid = started.get("thread_id")?.asText()?.takeIf { it.isNotBlank() } ?: throw Conflict("The engine did not say which flow it started")
        return FlowRun(tid, pids, "running", null, Time.now(), null).also { store.saveFlowRun(it) }
    }

    /** product.flows (one repo's flows) and the end of a flows run. */
    @Suppress("UNCHECKED_CAST")
    fun onEngineEvent(e: EngineEvent) {
        when (e.type) {
            "product.flows" -> {
                val pid = e.data["project"] as? String ?: return
                val team = (e.data["team"] as? String)?.takeIf { it != "unassigned" }
                val found = (e.data["flows"] as? List<Map<String, Any?>>).orEmpty()
                val before = store.flows(pid).associateBy { it.id }
                val now = Time.now()
                for (f in found) {
                    val id = f["id"] as? String ?: continue
                    val old = before[id]
                    val data = mapOf("steps" to f["steps"], "endpoints" to f["endpoints"], "tables" to f["tables"])
                    store.saveFlow(BusinessFlow(pid, id, if (old?.edited == true) old.name else (f["name"] as? String ?: id),
                        if (old?.edited == true) old.summary else f["summary"] as? String, team, data, old?.edited ?: false, old?.hidden ?: false, now))
                }
                val ids = found.mapNotNull { it["id"] as? String }.toSet()
                before.values.filter { it.id !in ids && !it.edited }.forEach { store.deleteFlow(pid, it.id) }
            }
            "thread.done", "thread.failed" -> {
                val run = store.flowRun(e.threadId) ?: return
                if (run.status != "running") return
                val status = if (e.type == "thread.failed") "failed" else if (e.data["status"] == "stopped") "stopped" else "done"
                store.saveFlowRun(run.copy(status = status, error = (e.data["error"] as? String)?.take(300), endedAt = Time.now()))
            }
        }
    }

    fun edit(pid: String, id: String, b: FlowEdit): FlowView {
        val f = store.flows(pid).firstOrNull { it.id == id } ?: throw NotFound("No flow $id in $pid")
        val name = b.name?.trim()?.ifEmpty { throw BadRequest("A flow needs a name") }?.take(80)
        store.saveFlow(f.copy(name = name ?: f.name, summary = b.summary?.trim()?.take(400) ?: f.summary, hidden = b.hidden ?: f.hidden,
            edited = f.edited || name != null || b.summary != null, updatedAt = Time.now()))
        return view(store.flows(pid).first { it.id == id }, store.links())
    }

    fun map(teamId: String?): ProductMap {
        val teams = store.teams()
        val team = teamId?.let { id -> teams.firstOrNull { it.id == id } ?: throw NotFound("No team $id") }
        val pids = (team?.let { listOf(it) } ?: teams).flatMap { it.projects }.distinct()
        val all = store.links()
        val shown = store.flows().filter { it.projectId in pids }
        return ProductMap(
            teams.map { MapTeam(it.id, it.name, it.lead, it.projects, it.jiraProject, it.keys) },
            shown.map { view(it, all) },
            links.tickets(team?.id),
            store.flowRuns().take(5),
            pids.filter { pid -> shown.none { it.projectId == pid } },
            tickets.board(pids),
        )
    }

    /** The tickets whose commits changed a file this flow cites (same project). */
    @Suppress("UNCHECKED_CAST")
    private fun view(f: BusinessFlow, links: List<TicketLink>): FlowView {
        val steps = f.data["steps"] as? List<Map<String, Any?>>
        val files = steps.orEmpty().mapNotNull { (it["cite"] as? String)?.substringBeforeLast(':') }.toSet()
        val keys = links.filter { it.kind == "commit" && it.projectId == f.projectId && it.files.any { file -> file in files } }.map { it.key }.distinct()
        return FlowView(f.projectId, f.id, f.name, f.summary, f.team, steps, f.data["endpoints"], f.data["tables"], f.edited, f.hidden, f.updatedAt, keys)
    }
}
