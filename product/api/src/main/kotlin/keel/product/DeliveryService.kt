package keel.product

import keel.api.common.BadRequest
import keel.api.common.Conflict
import keel.api.common.NotFound
import keel.api.projects.ProjectService
import keel.api.tasks.NewTask
import keel.api.tasks.TaskService
import keel.api.tasks.TaskStatus
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service

data class StoryView(
    val id: String,
    val epic: String,
    val team: String?,
    val repo: String?,
    val projectId: String?,
    val title: String,
    val criteria: List<String>,
    val tasks: List<String>,
    val dependsOn: List<String>,
    val estimateDays: List<Double>,
    val taskId: String?,
    val taskStatus: String?,
    val jiraKey: String?,
    /** The branches and commits whose names carry its Jira key (TicketLinks). */
    val work: TicketWork? = null,
)

data class EpicView(val id: String, val team: String?, val title: String, val stories: List<StoryView>, val jiraKey: String? = null)

data class PlanView(
    val version: Int,
    val ok: Boolean,
    val problems: List<String>,
    val criticalPath: List<String>,
    val criticalDays: Double?,
    val teams: Any?,
    val totalDays: Any?,
    val epics: List<EpicView>,
    val progress: Progress?,
    val initiativeKey: String? = null,
    /** The plan was changed by hand after keel checked it (its critical path and totals may be old). */
    val edited: Boolean = false,
)

data class HandoffBody(
    /** tasks | jira | both (Jira first, then keel Tasks that carry the ticket keys) */
    val target: String = "tasks",
    /** story ids; empty = every story not handed off yet */
    val stories: List<String> = emptyList(),
)

data class HandoffResult(val tasks: List<String>, val jira: List<String>, val skipped: List<String>, val notes: List<String>)

