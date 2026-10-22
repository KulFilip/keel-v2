package keel.api

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * Skills in the marketplace, api side (keel 0.18.6), against the stub engine: the catalog's skills with what this project
 * has, keel's own skills next to them (builtin), one skill with its verified text, install with agents, the 409s, an
 * update with replace (an edited copy says so), remove, a catalog that does not answer, and the MCP levels.
 */
class MarketSkillsApiTest : ApiTest() {
    private fun text(v: String) = "---\nname: changelog\ndescription: How to write a changelog entry.\nversion: $v\n---\n# Changelog\n\n## When\nAt the end.\n"
    private val review = mapOf("tokens" to 22, "sections" to listOf("When"), "description" to "How to write a changelog entry.")

    private fun hit(name: String, version: String?) = mapOf(
        "name" to name, "kind" to "skills", "title" to "Changelog", "publisher" to "keel", "publisher_title" to "keel", "verified" to true,
        "version" to version, "summary" to "Changelog entries.", "category" to "authoring", "tags" to emptyList<String>(), "review" to review,
        "requires" to emptyMap<String, Any>(), "fits" to (version != null), "refused" to null, "source" to "keel", "repo" to "",
        "latest" to (version ?: "1.0.0"), "old" to false, "why_not" to null, "trust" to "content")

    private var fetchRefusal: Pair<Int, Map<String, Any?>>? = null
    private var searchRefusal: Pair<Int, Map<String, Any?>>? = null

    @BeforeEach
    fun routes() {
        fetchRefusal = null
        searchRefusal = null
        engine.extraRoutes["/marketplace/skills"] = { _ ->
            searchRefusal ?: (200 to mapOf("skills" to listOf(hit("changelog", "1.1.0")), "sources" to emptyList<Any>(),
                "categories" to listOf("testing", "implementation", "review", "debugging", "knowledge", "authoring", "other")))
        }
        engine.extraRoutes["/marketplace/skills/changelog"] = { _ -> 200 to (hit("changelog", "1.1.0") + mapOf("versions" to emptyList<Any>(), "checks" to listOf("x"))) }
        engine.extraRoutes["/marketplace/skills/spec-clarify"] = { _ -> 404 to mapOf("error" to "There is no skill spec-clarify in the catalogs keel reads.") }
        engine.extraRoutes["/marketplace/skills/changelog/fetch"] = { b ->
            fetchRefusal ?: run {
                val v = b?.path("version")?.asText(null) ?: "1.1.0"
                200 to mapOf("name" to "changelog", "version" to v, "title" to "Changelog", "publisher" to "keel", "catalog" to "keel",
                    "text" to text(v), "review" to review, "requires" to emptyMap<String, Any>(), "sha256" to "a".repeat(64))
            }
        }
    }

    @AfterEach
    fun after() {
        listOf("/marketplace/skills", "/marketplace/skills/changelog", "/marketplace/skills/spec-clarify", "/marketplace/skills/changelog/fetch")
            .forEach { engine.extraRoutes.remove(it) }
    }

    @Test
    fun `search lists the catalog's skills and keel's own, with what this project has`() {
        val (pid, _) = newProject("ms-search")
        val found = get("/api/marketplace/skills?q=&project=$pid").andExpect(status().isOk).json()
        val one = found["skills"].single()
        assertThat(one["installed"].isNull).isTrue()
        assertThat(found["catalog_error"].isNull).isTrue()
        val builtin = found["builtin"].associateBy { it["name"].asText() }
        assertThat(builtin.keys).contains("spec-clarify", "kotlin-spring-testing")
        assertThat(builtin.getValue("spec-clarify")["agents"].map { it.asText() }).containsExactly("explorer")
        assertThat(builtin.getValue("spec-clarify")["category"].asText()).isEqualTo("authoring")
        assertThat(builtin.getValue("spec-clarify")["builtin"].asBoolean()).isTrue()
        // keel's own are searched by words and by category
        assertThat(get("/api/marketplace/skills?q=testing").json()["builtin"].map { it["name"].asText() })
            .containsExactlyInAnyOrder("kotlin-spring-testing", "django-testing")
        assertThat(get("/api/marketplace/skills?category=authoring").json()["builtin"].map { it["name"].asText() })
            .containsExactlyInAnyOrder("spec-clarify", "spec-writing")
        // no catalog answers: keel's own are still listed
        searchRefusal = 503 to mapOf("error" to "keel's engine does not answer.")
        val down = get("/api/marketplace/skills").andExpect(status().isOk).json()
        assertThat(down["skills"].size()).isEqualTo(0)
        assertThat(down["catalog_error"]["error"].asText()).isEqualTo("keel's engine does not answer.")
        assertThat(down["builtin"].size()).isGreaterThan(0)
        get("/api/marketplace/skills?project=nope").andExpect(status().isNotFound)
    }

    @Test
    fun `one skill has its verified text, and keel's own opens as builtin`() {
        val (pid, _) = newProject("ms-detail")
        val one = get("/api/marketplace/skills/changelog?project=$pid").andExpect(status().isOk).json()
        assertThat(one["text"].asText()).isEqualTo(text("1.1.0"))
        assertThat(one["builtin"].asBoolean()).isFalse()
        assertThat(one["catalog_review"]["sections"][0].asText()).isEqualTo("When")
        assertThat(one["fetch_error"].isNull).isTrue()
        fetchRefusal = 502 to mapOf("error" to "The signature of changelog 1.1.0 does not match its publisher's key: x.", "hint" to "keel installed nothing.")
        val bad = get("/api/marketplace/skills/changelog").andExpect(status().isOk).json()
        assertThat(bad["text"].isNull).isTrue()
        assertThat(bad["fetch_error"]["error"].asText()).startsWith("The signature of changelog")

        val mine = get("/api/marketplace/skills/spec-clarify?project=$pid").andExpect(status().isOk).json()
        assertThat(mine["builtin"].asBoolean()).isTrue()
        assertThat(mine["text"].asText()).contains("keel-questions")
        assertThat(mine["agents"].map { it.asText() }).containsExactly("explorer")
        assertThat(mine["review"]["tokens"].asInt()).isGreaterThan(0)
        assertThat(mine["review"]["description"].asText()).isNotBlank()
        get("/api/marketplace/skills/Bad_Name").andExpect(status().isBadRequest)
    }

