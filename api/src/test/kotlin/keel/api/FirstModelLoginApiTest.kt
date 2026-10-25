package keel.api

import keel.api.common.Db
import keel.api.connections.FirstModelLogin
import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/** B8a: the first model login or key becomes the agents' model when nobody picked one yet (Connections said "logged in"
 *  while every agent stayed on the fake model). */
class FirstModelLoginApiTest : ApiTest() {
    @Autowired lateinit var jdbc: JdbcTemplate
    @Autowired lateinit var firstLogin: FirstModelLogin

    private var saved: String? = null

    @BeforeEach
    fun on() {
        saved = Db.settingsJson(jdbc, "general")
        Db.saveSettings(jdbc, "general", emptyMap<String, Any?>())
        firstLogin.enabled = true
    }

    @AfterEach
    fun off() {
        firstLogin.enabled = false
        listOf("ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN", "GITHUB_TOKEN").forEach { runCatching { delete("/api/secrets/$it") } }
        Db.saveSettings(jdbc, "general", saved?.let { keel.api.common.Json.readMap(it) } ?: emptyMap<String, Any?>())
    }

    private fun model(key: String) = get("/api/settings/general").json()[key]

    @Test
    fun `a saved claude login makes claude every agent's model`() {
        assertThat(model("default_model")["provider"].asText()).isEqualTo("fake")
        put("/api/secrets/CLAUDE_CODE_OAUTH_TOKEN", mapOf("value" to "sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123")).andExpect(status().isOk)
        for (k in listOf("default_model", "implementer_model", "reviewer_model")) {
            val m = model(k)
            assertThat(m["provider"].asText()).describedAs(k).isEqualTo("claude")
            assertThat(m["mode"].asText()).describedAs(k).isEqualTo("subscription")
            assertThat(m["model"].asText()).describedAs(k).isEqualTo("sonnet")
        }
    }

    @Test
    fun `an api key counts too, in api mode`() {
        put("/api/secrets/ANTHROPIC_API_KEY", mapOf("value" to "sk-ant-api03-test-0123456789xyz")).andExpect(status().isOk)
        assertThat(model("default_model")["provider"].asText()).isEqualTo("claude")
        assertThat(model("default_model")["mode"].asText()).isEqualTo("api")
    }

    @Test
    fun `a model someone picked is never replaced`() {
        put("/api/settings/general", mapOf("default_model" to mapOf("provider" to "codex", "mode" to "api", "model" to "gpt-5")))
            .andExpect(status().isOk)
        put("/api/secrets/CLAUDE_CODE_OAUTH_TOKEN", mapOf("value" to "sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123")).andExpect(status().isOk)
        assertThat(model("default_model")["provider"].asText()).isEqualTo("codex")
        assertThat(model("implementer_model")["provider"].asText()).isEqualTo("claude")
        // the second login changes nothing: every model is set now
        put("/api/secrets/ANTHROPIC_API_KEY", mapOf("value" to "sk-ant-api03-test-0123456789xyz")).andExpect(status().isOk)
        assertThat(model("implementer_model")["mode"].asText()).isEqualTo("subscription")
    }

    @Test
    fun `a github token is not a model login`() {
        put("/api/secrets/GH_TOKEN", mapOf("value" to "gho_abcdefghijklmnopqrstuvwxyz123456")).andExpect(status().isOk)
        put("/api/secrets/GITHUB_TOKEN", mapOf("value" to "ghp_abcdefghijklmnopqrstuvwxyz123456")).andExpect(status().isOk)
        assertThat(model("default_model")["provider"].asText()).isEqualTo("fake")
    }

    @Test
    fun `with local models only nothing changes`() {
        put("/api/settings/general", mapOf("local_only" to true)).andExpect(status().isOk)
        put("/api/secrets/CLAUDE_CODE_OAUTH_TOKEN", mapOf("value" to "sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123")).andExpect(status().isOk)
        assertThat(model("default_model")["provider"].asText()).isEqualTo("fake")
    }
}
