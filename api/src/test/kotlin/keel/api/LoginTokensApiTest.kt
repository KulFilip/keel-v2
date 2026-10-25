package keel.api

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/** CLI logins (Claude setup-token, Codex auth.json, GitHub token for Copilot) live in the encrypted secrets table. */
class LoginTokensApiTest : ApiTest() {
    private val claudeToken = "sk-ant-oat01-LOGIN-token-abc"
    private val codexAuth = """{"tokens":{"access_token":"codex-secret-XYZ"}}"""

    @AfterEach
    fun clean() {
        listOf("CLAUDE_CODE_OAUTH_TOKEN", "CODEX_AUTH_JSON", "GH_TOKEN").forEach { runCatching { delete("/api/secrets/$it") } }
        put("/api/settings/general", mapOf("default_model" to mapOf("provider" to "fake", "mode" to "api", "model" to "fake"))).andExpect(status().isOk)
    }

    @Test
    fun `connections show the login secret of each subscription provider and never its value`() {
        put("/api/secrets/CLAUDE_CODE_OAUTH_TOKEN", mapOf("value" to claudeToken)).andExpect(status().isOk)
        val text = get("/api/connections").andExpect(status().isOk).andReturn().response.contentAsString
        assertThat(text).doesNotContain(claudeToken)
        val p = get("/api/connections").json()["providers"]
        val claude = p.first { it["id"].asText() == "claude" }
        assertThat(claude["login_secret"].asText()).isEqualTo("CLAUDE_CODE_OAUTH_TOKEN")
        assertThat(claude["login_set"].asBoolean()).isTrue()
        assertThat(claude["login_hint"].asText()).isEqualTo("…abc")
        assertThat(p.first { it["id"].asText() == "codex" }["login_secret"].asText()).isEqualTo("CODEX_AUTH_JSON")
        assertThat(p.first { it["id"].asText() == "copilot" }["login_secret"].asText()).isEqualTo("GH_TOKEN")
        assertThat(p.first { it["id"].asText() == "fake" }["login_secret"].isNull).isTrue()
    }

    @Test
    fun `a subscription test sends the stored login to the engine`() {
        put("/api/secrets/CLAUDE_CODE_OAUTH_TOKEN", mapOf("value" to claudeToken)).andExpect(status().isOk)
        put("/api/connections/claude", mapOf("mode" to "subscription")).andExpect(status().isOk)
        val res = post("/api/connections/claude/test").andExpect(status().isOk).andReturn().response.contentAsString
        assertThat(res).doesNotContain(claudeToken)
        val body = engine.lastBody("/providers/test")!!
        assertThat(body["mode"].asText()).isEqualTo("subscription")
        assertThat(body["key"].asText()).isEqualTo(claudeToken)
    }

    @Test
    fun `a flow with subscription models gets the logins under the engine's key names`() {
        put("/api/secrets/CLAUDE_CODE_OAUTH_TOKEN", mapOf("value" to claudeToken)).andExpect(status().isOk)
        put("/api/secrets/CODEX_AUTH_JSON", mapOf("value" to codexAuth)).andExpect(status().isOk)
        put("/api/settings/general", mapOf(
            "default_model" to mapOf("provider" to "claude", "mode" to "subscription", "model" to "sonnet"),
            "reviewer_model" to mapOf("provider" to "codex", "mode" to "subscription", "model" to "gpt-5"),
        )).andExpect(status().isOk)
        val (pid, _) = newProject("logins")
        post("/api/projects/$pid/flows", mapOf("workflow_id" to "feature", "title" to "x")).andExpect(status().isOk)
        val keys = engine.lastBody("/threads")!!["keys"]
        assertThat(keys["claude_oauth"].asText()).isEqualTo(claudeToken)
        assertThat(keys["codex_auth"].asText()).isEqualTo(codexAuth)
        assertThat(keys.has("claude")).isFalse()   // no API key is sent for a subscription model
    }

    @org.springframework.beans.factory.annotation.Autowired lateinit var secretStore: keel.api.connections.SecretService

    @Test
    fun `a failed test explains a badly copied token without showing it`() {
        // saved before keel checked the shape on save (PUT refuses these now)
        secretStore.put("CLAUDE_CODE_OAUTH_TOKEN", "••••••abcdef-half")
        put("/api/connections/claude", mapOf("mode" to "subscription")).andExpect(status().isOk)
        engine.providerTestAnswer = mapOf("ok" to false, "ms" to 10, "error" to "`claude` is not logged in inside the container.")
        val res = post("/api/connections/claude/test").andExpect(status().isOk).json()
        assertThat(res["error"].asText()).contains("characters a token never has").doesNotContain("abcdef")
        secretStore.put("CLAUDE_CODE_OAUTH_TOKEN", "half-of-a-token-ABC")
        assertThat(post("/api/connections/claude/test").json()["error"].asText()).contains("does not start with sk-ant-oat01-").contains("19 characters")
        engine.providerTestAnswer = null
    }