/** After the plan: the stories go to keel Tasks (one per repo, with their criteria) or to Jira, and their progress rolls up. */
@Service
class DeliveryService(
    private val store: ProductStore,
    private val tasks: TaskService,
    private val projects: ProjectService,
    private val teams: TeamService,
    private val sender: TicketSender,
    private val links: TicketLinks,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    @Suppress("UNCHECKED_CAST")
    fun saveItems(i: Initiative, version: Int, plan: Any?) {
        val id = i.id
        val epics = (plan as? Map<String, Any?>)?.get("epics") as? List<Map<String, Any?>> ?: return
        // the initiative's own repos first (by id or name): two keel projects may have the same name
        val rows = projects.rows()
        val own = rows.filter { it.id in i.repos }

        fun project(repo: String) = (own.firstOrNull { it.id == repo } ?: own.firstOrNull { it.name.equals(repo, true) }
            ?: rows.firstOrNull { it.id == repo } ?: rows.firstOrNull { it.name.equals(repo, true) })?.id
        // a story of an earlier version that was sent already keeps its ticket and its task (same id = same story)
        val before = (version - 1 downTo 1).asSequence().map { store.items(id, it) }.firstOrNull { it.isNotEmpty() }.orEmpty().associateBy { it.id }
        for (e in epics) {
            val eid = e["id"] as? String ?: "EP"
            store.saveEpic(PlanEpic(id, version, eid, e["team"] as? String, (e["title"] as? String)?.ifBlank { null }?.take(300) ?: eid))
            val stories = e["stories"] as? List<Map<String, Any?>> ?: continue
            for (s in stories) {
                val sid = s["id"] as? String ?: continue
                val repo = s["repo"] as? String
                val pid = repo?.let { project(it) }
                store.saveItem(PlanItem(id, version, sid, eid, e["team"] as? String, repo, (s["title"] as? String ?: sid).take(300),
                    s, before[sid]?.jiraKey, pid, before[sid]?.taskId))
            }
        }
    }

    @Suppress("UNCHECKED_CAST")
    fun planView(i: Initiative, doc: ProductDoc): PlanView {
        val d = doc.data as? Map<String, Any?> ?: emptyMap()
        val items = store.items(i.id, doc.version)
        val statuses = items.mapNotNull { it.taskId }.associateWith { tid -> runCatching { tasks.get(tid).status }.getOrNull() }
        val work = links.forKeys(items.mapNotNull { it.jiraKey })
        val stories = items.map { p ->
            val b = p.body
            StoryView(p.id, p.epic, p.team, p.repo, p.projectId, p.title, strings(b["criteria"]), strings(b["tasks"]), strings(b["depends_on"]),
                days(b["estimate_days"]), p.taskId, p.taskId?.let { statuses[it] }, p.jiraKey, p.jiraKey?.let { work[it] })
        }
        val tickets = store.tickets(i.id)
        val epicTitles = ((d["plan"] as? Map<String, Any?>)?.get("epics") as? List<Map<String, Any?>>).orEmpty()
            .associate { (it["id"] as? String ?: "") to (it["title"] as? String ?: "") }
        // the epics as the product manager left them (an epic with no story yet is listed too)
        val drafts = store.epics(i.id, doc.version)
        val byEpic = stories.groupBy { it.epic }
        val epics = (drafts.map { it.id } + byEpic.keys).distinct().map { eid ->
            val e = drafts.firstOrNull { it.id == eid }
            val list = byEpic[eid].orEmpty()
            EpicView(eid, e?.team ?: list.firstOrNull()?.team, e?.title ?: epicTitles[eid]?.ifBlank { null } ?: eid, list,
                tickets.lastOrNull { it.level == "epic" && it.ref == eid }?.jiraKey)
        }
        return PlanView(doc.version, d["ok"] == true, strings(d["problems"]), strings(d["critical_path"]), (d["critical_days"] as? Number)?.toDouble(),
            d["teams"], d["total_days"], epics, if (items.any { it.taskId != null }) progress(items).let { Progress(it.first, it.second) } else null,
            tickets.lastOrNull { it.level == "initiative" }?.jiraKey, store.events(i.id).any { it.kind == "edited" && it.data.planVersion() == doc.version })
    }

    /** (done, total) over the stories handed to keel Tasks. */
    fun progress(items: List<PlanItem>): Pair<Int, Int> {
        val linked = items.filter { it.taskId != null }
        val done = linked.count { p -> runCatching { tasks.get(p.taskId!!).status == TaskStatus.DONE }.getOrDefault(false) }
        return done to items.size
    }

    fun handoff(i: Initiative, b: HandoffBody): HandoffResult {
        if (b.target !in setOf("tasks", "jira", "both")) throw BadRequest("target is tasks, jira or both")
        if (i.stage != "delivery") throw Conflict("The plan of ${i.id} is not agreed yet", "The leads agree the plan first.")
        val doc = store.latest(i.id, "plan") ?: throw NotFound("${i.id} has no plan")
        var items = store.items(i.id, doc.version)
        if (b.stories.isNotEmpty()) items = items.filter { it.id in b.stories }
        val notes = mutableListOf<String>()
        val jiraKeys = mutableListOf<String>()
        if (b.target != "tasks") {
            val sent = sender.send(i, items.map { it.id }.takeIf { b.stories.isNotEmpty() }.orEmpty())
            notes += sent.notes
            jiraKeys += sent.jira
            val now = store.items(i.id, doc.version).associateBy { it.id }
            items = items.map { now[it.id] ?: it }
        }
        val made = mutableListOf<String>()
        val skipped = mutableListOf<String>()
        if (b.target != "jira") {
            for (p in items.filter { it.taskId == null }) {
                val pid = p.projectId
                if (pid == null) {
                    skipped += p.id
                    notes += "${p.id}: no keel project for the repo \"${p.repo ?: "?"}\""
                    continue
                }
                val t = tasks.create(pid, NewTask(title = "${p.id} · ${p.title}".take(200), description = description(i, p), type = "story",
                    externalKey = p.jiraKey))
                store.saveItem(p.copy(taskId = t.id))
                made += t.id
            }
        }
        store.event(i.id, InitiativeService.YOU, "handoff", buildString {
            append("Sent ")
            if (made.isNotEmpty()) append("${made.size} stories to keel Tasks")
            if (made.isNotEmpty() && jiraKeys.isNotEmpty()) append(" and ")
            if (jiraKeys.isNotEmpty()) append("${jiraKeys.size} tickets to Jira")
            if (made.isEmpty() && jiraKeys.isEmpty()) append("nothing (every story was sent before)")
        }, mapOf("tasks" to made, "jira" to jiraKeys, "skipped" to skipped))
        return HandoffResult(made, jiraKeys, skipped, notes)
    }

    /** The task text: the story, its criteria as a keel-criteria block (the flow starts with them) and where it comes from. */
    fun description(i: Initiative, p: PlanItem): String = storyText(i, p)

    /** After the outcome: a lesson for each team in play goes to its knowledge, as a suggestion they accept or not. */
    fun learn(i: Initiative) {
        val outcome = store.latest(i.id, "outcome")?.text?.take(1500) ?: return
        val inPlay = (store.latest(i.id, "plan")?.let { store.items(i.id, it.version) }.orEmpty().mapNotNull { it.team } +
            i.repos.flatMap { teams.ownersOf(it).map { t -> t.id } }).distinct()
        inPlay.filter { store.team(it) != null }.forEach { tid ->
            runCatching { teams.suggest(tid, "lessons", "### ${i.id} · ${i.title}\n\n$outcome", i.id) }
                .onFailure { log.warn("keel Product could not suggest a lesson to {}: {}", tid, it.message) }
        }
    }

    private fun strings(v: Any?): List<String> = (v as? List<*>).orEmpty().mapNotNull { it?.toString()?.takeIf { s -> s.isNotBlank() } }

    private fun days(v: Any?): List<Double> = when (v) {
        is Number -> listOf(v.toDouble(), v.toDouble())
        is List<*> -> v.mapNotNull { (it as? Number)?.toDouble() }
        else -> emptyList()
    }
}

/** A story as text for a keel task or a Jira ticket: the story, its tasks, its criteria as a keel-criteria block (a flow
 *  started from it begins with them) and where it comes from. */
fun storyText(i: Initiative, p: PlanItem): String = buildString {
    fun strings(v: Any?): List<String> = (v as? List<*>).orEmpty().mapNotNull { it?.toString()?.takeIf { s -> s.isNotBlank() } }
    append("${p.title}\n\nPart of ${i.id}: ${i.title}. ${i.idea}\n")
    p.team?.let { append("Team: $it\n") }
    val deps = strings(p.body["depends_on"])
    if (deps.isNotEmpty()) append("Waits for: ${deps.joinToString()}\n")
    val todo = strings(p.body["tasks"])
    if (todo.isNotEmpty()) append("\nTasks:\n").append(todo.joinToString("\n") { "- $it" }).append("\n")
    val criteria = strings(p.body["criteria"])
    if (criteria.isNotEmpty()) append("\n```keel-criteria\n").append(criteria.joinToString("\n")).append("\n```\n")
}

/** The plan version an "edited" event (PlanDrafts) was about. */
private fun Any?.planVersion(): Int? = ((this as? Map<*, *>)?.get("version") as? Number)?.toInt()
