package keel.api

import keel.api.mcp.McpLevelGuard
import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/** v0.16.1 the api itself refuses an MCP call above the level its token proves; the web app works as before. */
class McpLevelsApiTest : ApiTest() {

    private fun token(level: String): String =
        post("/api/mcp/token", mapOf("level" to level), mapOf("X-Keel-Token" to TOKEN)).andExpect(status().isOk).json()["token"].asText()

    private fun mcp(level: String? = null): Map<String, String> =
        mapOf("X-Keel-Via" to "mcp", "X-Keel-Client" to "test", "X-Keel-Tool" to "t") + (level?.let { mapOf("X-Keel-Mcp-Token" to token(it)) } ?: emptyMap())

    private val flow = mapOf("workflow_id" to "feature", "title" to "Scores")

    @Test
    fun `a level token comes only with the internal token`() {
        post("/api/mcp/token", mapOf("level" to "admin")).andExpect(status().isForbidden)
        post("/api/mcp/token", mapOf("level" to "admin"), mapOf("X-Keel-Token" to "wrong")).andExpect(status().isForbidden)
        val write = token("write")
        assertThat(write).hasSize(64).isNotEqualTo(token("admin")).isNotEqualTo(token("read"))
        assertThat(token("write")).isEqualTo(write)
        post("/api/mcp/token", mapOf("level" to "root"), mapOf("X-Keel-Token" to TOKEN)).andExpect(status().isBadRequest)
    }

    @Test
    fun `an MCP write without a token, or with the read token, is refused`() {
        val (pid, _) = newProject("lv-write")
        val res = post("/api/projects/$pid/flows", flow, mcp()).andExpect(status().isForbidden).json()
        assertThat(res["error"].asText()).contains("MCP write level").contains("keel2 mcp --write")
        post("/api/projects/$pid/flows", flow, mcp("read")).andExpect(status().isForbidden)
        post("/api/projects/$pid/flows", flow, mapOf("X-Keel-Mcp-Token" to "made-up")).andExpect(status().isForbidden)
        post("/api/projects/$pid/flows", flow, mcp("write")).andExpect(status().isOk)
    }

    @Test
    fun `an admin route needs the admin token`() {
        val res = post("/api/threads/t-stub-1/stop", null, mcp("write")).andExpect(status().isForbidden).json()
        assertThat(res["error"].asText()).contains("keel2 mcp --admin")
        post("/api/threads/t-stub-1/stop", null, mcp("admin")).andExpect(status().isOk)
        post("/api/projects", mapOf("root" to "/nowhere"), mcp("write")).andExpect(status().isForbidden)
    }

    @Test
    fun `the web app's plain requests work as before`() {
        val (pid, _) = newProject("lv-web")
        post("/api/projects/$pid/flows", flow).andExpect(status().isOk)
        post("/api/threads/t-stub-1/stop").andExpect(status().isOk)
        get("/api/projects/$pid").andExpect(status().isOk)
    }

    @Test
    fun `actions need the action's level, even without X-Keel-Via`() {
        val (pid, _) = newProject("lv-actions")
        post("/api/projects/$pid/actions/verify_fast", emptyMap<String, Any>()).andExpect(status().isForbidden)
        post("/api/projects/$pid/actions/verify_fast", emptyMap<String, Any>(), mcp("read")).andExpect(status().isForbidden)
        post("/api/projects/$pid/actions/open_pr", emptyMap<String, Any>(), mcp("write")).andExpect(status().isForbidden)
        assertThat(post("/api/projects/$pid/actions/trace", emptyMap<String, Any>()).andReturn().response.status).isNotEqualTo(403)
        assertThat(post("/api/projects/$pid/actions/verify_fast", emptyMap<String, Any>(), mcp("write")).andReturn().response.status).isNotEqualTo(403)
    }

    // the Database plugin's query route at the read level: plugins/db/api DatabaseMcpLevelApiTest

    @Test
    fun `the read actions are the engine's`() {
        // Twin of engine tests/test_mcp.py test_read_actions_match_the_api: both pin action_docs.ACTION_LEVELS.
        assertThat(McpLevelGuard.READ_ACTIONS).containsExactlyInAnyOrder("audit", "trace", "trace_strict", "arch", "arch_detect",
            "coverage_report", "lint_scope", "lint_report", "review_lenses")
        assertThat(McpLevelGuard.ADMIN_ACTIONS).containsExactlyInAnyOrder("arch_set", "open_pr")
    }
}
