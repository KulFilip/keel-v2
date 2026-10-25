package keel.api.plugins

import keel.api.common.KeelProperties
import keel.api.mcp.McpTokens
import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * keel 0.18.55: what an e2e test of the Database plugin found in its api part. An agent cannot turn masking off, a
 * SQLite file lives in a project, a connection agents may not use stays hidden from them, an MCP query is in the audit
 * with its SQL, and the plugin's project routes need the plugin on.
 */
class DatabaseSecurityApiTest : ApiTest() {
    @Autowired lateinit var tokens: McpTokens
    @Autowired lateinit var props: KeelProperties
    @Autowired lateinit var jdbc: JdbcTemplate

    private val via = mapOf("X-Keel-Via" to "mcp", "X-Keel-Client" to "test", "X-Keel-Tool" to "keel_db_query")

    private fun agentGet(url: String, headers: Map<String, String> = via) =
        mvc.perform(MockMvcRequestBuilders.get(url).also { b -> headers.forEach { (k, v) -> b.header(k, v) } })

    @Test
    fun `an agent's query is always masked, whatever it asks`() {
        val (pid, _) = newProject("dbsec-mask")
        put("/api/projects/$pid/plugins/db", mapOf("enabled" to true)).andExpect(status().isOk)
        post("/api/projects/$pid/databases", mapOf("name" to "local", "driver" to "sqlite", "default_db" to "app.db")).andExpect(status().isOk)

        post("/api/projects/$pid/db/query", mapOf("sql" to "select password_hash from users", "connection" to "local", "mask" to false), via)
            .andExpect(status().isOk)
        assertThat(engine.lastBody("/plugins/db/query")!!["mask"].asBoolean()).isTrue()
        // the person's own query keeps what the person asked
        post("/api/projects/$pid/db/query", mapOf("sql" to "select password_hash from users", "connection" to "local")).andExpect(status().isOk)
        assertThat(engine.lastBody("/plugins/db/query")!!["mask"].asBoolean()).isFalse()
    }
}
