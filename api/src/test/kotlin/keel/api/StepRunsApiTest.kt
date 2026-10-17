package keel.api

import keel.api.jobs.StepRunService
import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * keel 0.18.11: what each step of one flow really did, for the Flow page's blocks (GET .../flows/{tid}/step-runs): its
 * calls added up per step and criterion, with tries, working time, tokens, cost, the model and effort that ran, and
 * the first line of the last answer. Calls of other flows and other projects never count.
 */
class StepRunsApiTest : ApiTest() {

    private fun ev(pid: String, tid: String, type: String, call: String, step: String, at: String, data: Map<String, Any?>) =
        mapOf("type" to type, "thread_id" to tid, "project_id" to pid, "step" to step, "call_id" to call, "at" to at, "data" to data)

    private fun started(agent: String, model: String, effort: String?) =
        mapOf("agent" to agent, "provider" to "claude", "model" to model, "mode" to "subscription", "effort" to effort)

    private fun finished(tin: Int, tout: Int, cost: Double, result: String, st: String = "done") =
        mapOf("status" to st, "tokens_in" to tin, "tokens_out" to tout, "tokens_cached" to 100, "cost_usd" to cost, "result" to result)

    @Test
    fun `each step adds up its calls, counts its tries and keeps the last answer's first line`() {
        val (pid, _) = newProject("step-runs")
        post("/internal/events", listOf(
            ev(pid, "t1", "agent.started", "c1", "spec", "2026-10-17T10:00:00Z", started("explorer", "sonnet", "high")),
            ev(pid, "t1", "agent.finished", "c1", "spec", "2026-10-17T10:02:10Z", finished(20_000, 11_000, 0.18, "## Spec\n\n**Spec with 6 criteria**, 2 questions\nmore")),
            // green ran twice for AC-1 (a send back between)
            ev(pid, "t1", "agent.started", "g1", "green", "2026-10-17T10:10:00Z", started("implementer", "haiku", null) + ("ac" to "AC-1")),
            ev(pid, "t1", "agent.finished", "g1", "green", "2026-10-17T10:11:00Z", finished(1_000, 500, 0.01, "first try")),
            ev(pid, "t1", "agent.started", "g2", "green", "2026-10-17T10:20:00Z", started("implementer", "sonnet", "xhigh") + ("ac" to "AC-1")),
            ev(pid, "t1", "agent.finished", "g2", "green", "2026-10-17T10:23:00Z", finished(2_000, 1_000, 0.05, "app/main.py: POST /health returns 405")),
            // two lanes at the same time are one try
            ev(pid, "t1", "agent.started", "r1", "review", "2026-10-17T10:30:00Z", started("reviewer", "sonnet", null)),
            ev(pid, "t1", "agent.started", "r2", "review", "2026-10-17T10:30:05Z", started("security-auditor", "sonnet", null)),
            ev(pid, "t1", "agent.finished", "r1", "review", "2026-10-17T10:31:00Z", finished(100, 50, 0.0, "fine")),
            ev(pid, "t1", "agent.finished", "r2", "review", "2026-10-17T10:32:00Z", finished(100, 50, 0.0, "no findings")),
            // another flow of this project
            ev(pid, "t2", "agent.started", "x1", "spec", "2026-10-17T11:00:00Z", started("explorer", "opus", null)),
        ), mapOf("X-Keel-Token" to TOKEN)).andExpect(status().isOk)

        val runs = get("/api/projects/$pid/flows/t1/step-runs").andExpect(status().isOk).json().toList()
        assertThat(runs.map { it["step"].asText() }).containsExactly("spec", "green", "review")

        val spec = runs[0]
        assertThat(spec["tries"].asInt()).isEqualTo(1)
        assertThat(spec["agent"].asText()).isEqualTo("explorer")
        assertThat(spec["model"].asText()).isEqualTo("sonnet")
        assertThat(spec["effort"].asText()).isEqualTo("high")
        assertThat(spec["ms"].asLong()).isEqualTo(130_000)
        assertThat(spec["tokens_in"].asLong()).isEqualTo(20_000)
        assertThat(spec["tokens_out"].asLong()).isEqualTo(11_000)
        assertThat(spec["cost_usd"].asDouble()).isEqualTo(0.18)
        assertThat(spec["result"].asText()).isEqualTo("Spec")

        val green = runs[1]
        assertThat(green["ac"].asText()).isEqualTo("AC-1")
        assertThat(green["tries"].asInt()).isEqualTo(2)
        assertThat(green["model"].asText()).isEqualTo("sonnet")                 // the last try's
        assertThat(green["effort"].asText()).isEqualTo("xhigh")
        assertThat(green["ms"].asLong()).isEqualTo(240_000)                      // 1 min + 3 min, not the 13 min between
        assertThat(green["tokens_in"].asLong()).isEqualTo(3_000)
        assertThat(green["result"].asText()).isEqualTo("app/main.py: POST /health returns 405")
        assertThat(green["call_id"].asText()).isEqualTo("g2")

        assertThat(runs[2]["tries"].asInt()).isEqualTo(1)                       // parallel lanes
        assertThat(get("/api/projects/$pid/flows/t2/step-runs").json().single()["status"].asText()).isEqualTo("running")
        assertThat(get("/api/projects/other/flows/t1/step-runs").json().size()).isEqualTo(0)
    }

    @Test
    fun `the result line skips markdown marks and empty lines and is at most 100 characters`() {
        assertThat(StepRunService.firstLine("\n\n**PASS** — the test proves AC-002.\n- RED 4be12d9")).isEqualTo("PASS — the test proves AC-002.")
        assertThat(StepRunService.firstLine("---\n> `quoted` text")).isEqualTo("quoted text")
        assertThat(StepRunService.firstLine("x".repeat(150))).hasSize(100).endsWith("…")
        assertThat(StepRunService.firstLine("   ")).isNull()
        assertThat(StepRunService.firstLine(null)).isNull()
    }
}
