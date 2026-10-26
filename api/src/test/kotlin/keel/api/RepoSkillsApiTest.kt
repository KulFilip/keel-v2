package keel.api

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * keel 0.18.57 the skills a repo keeps for coding agents (.claude/skills, .opencode/skills): init and knowledge-refresh
 * record them in .keel/project-rules.json (engine runtime/project_rules.py) with the agents each one is for; the Skill hub
 * lists them as "repo" skills, the flows load them for those agents, and Skills › Found in the repo can turn them off.
 */
class RepoSkillsApiTest : ApiTest() {
    @org.springframework.beans.factory.annotation.Autowired lateinit var flows: keel.api.flow.FlowService

    private val record = """
        {"version": 1, "found_at": "2026-10-26T10:00:00Z",
         "docs": [{"path": "AGENTS.md", "title": "Agent guide for shop"}],
         "skills": [
          {"name": "shop-fixtures", "path": ".claude/skills/shop-fixtures/SKILL.md", "about": "How shop builds its test data.",
           "use": "tests", "why": "AGENTS.md: \"Load the skill shop-fixtures when writing tests.\"", "agents": ["test-author", "implementer"]},
          {"name": "shop-glossary", "path": ".opencode/skills/shop-glossary/SKILL.md", "about": "The words the shop team uses.",
           "use": null, "why": "", "agents": []},
          {"name": "spec-writing", "path": ".claude/skills/spec-writing/SKILL.md", "about": "Our own spec rules.",
           "use": null, "why": "", "agents": []},
          {"name": "escape", "path": "../outside/SKILL.md", "about": "", "use": "tests", "why": "", "agents": ["implementer"]}
         ]}
    """.trimIndent()

    private fun shop(name: String) = newProject(name, mapOf(
        "README.md" to "# shop\n",
        "AGENTS.md" to "# Agent guide for shop\n\nLoad the skill shop-fixtures when writing tests.\n",
        ".claude/skills/shop-fixtures/SKILL.md" to "---\nname: shop-fixtures\ndescription: How shop builds its test data.\n---\n\n# Fixtures\n- Build orders with OrderFactory.\n",
        ".opencode/skills/shop-glossary/SKILL.md" to "---\nname: shop-glossary\ndescription: The words the shop team uses.\n---\n\n# Words\n- A basket is a cart.\n",
        ".claude/skills/spec-writing/SKILL.md" to "---\nname: spec-writing\ndescription: Our own spec rules.\n---\n\n# Ours\n",
        ".keel/project-rules.json" to record,
    ))

    @Test
    fun `the repo's skills are listed, loaded for the agents they are for, and read from the repo`() {
        val (pid, root) = shop("repo-skills")
        val byId = get("/api/projects/$pid/skills").andExpect(status().isOk).json().associateBy { it["id"].asText() }
        val fixtures = byId.getValue("shop-fixtures")
        assertThat(fixtures["source"].asText()).isEqualTo("repo")
        assertThat(fixtures["kind"].asText()).isEqualTo("testing")
        assertThat(fixtures["agents"].map { it.asText() }).containsExactly("test-author", "implementer")
        assertThat(fixtures["when"].asText()).isEqualTo("tests")
        assertThat(fixtures["about"].asText()).isEqualTo("How shop builds its test data.")
        assertThat(byId.getValue("shop-glossary")["agents"].map { it.asText() }).isEmpty()
        // a name keel already has gets its own id; a path out of the project is not read
        assertThat(byId.getValue("spec-writing-repo")["source"].asText()).isEqualTo("repo")
        assertThat(byId.getValue("spec-writing")["source"].asText()).isEqualTo("keel")
        assertThat(byId.keys).doesNotContain("escape")

        val detail = get("/api/skills/shop-fixtures?project=$pid").andExpect(status().isOk).json()
        assertThat(detail["body"].asText()).contains("Build orders with OrderFactory.")
        // the body is the repo's file as it is now
        java.nio.file.Files.writeString(root.resolve(".claude/skills/shop-fixtures/SKILL.md"),
            "---\nname: shop-fixtures\ndescription: How shop builds its test data.\n---\n\n# Fixtures\n- Use OrderFactory::paid().\n")
        val start = flows.buildStart(pid, "feature", "x", null)
        assertThat(start.skills["test-author"]).contains("Use OrderFactory::paid().")
        assertThat(start.skills["implementer"]).contains("Use OrderFactory::paid().")
        assertThat(start.skills.values.joinToString()).doesNotContain("A basket is a cart.")
    }

    @Test
    fun `Found in the repo says what was found and who loads it, and turns them off and on`() {
        val (pid, _) = shop("repo-skills-switch")
        val found = get("/api/projects/$pid/skills/repo").andExpect(status().isOk).json()
        assertThat(found["on"].asBoolean()).isTrue()
        assertThat(found["found_at"].asText()).isEqualTo("2026-10-26T10:00:00Z")
        assertThat(found["docs"].map { it["path"].asText() }).containsExactly("AGENTS.md")
        assertThat(found["skills"].map { it["id"].asText() }).containsExactly("shop-fixtures", "shop-glossary", "spec-writing-repo")
        assertThat(found["skills"][0]["path"].asText()).isEqualTo(".claude/skills/shop-fixtures/SKILL.md")
        assertThat(found["skills"][0]["why"].asText()).startsWith("AGENTS.md:")
        assertThat(found["attached"].map { it.asText() }).containsExactly("test-author", "implementer")

        val off = put("/api/projects/$pid/skills/repo", mapOf("on" to false)).andExpect(status().isOk).json()
        assertThat(off["on"].asBoolean()).isFalse()
        assertThat(off["skills"].size()).isEqualTo(3)                        // still shown: found, not loaded
        assertThat(off["attached"].size()).isEqualTo(0)
        assertThat(get("/api/projects/$pid/skills").json().map { it["id"].asText() }).doesNotContain("shop-fixtures")
        assertThat(flows.buildStart(pid, "feature", "x", null).skills.values.joinToString()).doesNotContain("OrderFactory")
        assertThat(get("/api/projects/$pid/settings").json()["overrides"]["repo_skills"].asBoolean()).isFalse()

        put("/api/projects/$pid/skills/repo", mapOf("on" to true)).andExpect(status().isOk)
        assertThat(get("/api/projects/$pid/skills").json().map { it["id"].asText() }).contains("shop-fixtures")
    }

    @Test
    fun `a repo skill takes other agents here, but is changed and removed in the repo`() {
        val (pid, _) = shop("repo-skills-edit")
        val moved = put("/api/projects/$pid/skills/shop-glossary", mapOf("agents" to listOf("explorer"))).andExpect(status().isOk).json()
        assertThat(moved["agents"].map { it.asText() }).containsExactly("explorer")
        assertThat(get("/api/projects/$pid/skills/repo").json()["attached"].map { it.asText() })
            .containsExactly("test-author", "implementer", "explorer")
        put("/api/projects/$pid/skills/shop-fixtures", mapOf("body" to "x")).andExpect(status().isConflict)
        delete("/api/projects/$pid/skills/shop-fixtures").andExpect(status().isConflict)
    }

    @Test
    fun `a project with no record has no repo skills`() {
        val (pid, _) = newProject("repo-skills-none")
        val found = get("/api/projects/$pid/skills/repo").andExpect(status().isOk).json()
        assertThat(found["skills"].size()).isEqualTo(0)
        assertThat(found["found_at"].isNull).isTrue()
        assertThat(get("/api/projects/$pid/skills").json().map { it["source"].asText() }).doesNotContain("repo")
    }
}
