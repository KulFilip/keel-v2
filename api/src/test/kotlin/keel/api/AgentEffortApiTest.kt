package keel.api

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * keel 0.18.9: the thinking effort of an agent. It is part of the agent's model (per project, PUT /agents/{aid}),
 * "default" clears it, a word that cannot be an effort is refused; it goes to the engine with the flow's models; and
 * each agent call keeps the effort it ran with (agent_calls.effort), so Jobs and Live agents show it.
 */
class AgentEffortApiTest : ApiTest() {

    private fun agent(pid: String, aid: String) = get("/api/projects/$pid/agents").json().first { it["id"].asText() == aid }

    @Test
    fun `an agent's effort is set per project, cleared by default, and a bad one is refused`() {
        val (pid, _) = newProject("effort-agents")
        val model = mapOf("provider" to "claude", "mode" to "subscription", "model" to "sonnet", "effort" to "High")
        val r = put("/api/projects/$pid/agents/implementer", mapOf("model" to model)).andExpect(status().isOk).json()
        assertThat(r["model"]["effort"].asText()).isEqualTo("high")
        assertThat(agent(pid, "implementer")["model"]["effort"].asText()).isEqualTo("high")
        assertThat(agent(pid, "explorer")["model"].has("effort")).isFalse()          // only the one agent changed

        put("/api/projects/$pid/agents/implementer", mapOf("model" to model + ("effort" to "default"))).andExpect(status().isOk)
        assertThat(agent(pid, "implementer")["model"].has("effort")).isFalse()

        val bad = put("/api/projects/$pid/agents/implementer", mapOf("model" to model + ("effort" to "high; rm -rf /")))
            .andExpect(status().isBadRequest).json()
        assertThat(bad["error"].asText()).contains("effort cannot be")
        assertThat(agent(pid, "implementer")["model"].has("effort")).isFalse()
    }

    @Test
    fun `a custom agent keeps its effort and a flow sends every agent's effort to the engine`() {
        val (pid, _) = newProject("effort-custom")
        val a = post("/api/projects/$pid/agents", mapOf("name" to "Doc writer", "prompt" to "Write docs.",
            "model" to mapOf("provider" to "fake", "mode" to "api", "model" to "fake", "effort" to "medium"))).andExpect(status().isOk).json()
        assertThat(a["model"]["effort"].asText()).isEqualTo("medium")
        put("/api/projects/$pid/agents/implementer", mapOf("model" to mapOf("provider" to "fake", "mode" to "api", "model" to "fake", "effort" to "low")))
        post("/api/projects/$pid/flows", mapOf("workflow_id" to "feature", "title" to "Effort")).andExpect(status().isOk)
        val models = engine.lastBody("/threads")!!["models"]
        assertThat(models["implementer"]["effort"].asText()).isEqualTo("low")
        assertThat(models["doc-writer"]["effort"].asText()).isEqualTo("medium")
        assertThat(models["explorer"].has("effort")).isFalse()
    }

    @Test
    fun `each agent call keeps the effort it ran with`() {
        val (pid, _) = newProject("effort-jobs")
        fun ev(type: String, call: String, data: Map<String, Any?>) = mapOf("type" to type, "thread_id" to "t-effort", "project_id" to pid,
            "step" to "green", "call_id" to call, "at" to "2026-10-17T10:00:00Z", "data" to data)
        post("/internal/events", listOf(
            ev("agent.started", "e1", mapOf("agent" to "implementer", "provider" to "claude", "model" to "sonnet", "mode" to "subscription", "effort" to "xhigh")),
            ev("agent.started", "e2", mapOf("agent" to "explorer", "provider" to "claude", "model" to "haiku", "mode" to "subscription", "effort" to null)),
            ev("agent.finished", "e1", mapOf("status" to "done", "tokens_in" to 10, "tokens_out" to 5)),
        ), mapOf("X-Keel-Token" to TOKEN)).andExpect(status().isOk)
        val jobs = get("/api/jobs?project=$pid").json().associateBy { it["id"].asText() }
        assertThat(jobs["e1"]!!["effort"].asText()).isEqualTo("xhigh")
        assertThat(jobs["e2"]!!["effort"].isNull).isTrue()
        assertThat(get("/api/jobs/e1").json()["effort"].asText()).isEqualTo("xhigh")
    }
}
