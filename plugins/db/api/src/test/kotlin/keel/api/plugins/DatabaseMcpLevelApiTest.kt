package keel.api.plugins

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/** v0.16.1 MCP levels on the Database plugin's route (from keel's McpLevelsApiTest; the route is this plugin's): a
 *  read-level MCP server may query the database (keel_db_query) but never change it. */
class DatabaseMcpLevelApiTest : ApiTest() {

    private val mcp = mapOf("X-Keel-Via" to "mcp", "X-Keel-Client" to "test", "X-Keel-Tool" to "t")

    @Test
    fun `a read-level MCP server may query the database but not change it`() {
        val (pid, _) = newProject("lv-db")
        val read = mapOf("sql" to "select 1", "connection" to "db", "mask" to true)
        assertThat(post("/api/projects/$pid/db/query", read, mcp).andReturn().response.status).isNotEqualTo(403)
        post("/api/projects/$pid/db/query", read + mapOf("change" to true), mcp).andExpect(status().isForbidden)
    }
}