    @Test
    fun `saving refuses a Claude token that cannot be right and says why, without showing it`() {
        val res = put("/api/secrets/CLAUDE_CODE_OAUTH_TOKEN", mapOf("value" to "sk-ant-oat01-test_ABC#\nmore-XYZ")).andExpect(status().isBadRequest).json()
        assertThat(res["error"].asText()).isEqualTo("The Claude login token has characters a token never has (#).")
        assertThat(res["hint"].asText()).contains("in one piece")
        assertThat(res.toString()).doesNotContain("test_ABC").doesNotContain("XYZ")
        val short = put("/api/secrets/CLAUDE_CODE_OAUTH_TOKEN", mapOf("value" to "oat01-test_ABC")).andExpect(status().isBadRequest).json()
        assertThat(short["error"].asText()).isEqualTo("The Claude login token does not start with sk-ant- (it has 14 characters).")
        assertThat(short["hint"].asText()).contains("claude setup-token")
        put("/api/secrets/ANTHROPIC_API_KEY", mapOf("value" to "sk-ant-api03-te•st")).andExpect(status().isBadRequest)
        put("/api/secrets/GH_TOKEN", mapOf("value" to "gho_te#st")).andExpect(status().isBadRequest)
        put("/api/secrets/CODEX_AUTH_JSON", mapOf("value" to "tokens: abc")).andExpect(status().isBadRequest)
        assertThat(get("/api/connections").json()["providers"].first { it["id"].asText() == "claude" }["login_set"].asBoolean()).isFalse()
        // a token wrapped over two lines is still fine: line breaks and spaces are removed
        put("/api/secrets/CLAUDE_CODE_OAUTH_TOKEN", mapOf("value" to " sk-ant-oat01-test_ABC\n  -more-XYZ ")).andExpect(status().isOk)
    }

    @org.springframework.beans.factory.annotation.Autowired lateinit var connectionService: keel.api.connections.ConnectionService

    @Test
    fun `a subscription is ready only when keel has its login, not when the CLI is merely installed`() {
        val old = connectionService.tools
        val oldAuth = connectionService.opencodeAuthFile
        val auth = java.nio.file.Files.createTempDirectory("oc").resolve("opencode/auth.json")
        connectionService.opencodeAuthFile = { auth }
        connectionService.tools = keel.api.connections.MachineTools(which = { n -> "/bin/$n" },
            run = { cmd, _ -> keel.api.common.ProcResult(0, "2.1.197 (${cmd[0].substringAfterLast('/')})", "") })
        try {
            fun mode(p: String, m: String) = get("/api/connections").json()["providers"].first { it["id"].asText() == p }["modes"].first { it["id"].asText() == m }
            val claude = mode("claude", "subscription")
            assertThat(claude["ready"].asBoolean()).isFalse()
            assertThat(claude["need"].asText()).isEqualTo("login")
            assertThat(claude["detail"].asText()).isEqualTo("Claude Code found — add your login: claude setup-token, then Set up login.")
            assertThat(mode("codex", "subscription")["ready"].asBoolean()).isFalse()
            // OpenCode keeps its own login: a brand-new volume has none, so it is not ready (it said "login saved" before)
            val oc = mode("copilot", "opencode")
            assertThat(oc["ready"].asBoolean()).isFalse()
            assertThat(oc["need"].asText()).isEqualTo("login")
            assertThat(oc["detail"].asText()).isEqualTo("OpenCode found — add your login: run opencode auth login (GitHub Copilot) inside keel's container.")
            java.nio.file.Files.createDirectories(auth.parent)
            java.nio.file.Files.writeString(auth, """{"openai":{"type":"api","key":"x"}}""")
            assertThat(mode("copilot", "opencode")["ready"].asBoolean()).isFalse()     // another provider's login
            java.nio.file.Files.writeString(auth, """{"github-copilot":{"type":"oauth","refresh":"r","access":"a","expires":0}}""")
            assertThat(mode("copilot", "opencode")["ready"].asBoolean()).isTrue()
            assertThat(mode("copilot", "opencode")["detail"].asText()).isEqualTo("2.1.197 (opencode) found, login saved.")
            java.nio.file.Files.writeString(auth, "not json")
            assertThat(mode("copilot", "opencode")["ready"].asBoolean()).isFalse()
            put("/api/secrets/CLAUDE_CODE_OAUTH_TOKEN", mapOf("value" to claudeToken)).andExpect(status().isOk)
            val ready = mode("claude", "subscription")
            assertThat(ready["ready"].asBoolean()).isTrue()
            assertThat(ready["need"].isNull).isTrue()
            assertThat(ready["detail"].asText()).isEqualTo("2.1.197 (claude) found, login saved.")
            connectionService.tools = keel.api.connections.MachineTools(which = { null })
            assertThat(mode("claude", "subscription")["need"].asText()).isEqualTo("cli")
        } finally {
            connectionService.tools = old
            connectionService.opencodeAuthFile = oldAuth
        }
    }

