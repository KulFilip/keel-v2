package keel.api.events

import keel.api.common.Json
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/**
 * keel 0.18.54 what was decided in one flow, for the Flow page's Decisions view and a gate step's answers: every
 * gate.decided of the flow (the decision, the answers or the reason, `by` when the Supervisor or keel answered, the
 * criterion) and what the Supervisor plugin said about a gate (supervisor.decided / .escalated / .paused), oldest first,
 * as the stored engine events. The live stream sends the same events while the page is open; this is what a reload, or
 * a flow that ran while nobody looked, still has.
 */
@Service
class FlowDecisionService(private val jdbc: JdbcTemplate) {

    fun of(project: String, thread: String, limit: Int = LIMIT): List<EngineEvent> = jdbc.query(
        """SELECT type, thread_id, project_id, step, call_id, at, data_json FROM events
           WHERE project_id = ? AND thread_id = ? AND type IN (${TYPES.joinToString(", ") { "?" }})
           ORDER BY id LIMIT ?""",
        { rs, _ ->
            EngineEvent(
                type = rs.getString("type"), threadId = rs.getString("thread_id"), projectId = rs.getString("project_id"),
                step = rs.getString("step"), at = rs.getString("at"), callId = rs.getString("call_id"), data = Json.readMap(rs.getString("data_json")),
            )
        },
        project, thread, *TYPES.toTypedArray(), limit,
    )

    companion object {
        val TYPES = listOf("gate.decided", "supervisor.decided", "supervisor.escalated", "supervisor.paused")
        const val LIMIT = 1000
    }
}

@RestController
@RequestMapping("/api/projects/{pid}/flows/{tid}")
class FlowDecisionController(private val decisions: FlowDecisionService) {

    /** The flow's gate decisions and the Supervisor's words about them, oldest first (the stored engine events). */
    @GetMapping("/decisions")
    fun decisions(@PathVariable pid: String, @PathVariable tid: String): List<EngineEvent> = decisions.of(pid, tid)
}
