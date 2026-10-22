package keel.api

import com.fasterxml.jackson.databind.JsonNode
import keel.api.agents.AgentNames
import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * The review agents' new names (keel.api.agents.AgentNames): the Agents page lists only the new names, and an old name
 * still reaches the new agent everywhere one is resolved: a project's agent override saved under it, PUT /agents/{old},
 * a workflow step, a skill assignment, and the V21 migration moves stored rows once (a new-name row wins).
 */
class AgentNamesApiTest : ApiTest() {
    @Autowired lateinit var jdbc: JdbcTemplate

    private fun agents(pid: String): List<JsonNode> = get("/api/projects/$pid/agents").json().toList()
    private fun agent(pid: String, aid: String): JsonNode = agents(pid).first { it["id"].asText() == aid }
    private fun model(name: String, effort: String? = null) =
        mapOf("provider" to "fake", "mode" to "api", "model" to name) + (effort?.let { mapOf("effort" to it) } ?: emptyMap())
    private fun saveOverride(pid: String, aid: String, json: String) =
        jdbc.update("INSERT INTO agent_overrides(project_id, agent_id, json) VALUES (?, ?, ?)", pid, aid, json)

    @Test
    fun `the agents list shows the new names only, and an old name still finds the agent`() {
        val (pid, _) = newProject("names-list")
        val ids = agents(pid).map { it["id"].asText() }
        assertThat(ids).contains("lens-reviewer").doesNotContainAnyElementsOf(AgentNames.OLD)
        val r = put("/api/projects/$pid/agents/reviewer", mapOf("enabled" to true)).andExpect(status().isOk).json()
        assertThat(r["id"].asText()).isEqualTo("lens-reviewer")
        // a custom agent cannot take an old name: it is keel's
        post("/api/projects/$pid/agents", mapOf("name" to "reviewer", "prompt" to "x")).andExpect(status().isConflict)
    }

    @Test
    fun `a project's override saved under an old name applies to the new agent, and the new name wins`() {
        val (pid, _) = newProject("names-override")
        saveOverride(pid, "reviewer", """{"model":{"provider":"fake","mode":"api","model":"old-name-model"},"prompt":"my own prompt"}""")
        val lens = agent(pid, "lens-reviewer")
        assertThat(lens["model"]["model"].asText()).isEqualTo("old-name-model")
        assertThat(lens["prompt"].asText()).isEqualTo("my own prompt")                 // the project's overridden agent text
        assertThat(lens["overridden"].map { it.asText() }).contains("model", "prompt")

        saveOverride(pid, "lens-reviewer", """{"model":{"provider":"fake","mode":"api","model":"new-name-model"}}""")
        assertThat(agent(pid, "lens-reviewer")["model"]["model"].asText()).isEqualTo("new-name-model")
    }

    @Test
    fun `PUT with an old name saves under the new one, keeps the old row's other fields and drops the old row`() {
        val (pid, _) = newProject("names-put")
        saveOverride(pid, "reviewer", """{"prompt":"kept"}""")
        val r = put("/api/projects/$pid/agents/reviewer", mapOf("model" to model("fake", "high"))).andExpect(status().isOk).json()
        assertThat(r["id"].asText()).isEqualTo("lens-reviewer")
        assertThat(r["model"]["effort"].asText()).isEqualTo("high")
        assertThat(r["prompt"].asText()).isEqualTo("kept")
        val rows = jdbc.queryForList("SELECT agent_id FROM agent_overrides WHERE project_id = ?", String::class.java, pid)
        assertThat(rows).containsExactly("lens-reviewer")
    }

    @Test
    fun `the reviewer model setting reaches the renamed reviewers, keel-wide and per project`() {
        val (pid, _) = newProject("names-settings")
        val before = get("/api/settings/general").json()["reviewer_model"]
        try {
            put("/api/settings/general", mapOf("reviewer_model" to model("keel-wide"))).andExpect(status().isOk)
            assertThat(agent(pid, "lens-reviewer")["model"]["model"].asText()).isEqualTo("keel-wide")
            assertThat(agent(pid, "explorer")["model"]["model"].asText()).isNotEqualTo("keel-wide")
            put("/api/projects/$pid/settings", mapOf("reviewer_model" to model("this-project"))).andExpect(status().isOk)
            assertThat(agent(pid, "lens-reviewer")["model"]["model"].asText()).isEqualTo("this-project")
        } finally {
            put("/api/settings/general", mapOf("reviewer_model" to mapper.convertValue(before, Map::class.java))).andExpect(status().isOk)
        }
    }

