package keel.api

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/** keel TUI (cli/): its writes are on the timeline "via keel TUI", and it draws with keel's ASCII diagrams. */
class TuiApiTest : ApiTest() {
    @Autowired lateinit var jdbc: JdbcTemplate

    private val tui = mapOf("X-Keel-Via" to "tui", "X-Keel-Client" to "keel TUI 0.17.3", "X-Keel-Tool" to "/flow")

    @Test
    fun `a write from keel TUI is recorded as a tui call, a read and a plain write are not`() {
        val (pid, _) = newProject("tui-audit")
        post("/api/projects/$pid/flows", mapOf("workflow_id" to "feature", "title" to "Scores"), tui).andExpect(status().isOk)
        post("/api/projects/$pid/flows", mapOf("workflow_id" to "feature", "title" to "Again", "where" to "worktree")).andExpect(status().isOk)
        get("/api/projects/$pid/flow").andExpect(status().isOk)
        val rows = jdbc.queryForList("SELECT data_json FROM events WHERE project_id = ? AND type = 'tui.call'", String::class.java, pid)
        assertThat(rows).hasSize(1)
        assertThat(rows[0]).contains("\"via\":\"tui\"").contains("\"client\":\"keel TUI 0.17.3\"").contains("\"tool\":\"/flow\"")
            .contains("\"ok\":true")
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM events WHERE project_id = ? AND type = 'mcp.call'", Int::class.java, pid)).isZero()
    }

    @Test
    fun `keel TUI is not held to an MCP level`() {
        val (pid, _) = newProject("tui-level")
        // an admin route for MCP: keel TUI acts as the person at the keyboard, like the dashboard
        post("/api/projects/$pid/rules/packs", mapOf("yaml" to "name: x\n"), tui).andExpect { assertThat(it.response.status).isNotEqualTo(403) }
    }

    @Test
    fun `diagrams go to the engine's renderer, at the MCP read level too`() {
        val body = mapOf("kind" to "workflow", "data" to mapOf("workflow" to mapOf("steps" to emptyList<Any>())), "width" to 80)
        val a = post("/api/diagrams/ascii", body).andExpect(status().isOk).json()
        assertThat(a["text"].asText()).isEqualTo("stub workflow 80\n")
        post("/api/diagrams/ascii", body, mapOf("X-Keel-Via" to "mcp", "X-Keel-Client" to "Claude Code")).andExpect(status().isOk)
        val bad = post("/api/diagrams/ascii", mapOf("kind" to "pie")).andExpect(status().isBadRequest).json()
        assertThat(bad["error"].asText()).contains("no diagram kind")
    }
}
