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

    @Test
    fun `a SQLite file must be inside the project, never in keel's data`() {
        val (pid, root) = newProject("dbsec-sqlite")
        put("/api/projects/$pid/plugins/db", mapOf("enabled" to true)).andExpect(status().isOk)
        val sqlite = { file: String -> mapOf("name" to "f${file.hashCode().toUInt()}", "driver" to "sqlite", "default_db" to file) }
        for (bad in listOf("/data/keel.db", props.dataDir.resolve("keel.db").toString(), "../elsewhere.db", "/etc/app.db")) {
            val r = post("/api/projects/$pid/databases", sqlite(bad)).andExpect(status().isBadRequest).json()
            assertThat(r["error"].asText()).contains("SQLite")
        }
        post("/api/projects/$pid/databases", mapOf("name" to "u", "url" to "sqlite:/data/keel.db")).andExpect(status().isBadRequest)
        post("/api/projects/$pid/db/connections", mapOf("name" to "u2", "url" to "sqlite:///data/keel.db")).andExpect(status().isBadRequest)
        post("/api/projects/$pid/databases", sqlite("data/app.db")).andExpect(status().isOk)
        post("/api/projects/$pid/databases", sqlite(root.resolve("app.db").toString())).andExpect(status().isOk)

        // a connection for every project: inside a project it is for
        post("/api/databases", sqlite("/tmp/other.db") + mapOf("projects" to listOf(pid))).andExpect(status().isBadRequest)
        val g = post("/api/databases", sqlite(root.resolve("shared.db").toString()) + mapOf("projects" to listOf(pid)))
            .andExpect(status().isOk).json()
        delete("/api/databases/${g["id"].asText()}").andExpect(status().isOk)
    }

    @Test
    fun `a connection agents may not use shows nothing of itself to them`() {
        val (pid, _) = newProject("dbsec-none")
        put("/api/projects/$pid/plugins/db", mapOf("enabled" to true)).andExpect(status().isOk)
        val hid = post("/api/projects/$pid/databases", mapOf("name" to "secretdb", "driver" to "postgres", "host" to "db.internal.example",
            "port" to 6543, "username" to "svc", "default_db" to "payroll", "agent_access" to "none")).andExpect(status().isOk).json()
        post("/api/projects/$pid/databases", mapOf("name" to "open", "driver" to "sqlite", "default_db" to "o.db")).andExpect(status().isOk)
        val id = hid["id"].asText()
        val admin = via + mapOf("X-Keel-Mcp-Token" to tokens.tokenFor("admin"))

        agentGet("/api/databases/$id", admin).andExpect(status().isNotFound)
        val listed = agentGet("/api/projects/$pid/db/connections").andExpect(status().isOk).json()
        assertThat(listed.map { it["name"].asText() }).contains("open").doesNotContain("secretdb")
        assertThat(listed.toString()).doesNotContain("db.internal.example", "payroll")

        val g = post("/api/databases", mapOf("name" to "gnone", "driver" to "sqlite", "default_db" to "g.db", "agent_access" to "none",
            "projects" to listOf(pid))).andExpect(status().isOk).json()
        try {
            assertThat(agentGet("/api/databases", admin).andExpect(status().isOk).json().map { it["name"].asText() }).doesNotContain("gnone")
        } finally {
            delete("/api/databases/${g["id"].asText()}")
        }
        // the person still sees everything
        get("/api/databases/$id").andExpect(status().isOk)
        assertThat(get("/api/projects/$pid/db/connections").json().map { it["name"].asText() }).contains("secretdb", "open")
    }
}