    @Test
    fun `a workflow step with an old name runs the new agent with that agent's model`() {
        val (pid, _) = newProject("names-flow")
        put("/api/projects/$pid/agents/reviewer", mapOf("model" to model("lens-model"))).andExpect(status().isOk)
        val yaml = """
            name: Old names
            keel_rules: false
            steps:
              - { id: look, kind: agent, name: look, agent: reviewer, model: default }
              - { id: lanes, kind: parallel, name: lanes, lanes: [{ name: one, sub: code-reviewer, kind: agent }] }
        """.trimIndent() + "\n"
        val imported = post("/api/projects/$pid/workflows/import", mapOf("yaml" to yaml)).andExpect(status().isOk).json()
        // (keel's test content has no branch-reviewer file; the review names it by its new name all the same)
        assertThat(imported["review"]["agents"].map { it.asText() }).containsExactly("lens-reviewer", "branch-reviewer")
        assertThat(imported["review"]["warnings"].map { it.asText() }.none { "code-reviewer" in it || "agents (add them as custom agents): reviewer" in it }).isTrue()
        val wid = imported["workflow"]["id"].asText()
        assertThat(imported["workflow"]["steps"][0]["agent"].asText()).isEqualTo("lens-reviewer")

        post("/api/projects/$pid/flows", mapOf("workflow_id" to wid, "title" to "Old names")).andExpect(status().isOk)
        val body = engine.lastBody("/threads")!!
        assertThat(body["workflow"]["steps"][0]["agent"].asText()).isEqualTo("lens-reviewer")
        assertThat(body["workflow"]["steps"][1]["lanes"][0]["sub"].asText()).isEqualTo("branch-reviewer")
        assertThat(body["models"]["lens-reviewer"]["model"].asText()).isEqualTo("lens-model")
        assertThat(AgentNames.OLD.none { body["models"].has(it) }).isTrue()
    }

    @Test
    fun `a skill put on an old name is on the new agent`() {
        val (pid, _) = newProject("names-skills")
        val s = put("/api/projects/$pid/skills/spec-writing", mapOf("agents" to listOf("reviewer", "lens-reviewer"))).andExpect(status().isOk).json()
        assertThat(s["agents"].map { it.asText() }).containsExactly("lens-reviewer")
        assertThat(agent(pid, "lens-reviewer")["skills"].map { it.asText() }).contains("spec-writing")
        // one saved before the rename (the old name in the stored list) reads as the new agent too
        jdbc.update("INSERT INTO skill_assign(project_id, skill_id, json) VALUES (?, ?, ?) ON CONFLICT(project_id, skill_id) DO UPDATE SET json = excluded.json",
            pid, "spec-clarify", """{"agents":["reviewer"]}""")
        assertThat(get("/api/skills/spec-clarify?project=$pid").json()["agents"].map { it.asText() }).containsExactly("lens-reviewer")
        assertThat(agent(pid, "lens-reviewer")["skills"].map { it.asText() }).contains("spec-clarify")
    }

    @Test
    fun `the V21 migration moves old-name rows once and a new-name row wins`() {
        val (pid, _) = newProject("names-migration")
        saveOverride(pid, "ac-reviewer", """{"prompt":"moved"}""")
        saveOverride(pid, "reviewer", """{"prompt":"old"}""")
        saveOverride(pid, "lens-reviewer", """{"prompt":"new"}""")
        jdbc.update("INSERT INTO skill_assign(project_id, skill_id, json) VALUES (?, ?, ?)", pid, "debugging", """{"agents":["code-reviewer","explorer"]}""")
        val sql = javaClass.getResource("/db/migration/V21__review_agent_names.sql")!!.readText()
        sql.lines().filterNot { it.trimStart().startsWith("--") }.joinToString("\n").split(";").map { it.trim() }.filter { it.isNotEmpty() }
            .forEach { jdbc.execute(it) }
        val rows = jdbc.query("SELECT agent_id, json FROM agent_overrides WHERE project_id = ? ORDER BY agent_id", { rs, _ ->
            rs.getString(1) to rs.getString(2) }, pid)
        assertThat(rows).containsExactly("criterion-reviewer" to """{"prompt":"moved"}""", "lens-reviewer" to """{"prompt":"new"}""")
        val assign = jdbc.queryForObject("SELECT json FROM skill_assign WHERE project_id = ? AND skill_id = 'debugging'", String::class.java, pid)
        assertThat(assign).isEqualTo("""{"agents":["branch-reviewer","explorer"]}""")
    }
}