    @Test
    fun `OpenCode's login file is where keel's agents run it, never the person's home in native mode`() {
        val path = keel.api.connections.ConnectionService::opencodeAuthPath
        assertThat(path(mapOf("HOME" to "/home/keel")).toString()).isEqualTo("/home/keel/.local/share/opencode/auth.json")
        assertThat(path(mapOf("HOME" to "/home/keel", "XDG_DATA_HOME" to "/x/data")).toString()).isEqualTo("/x/data/opencode/auth.json")
        assertThat(path(mapOf("HOME" to "/Users/ana", "KEEL_NATIVE" to "1", "KEEL_DATA" to "/k2/data")).toString())
            .isEqualTo("/k2/data/agent-home/home/.local/share/opencode/auth.json")
    }

    @Test
    fun `whitespace from a wrapped terminal copy is removed from a token`() {
        put("/api/secrets/CLAUDE_CODE_OAUTH_TOKEN", mapOf("value" to "sk-ant-oat01-first\n   second-half-gAA")).andExpect(status().isOk)
        put("/api/connections/claude", mapOf("mode" to "subscription")).andExpect(status().isOk)
        post("/api/connections/claude/test").andExpect(status().isOk)
        assertThat(engine.lastBody("/providers/test")!!["key"].asText()).isEqualTo("sk-ant-oat01-firstsecond-half-gAA")
    }

    @Test
    fun `resume sends the logins again, because the engine keeps them only in memory`() {
        put("/api/secrets/CLAUDE_CODE_OAUTH_TOKEN", mapOf("value" to claudeToken)).andExpect(status().isOk)
        put("/api/settings/general", mapOf("default_model" to mapOf("provider" to "claude", "mode" to "subscription", "model" to "sonnet"))).andExpect(status().isOk)
        val (pid, _) = newProject("resume-keys")
        val tid = post("/api/projects/$pid/flows", mapOf("workflow_id" to "feature", "title" to "x")).json()["thread_id"].asText()
        post("/api/threads/$tid/resume", mapOf("decision" to "approve")).andExpect(status().isOk)
        assertThat(engine.lastBody("/threads/$tid/resume")!!["keys"]["claude_oauth"].asText()).isEqualTo(claudeToken)
    }

    @Test
    fun `resume and rewind send the project's folder now, so a flow follows a moved mount`() {
        val (pid, root) = newProject("resume-root")
        val tid = post("/api/projects/$pid/flows", mapOf("workflow_id" to "feature", "title" to "x", "allow_fake" to true)).json()["thread_id"].asText()
        post("/api/threads/$tid/resume", mapOf("decision" to "approve")).andExpect(status().isOk)
        assertThat(engine.lastBody("/threads/$tid/resume")!!["root"].asText()).isEqualTo(root.toString())
        post("/api/threads/$tid/rewind", mapOf("checkpoint_id" to "c1"))
        assertThat(engine.lastBody("/threads/$tid/rewind")!!["root"].asText()).isEqualTo(root.toString())
    }

    @org.springframework.beans.factory.annotation.Autowired lateinit var jdbc: org.springframework.jdbc.core.JdbcTemplate
    @org.springframework.beans.factory.annotation.Autowired lateinit var flows: keel.api.flow.FlowService

    @Test
    fun `after a restart running flows get their logins and folder back`() {
        put("/api/secrets/CLAUDE_CODE_OAUTH_TOKEN", mapOf("value" to claudeToken)).andExpect(status().isOk)
        put("/api/settings/general", mapOf("default_model" to mapOf("provider" to "claude", "mode" to "subscription", "model" to "sonnet"))).andExpect(status().isOk)
        val (pid, root) = newProject("continue-after-restart")
        val tid = post("/api/projects/$pid/flows", mapOf("workflow_id" to "feature", "title" to "x")).json()["thread_id"].asText()
        jdbc.update("UPDATE threads SET status = 'running' WHERE id = ?", tid)
        flows.continueAfterRestart()
        val body = engine.lastBody("/threads/$tid/continue")!!
        assertThat(body["keys"]["claude_oauth"].asText()).isEqualTo(claudeToken)
        assertThat(body["root"].asText()).isEqualTo(root.toString())
    }
}
