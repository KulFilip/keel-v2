package keel.api

import keel.api.rules.RulesService
import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/** v0.16.2 keel's rules: the api gives the engine the project's folder, and adds what only it has (the events). */
class RulesApiTest : ApiTest() {
    @Autowired lateinit var jdbc: JdbcTemplate

    private fun event(pid: String, tid: String, type: String, callId: String?, data: String) = jdbc.update(
        "INSERT INTO events(thread_id, project_id, type, step, call_id, at, data_json) VALUES (?, ?, ?, 'green', ?, ?, ?)",
        tid, pid, type, callId, java.time.Instant.now().toString(), data,
    )

    @Test
    fun `the rules page and pack changes go to the engine with the project's folder`() {
        val (pid, root) = newProject("rules-view")
        engine.extraRoutes["/rules"] = { _ -> 200 to mapOf("builtins" to emptyList<Any>(), "packs" to emptyList<Any>()) }
        engine.extraRoutes["/rules/packs"] = { b -> 200 to mapOf("pack" to mapOf("id" to b?.path("yaml")?.asText()?.substringAfter("id: ")?.substringBefore("\n"))) }
        engine.extraRoutes["/rules/library/no-new-dependencies"] = { _ -> 200 to mapOf("yaml" to "id: no-new-dependencies\n") }
        engine.extraRoutes["/rules/config"] = { _ -> 200 to mapOf("ok" to true) }
        get("/api/projects/$pid/rules").andExpect(status().isOk)
        // the folder is encoded once: decoded, the query is the folder itself (a double encoding leaves %2F in it)
        val query = engine.calls.last { it.path == "/rules" }.query ?: ""
        assertThat(java.net.URLDecoder.decode(query, Charsets.UTF_8)).isEqualTo("root=$root")

        post("/api/projects/$pid/rules/library/no-new-dependencies/install").andExpect(status().isOk)
        assertThat(engine.lastBody("/rules/packs")!!["root"].asText()).isEqualTo(root.toString())
        assertThat(engine.lastBody("/rules/packs")!!["yaml"].asText()).isEqualTo("id: no-new-dependencies\n")

        put("/api/projects/$pid/rules/packs/mine", mapOf("yaml" to "id: mine\n")).andExpect(status().isOk)
        assertThat(engine.lastBody("/rules/packs")!!["replace"].asText()).isEqualTo("mine")
        put("/api/projects/$pid/rules/packs/Bad%20Id", mapOf("yaml" to "x")).andExpect(status().isBadRequest)

        put("/api/projects/$pid/rules/config", mapOf("rules" to mapOf("off" to listOf("read-twice")))).andExpect(status().isOk)
        assertThat(engine.lastBody("/rules/config")!!["patch"]["rules"]["off"][0].asText()).isEqualTo("read-twice")
    }

    @Test
    fun `export is a yaml download`() {
        val (pid, _) = newProject("rules-export")
        engine.extraRoutes["/rules/packs/mine"] = { _ -> 200 to mapOf("yaml" to "id: mine\nname: Mine\n") }
        val res = get("/api/projects/$pid/rules/packs/mine/export").andExpect(status().isOk)
            .andExpect(header().string("Content-Disposition", "attachment; filename=mine.rules.yaml")).andReturn()
        assertThat(res.response.contentAsString).isEqualTo("id: mine\nname: Mine\n")
    }

    @Test
    fun `the dry-run gets the project's recent tool calls with their phase`() {
        val (pid, _) = newProject("rules-dry")
        engine.extraRoutes["/rules/check"] = { b -> 200 to mapOf("ok" to true, "seen" to b?.path("calls")?.size()) }
        event(pid, "t-1", "agent.started", "c1", """{"agent":"implementer","phase":"green"}""")
        event(pid, "t-1", "agent.step", "c1", """{"kind":"tool","tool":"Bash","text":"npm install left-pad"}""")
        event(pid, "t-1", "agent.step", "c1", """{"kind":"text","text":"thinking"}""")
        event(pid, "t-1", "guard.refused", "c1", """{"tool":"run_command","command":"pnpm add zod","phase":"green","reason":"x"}""")
        val out = post("/api/projects/$pid/rules/check", mapOf("yaml" to "id: x\n")).andExpect(status().isOk).json()
        assertThat(out["seen"].asInt()).isEqualTo(2)
        val calls = engine.lastBody("/rules/check")!!["calls"]
        assertThat(calls.map { it["phase"].asText() }).containsOnly("green")
        assertThat(calls.map { (it["command"] ?: it["text"]).asText() }).containsExactly("pnpm add zod", "npm install left-pad")
    }

    @Test
    fun `rules now adds the thread's refusals grouped by rule`() {
        val (pid, _) = newProject("rules-now")
        jdbc.update("INSERT INTO threads(id, project_id, title, status, state_json, created_at, updated_at) VALUES ('t-now', ?, 'x', 'running', '{}', 'now', 'now')", pid)
        engine.extraRoutes["/threads/t-now/rules-now"] = { _ -> 200 to mapOf("phase" to "green", "may" to emptyList<Any>()) }
        val r1 = "npm i left-pad: Adding a package is a person's decision. (rule no-new-dependencies/no-install)"
        event(pid, "t-now", "guard.refused", null, """{"tool":"Bash","command":"npm i left-pad","phase":"green","reason":"$r1"}""")
        event(pid, "t-now", "guard.refused", null, """{"tool":"Bash","command":"npm i is-odd","phase":"green","reason":"$r1"}""")
        event(pid, "t-now", "guard.refused", null, """{"tool":"diff-guard","path":"a/B.kt","phase":"green","reason":"a/B.kt: editing api-test is blocked in phase \"green\"."}""")
        val out = get("/api/threads/t-now/rules-now").andExpect(status().isOk).json()
        assertThat(out["phase"].asText()).isEqualTo("green")
        val fired = out["fired"]
        assertThat(fired.size()).isEqualTo(2)
        val pack = fired.first { it["rule"]?.asText() == "no-new-dependencies/no-install" }
        assertThat(pack["count"].asInt()).isEqualTo(2)
        assertThat(pack["examples"].map { it.asText() }).containsExactly("npm i left-pad", "npm i is-odd")
        val diff = fired.first { it["source"].asText() == "after the step" }
        assertThat(diff["reason"].asText()).isEqualTo("Editing api-test is blocked in phase \"green\".")
        get("/api/threads/nope/rules-now").andExpect(status().isNotFound)
    }

    @Test
    fun `a rule change needs the admin MCP level, a check only read`() {
        val (pid, _) = newProject("rules-mcp")
        engine.extraRoutes["/rules/check"] = { _ -> 200 to mapOf("ok" to true) }
        val mcp = mapOf("X-Keel-Via" to "mcp", "X-Keel-Client" to "test", "X-Keel-Tool" to "t")
        post("/api/projects/$pid/rules/packs", mapOf("yaml" to "id: x\n"), mcp).andExpect(status().isForbidden)
        assertThat(post("/api/projects/$pid/rules/check", mapOf("yaml" to "id: x\n"), mcp).andReturn().response.status).isNotEqualTo(403)
    }

    @Test
    fun `group keys drop the file the reason names`() {
        assertThat(RulesService.groupKey("src/A.kt: editing api-main is blocked in phase \"red\".", "src/A.kt"))
            .isEqualTo("Editing api-main is blocked in phase \"red\".")
        assertThat(RulesService.ruleOf("x (rule a-b/c-d)")).isEqualTo("a-b/c-d")
    }
}