    @Test
    fun `install saves the verified text for the agents, update needs replace, remove takes it away`() {
        val (pid, _) = newProject("ms-install")
        // "reviewer" is the lens-reviewer's old name: the skill goes on the lens-reviewer
        val done = post("/api/projects/$pid/skills/market/install", mapOf("name" to "changelog", "version" to "1.0.0", "agents" to listOf("reviewer")))
            .andExpect(status().isOk).json()
        assertThat(engine.lastBody("/marketplace/skills/changelog/fetch")!!["version"].asText()).isEqualTo("1.0.0")
        val sid = done["skill"]["id"].asText()
        assertThat(sid).isEqualTo("changelog")
        assertThat(done["skill"]["source"].asText()).isEqualTo("marketplace")
        assertThat(done["skill"]["version"].asText()).isEqualTo("1.0.0")
        assertThat(done["skill"]["agents"].map { it.asText() }).containsExactly("lens-reviewer")
        assertThat(done["skill"]["market"]["catalog"].asText()).isEqualTo("keel")
        assertThat(done["market"]["version"].asText()).isEqualTo("1.0.0")
        // the project's skills list it, the reviewer agent loads it, the search says installed + update
        val listed = get("/api/projects/$pid/skills").json().first { it["id"].asText() == sid }
        assertThat(listed["market"]["edited"].asBoolean()).isFalse()
        assertThat(get("/api/projects/$pid/agents").json().first { it["id"].asText() == "lens-reviewer" }["skills"].map { it.asText() }).contains(sid)
        val hit = get("/api/marketplace/skills?project=$pid").json()["skills"].single()
        assertThat(hit["installed"]["version"].asText()).isEqualTo("1.0.0")
        assertThat(hit["installed"]["sid"].asText()).isEqualTo(sid)
        assertThat(hit["update"].asText()).isEqualTo("1.1.0")

        // the same version again, another without replace
        val again = post("/api/projects/$pid/skills/market/install", mapOf("name" to "changelog", "version" to "1.0.0")).andExpect(status().isConflict).json()
        assertThat(again["error"].asText()).isEqualTo("changelog 1.0.0 is installed already.")
        // the person changes the copy: an update says so, replace takes the new version and keeps the agents
        put("/api/projects/$pid/skills/$sid", mapOf("body" to text("1.0.0") + "\nMine.\n")).andExpect(status().isOk)
        val upd = post("/api/projects/$pid/skills/market/install", mapOf("name" to "changelog")).andExpect(status().isConflict).json()
        assertThat(upd["error"].asText()).isEqualTo("changelog 1.0.0 is installed; installing 1.1.0 replaces it (replace).")
        assertThat(upd["installed"]["edited"].asBoolean()).isTrue()
        val replaced = post("/api/projects/$pid/skills/market/install", mapOf("name" to "changelog", "replace" to true)).andExpect(status().isOk).json()
        assertThat(replaced["skill"]["version"].asText()).isEqualTo("1.1.0")
        assertThat(replaced["skill"]["agents"].map { it.asText() }).containsExactly("lens-reviewer")
        assertThat(get("/api/skills/$sid?project=$pid").json()["body"].asText()).isEqualTo(text("1.1.0"))

        // a fetch the engine refuses installs nothing
        fetchRefusal = 409 to mapOf("error" to "keel's review of Changelog 1.1.0 is not the catalog's.")
        post("/api/projects/$pid/skills/market/install", mapOf("name" to "changelog", "replace" to true)).andExpect(status().isConflict)

        // remove: gone from the list and from the search; keel's own cannot be removed
        delete("/api/projects/$pid/skills/$sid").andExpect(status().isOk)
        assertThat(get("/api/projects/$pid/skills").json().none { it["id"].asText() == sid }).isTrue()
        assertThat(get("/api/marketplace/skills?project=$pid").json()["skills"].single()["installed"].isNull).isTrue()
        delete("/api/projects/$pid/skills/spec-clarify").andExpect(status().isConflict)
        delete("/api/projects/$pid/skills/nothing").andExpect(status().isNotFound)
        post("/api/projects/$pid/skills/market/install", mapOf("name" to "Bad Name")).andExpect(status().isBadRequest)
        post("/api/projects/nope/skills/market/install", mapOf("name" to "changelog")).andExpect(status().isNotFound)
    }

    @Test
    fun `a read MCP token stays read only for skills`() {
        val (pid, _) = newProject("ms-mcp")
        val mcp = mapOf("X-Keel-Via" to "mcp", "X-Keel-Client" to "test", "X-Keel-Tool" to "t")
        post("/api/projects/$pid/skills/market/install", mapOf("name" to "changelog"), mcp).andExpect(status().isForbidden)
        post("/api/projects/$pid/skills/import", mapOf("body" to text("1.0.0")), mcp).andExpect(status().isForbidden)
        post("/api/projects/$pid/skills", mapOf("name" to "x", "body" to "y"), mcp).andExpect(status().isForbidden)
        assertThat(get("/api/projects/$pid/skills").andExpect(status().isOk).json().size()).isGreaterThan(0)
    }
}
