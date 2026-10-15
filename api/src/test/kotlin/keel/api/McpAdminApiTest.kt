package keel.api

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/** v0.16.0 MCP admin: who acted is recorded, a project can be removed and comes back, secret files stay private. */
class McpAdminApiTest : ApiTest() {

    private val mcp by lazy {
        val write = post("/api/mcp/token", mapOf("level" to "write"), mapOf("X-Keel-Token" to TOKEN)).json()["token"].asText()
        mapOf("X-Keel-Via" to "mcp", "X-Keel-Client" to "Claude Code", "X-Keel-Tool" to "keel_start_flow", "X-Keel-Mcp-Token" to write)
    }

    @Test
    fun `a write from the MCP server is recorded on the project's timeline, a plain one is not`(@Autowired jdbc: JdbcTemplate) {
        val (pid, _) = newProject("mcp-audit")
        post("/api/projects/$pid/flows", mapOf("workflow_id" to "feature", "title" to "Scores"), mcp).andExpect(status().isOk)
        post("/api/projects/$pid/flows", mapOf("workflow_id" to "feature", "title" to "Again", "where" to "worktree")).andExpect(status().isOk)
        val rows = jdbc.queryForList("SELECT data_json FROM events WHERE project_id = ? AND type = 'mcp.call'", String::class.java, pid)
        assertThat(rows).hasSize(1)
        assertThat(rows[0]).contains("\"client\":\"Claude Code\"").contains("\"tool\":\"keel_start_flow\"").contains("\"ok\":true")
    }

    @Test
    fun `a removed project leaves the list and comes back with its folder`() {
        val (pid, root) = newProject("mcp-remove")
        delete("/api/projects/$pid").andExpect(status().isOk)
        assertThat(get("/api/projects").json().map { it["id"].asText() }).doesNotContain(pid)
        val again = post("/api/projects", mapOf("root" to root.toString())).andExpect(status().isOk).json()
        assertThat(again["id"].asText()).isEqualTo(pid)
        assertThat(get("/api/projects").json().map { it["id"].asText() }).contains(pid)
    }

    @Test
    fun `a secret file is never served`() {
        val (pid, _) = newProject("mcp-secret", mapOf(".env" to "TOKEN=x\n", ".env.example" to "TOKEN=\n"))
        get("/api/projects/$pid/repo/raw?path=.env").andExpect(status().isForbidden)
        get("/api/projects/$pid/repo/raw?path=.env.example").andExpect(status().isOk)
    }
}
