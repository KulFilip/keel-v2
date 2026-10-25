package keel.api

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * keel 0.18.54: a flow's decisions for the Flow page (GET .../flows/{tid}/decisions): its gate.decided events with who
 * answered, and what the Supervisor said, oldest first. Other events, other flows and other projects never show.
 */
class FlowDecisionsApiTest : ApiTest() {

    private fun ev(pid: String, tid: String, type: String, step: String, at: String, data: Map<String, Any?>) =
        mapOf("type" to type, "thread_id" to tid, "project_id" to pid, "step" to step, "at" to at, "data" to data)

    @Test
    fun `a flow's gate decisions and the supervisor's words, oldest first, with who answered`() {
        val (pid, _) = newProject("decisions")
        post("/internal/events", listOf(
            ev(pid, "t1", "gate.waiting", "interview_gate", "2026-10-17T10:00:00Z", mapOf("title" to "your answers")),
            ev(pid, "t1", "gate.decided", "interview_gate", "2026-10-17T10:01:00Z", mapOf("gate" to "your answers", "decision" to "approve",
                "clarify" to true, "why" to "Answers to your questions:\n1. Which carts?\n   → Only open carts")),
            ev(pid, "t1", "agent.usage", "spec", "2026-10-17T10:02:00Z", mapOf("agent" to "explorer", "tokens_in" to 10)),
            ev(pid, "t1", "gate.decided", "spec_gate", "2026-10-17T10:05:00Z", mapOf("gate" to "spec approval", "decision" to "reject",
                "why" to "AC-2 misses the empty cart", "by" to "supervisor")),
            ev(pid, "t1", "supervisor.decided", "spec_gate", "2026-10-17T10:05:01Z", mapOf("decision" to "reject", "why" to "AC-2 misses the empty cart",
                "confidence" to "high")),
            ev(pid, "t2", "gate.decided", "spec_gate", "2026-10-17T11:00:00Z", mapOf("decision" to "approve")),
        ), mapOf("X-Keel-Token" to TOKEN)).andExpect(status().isOk)

        val rows = get("/api/projects/$pid/flows/t1/decisions").andExpect(status().isOk).json().toList()
        assertThat(rows.map { it["type"].asText() }).containsExactly("gate.decided", "gate.decided", "supervisor.decided")
        assertThat(rows.map { it["step"].asText() }).containsExactly("interview_gate", "spec_gate", "spec_gate")
        assertThat(rows[0]["thread_id"].asText()).isEqualTo("t1")
        assertThat(rows[0]["at"].asText()).isEqualTo("2026-10-17T10:01:00Z")
        assertThat(rows[0]["data"]["why"].asText()).startsWith("Answers to your questions:")
        assertThat(rows[1]["data"]["by"].asText()).isEqualTo("supervisor")
        assertThat(rows[2]["data"]["confidence"].asText()).isEqualTo("high")

        assertThat(get("/api/projects/$pid/flows/t2/decisions").json().size()).isEqualTo(1)
        assertThat(get("/api/projects/other/flows/t1/decisions").json().size()).isEqualTo(0)
    }
}
