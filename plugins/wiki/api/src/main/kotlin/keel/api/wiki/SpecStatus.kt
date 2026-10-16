package keel.api.wiki

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import keel.api.knowledge.KnowledgeService
import keel.api.projects.ProjectService
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/** One flow that wrote a spec or was started from it. state: built | in_progress | stopped. */
data class SpecFlow(
    val threadId: String, val workflow: String?, val title: String, val status: String, val state: String,
    val phase: String?, val waiting: String?, val createdAt: String?, val updatedAt: String?, val resumable: Boolean,
)

/**
 * A spec's build status (0.17.3, docs/plugins/24-wiki-sections-spec-status.md): the flow that counts (one that runs or
 * waits, else the newest) and every flow on the spec, newest first. state: built | in_progress | stopped | not_built.
 * why: a stopped flow that cannot be resumed says why.
 */
data class SpecStatus(
    val spec: String, val path: String, val title: String, val acs: Int, val state: String,
    val threadId: String? = null, val workflow: String? = null, val flowTitle: String? = null, val status: String? = null,
    val phase: String? = null, val waiting: String? = null, val updatedAt: String? = null,
    val resumable: Boolean = false, val why: String? = null, val flows: List<SpecFlow> = emptyList(),
)

/**
 * Which flow built each spec, from what keel already stores (core's tables, read with SQL: core never imports this
 * plugin): the file history's rows (`doc_versions.thread_id`, the flows that wrote the spec) and the flows' saved state
 * (`threads.state_json.spec`, the spec a flow works on or was started from). A run deleted from the history is left
 * out, as the Runs list leaves it out.
 */
@Service
class SpecStatusService(
    private val projects: ProjectService,
    private val knowledge: KnowledgeService,
    private val wiki: WikiService,
    private val jdbc: JdbcTemplate,
    private val mapper: ObjectMapper,
) {
    private data class Row(
        val id: String, val workflow: String?, val title: String, val status: String, val phase: String?,
        val spec: String?, val waiting: String?, val createdAt: String?, val updatedAt: String?,
    )

    fun status(pid: String): List<SpecStatus> {
        val root = projects.root(pid)
        val specs = knowledge.specFiles(root)
        if (specs.isEmpty()) return emptyList()
        val wanted = specs.toSet()
        val byPath = linkedMapOf<String, MutableSet<String>>()
        jdbc.query(
            "SELECT DISTINCT path, thread_id FROM doc_versions WHERE project_id = ? AND thread_id IS NOT NULL AND thread_id <> ''",
            { rs, _ -> rs.getString(1) to rs.getString(2) }, pid,
        ).forEach { (path, tid) -> if (path in wanted) byPath.getOrPut(path) { linkedSetOf() } += tid }

        val rows = jdbc.query(
            "SELECT id, workflow_id, title, status, phase, state_json, created_at, updated_at FROM threads " +
                "WHERE project_id = ? AND $SHOWN ORDER BY created_at DESC, rowid DESC",
            { rs, _ ->
                val status = rs.getString(4) ?: "running"
                // only the states that name a spec (keel stores them compact: "spec":"…") or wait at a gate are read
                val json = rs.getString(6)?.takeIf { it.contains("\"spec\":\"") || status == "waiting" }
                val state = json?.let { runCatching { mapper.readTree(it) }.getOrNull() }
                Row(rs.getString(1), rs.getString(2), rs.getString(3) ?: "", status, rs.getString(5)?.takeIf { it != "none" },
                    text(state?.get("spec")), if (status == "waiting") waitingOf(state) else null, rs.getString(7), rs.getString(8))
            }, pid,
        )
        rows.forEach { r -> if (r.spec != null && r.spec in wanted) byPath.getOrPut(r.spec) { linkedSetOf() } += r.id }
        val (current, latest) = currentAndLatest(pid)
        fun resumable(r: Row) = r.status in STOPPED && (r.id == current || r.id == latest)

        return specs.map { path ->
            val f = root.resolve(path)
            val linked = byPath[path].orEmpty()
            val flows = rows.filter { it.id in linked }.take(MAX_FLOWS)
            val main = flows.firstOrNull { it.status in ACTIVE } ?: flows.firstOrNull()
            val base = SpecStatus("spec:$path", path, wiki.title(f), wiki.countAcs(f), "not_built")
            if (main == null) return@map base
            val canResume = resumable(main)
            base.copy(
                state = stateOf(main.status), threadId = main.id, workflow = main.workflow, flowTitle = main.title,
                status = main.status, phase = main.phase, waiting = main.waiting, updatedAt = main.updatedAt,
                resumable = canResume,
                why = if (main.status in STOPPED && !canResume) "A newer flow started after this one: only the last stopped flow can be resumed." else null,
                flows = flows.map { SpecFlow(it.id, it.workflow, it.title, it.status, stateOf(it.status), it.phase, it.waiting, it.createdAt, it.updatedAt, resumable(it)) },
            )
        }
    }

    /** The Flow page's own rule (FlowService.currentAndLatest): the project folder's flow, and the newest flow by start. */
    private fun currentAndLatest(pid: String): Pair<String?, String?> {
        val current = jdbc.query("SELECT id FROM threads WHERE project_id = ? AND worktree IS NULL AND $SHOWN " +
            "ORDER BY CASE WHEN status IN ('running','waiting') THEN 0 ELSE 1 END, updated_at DESC LIMIT 1", { rs, _ -> rs.getString(1) }, pid).firstOrNull()
        val latest = jdbc.query("SELECT id FROM threads WHERE project_id = ? AND $SHOWN ORDER BY created_at DESC, rowid DESC LIMIT 1",
            { rs, _ -> rs.getString(1) }, pid).firstOrNull()
        return current to latest
    }

    private fun waitingOf(state: JsonNode?): String =
        text(state?.get("waiting")?.get("title")) ?: text(state?.get("waiting")?.get("step")) ?: "a gate"

    private fun text(n: JsonNode?): String? = n?.takeIf { it.isTextual }?.asText()?.ifBlank { null }

    companion object {
        const val MAX_FLOWS = 10
        private const val SHOWN = "(hidden_at IS NULL OR status IN ('running','waiting'))"
        private val ACTIVE = setOf("running", "waiting")
        private val STOPPED = setOf("stopped", "failed")

        fun stateOf(status: String): String = when (status) {
            "done" -> "built"
            in ACTIVE -> "in_progress"
            else -> "stopped"
        }
    }
}

/** The Wiki's spec status: every spec of the project with the flow that built it (the menu's pills and the spec page). */
@RestController
@RequestMapping("/api/projects/{pid}/specs")
class SpecStatusController(private val specs: SpecStatusService) {

    @GetMapping("/status")
    fun status(@PathVariable pid: String): List<SpecStatus> = specs.status(pid)
}
