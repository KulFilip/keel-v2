package keel.api

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import java.util.concurrent.ConcurrentHashMap

/**
 * Rule packs in the marketplace, api side (docs/plugins/23-rules-in-marketplace.md §5), against the stub engine: the
 * catalog's packs with what this project has (the rules api's list), one pack with its verified file and keel's reading
 * (who enforces each rule), install through the rules api with source "marketplace" (its 409 and 422 as they are), an
 * update with replace, a fetch the engine refuses, and the MCP level.
 */
class MarketRulePacksApiTest : ApiTest() {
    private val yaml110 = "schema: 1\nkind: rules\nname: no-new-deps\ntitle: No new dependencies\nversion: 1.1.0\npublisher: keel\n" +
        "rules:\n  - id: no-install\n    kind: bash\n    match: [npm install]\n    reason: A person adds packages.\n"
    private val review = mapOf("rules" to 1, "kinds" to mapOf("bash" to 1), "phases" to listOf("all"), "lanes" to emptyList<String>(),
        "blocks" to listOf(mapOf("id" to "no-install", "kind" to "bash", "match" to listOf("npm install"), "how" to "contains", "phases" to "all")))

    private fun hit(name: String, title: String, version: String?, refused: Map<String, Any?>? = null) = mapOf(
        "name" to name, "kind" to "rules", "title" to title, "publisher" to "keel", "publisher_title" to "keel", "verified" to true,
        "version" to version, "summary" to "The $name pack.", "category" to "safety", "tags" to emptyList<String>(), "review" to review,
        "requires" to mapOf("keel" to ">=0.17.2"), "fits" to (version != null), "refused" to refused, "source" to "keel",
        "repo" to "", "latest" to (version ?: "1.0.0"), "old" to false, "why_not" to null, "trust" to "content")

    /** The project's installed packs as the engine's rules view keeps them (name → {version, source, edited?}). */
    private val packs = ConcurrentHashMap<String, Map<String, Any?>>()
    private var fetchRefusal: Pair<Int, Map<String, Any?>>? = null

    @BeforeEach
    fun routes() {
        packs.clear()
        fetchRefusal = null
        engine.extraRoutes["/marketplace/rule-packs"] = { _ ->
            200 to mapOf("rules" to listOf(hit("no-new-deps", "No new dependencies", "1.1.0"), hit("strict-git", "Strict git", "1.0.0"),
                hit("future", "Future", null, mapOf("error" to "No version of Future can be installed.", "hint" to "Update keel."))),
                "sources" to emptyList<Any>(), "categories" to listOf("safety", "code", "git", "files", "secrets", "other"))
        }
        engine.extraRoutes["/marketplace/rule-packs/no-new-deps"] = { _ ->
            200 to (hit("no-new-deps", "No new dependencies", "1.1.0") + mapOf("checks" to listOf("the file's signature matches a key of its publisher"),
                "versions" to listOf(mapOf("version" to "1.1.0"), mapOf("version" to "1.0.0"))))
        }
        engine.extraRoutes["/marketplace/rule-packs/future"] = { _ ->
            200 to (hit("future", "Future", null, mapOf("error" to "No version of Future can be installed.")) + mapOf("versions" to emptyList<Any>()))
        }
        engine.extraRoutes["/marketplace/rule-packs/no-new-deps/fetch"] = { b ->
            fetchRefusal ?: run {
                val v = b?.path("version")?.asText(null) ?: "1.1.0"
                200 to mapOf("name" to "no-new-deps", "version" to v, "title" to "No new dependencies", "publisher" to "keel", "catalog" to "keel",
                    "yaml" to yaml110.replace("1.1.0", v), "review" to review, "requires" to emptyMap<String, Any>(), "sha256" to "a".repeat(64))
            }
        }
        engine.extraRoutes["/rules/read"] = { b ->
            200 to mapOf("pack" to mapOf("name" to "no-new-deps", "version" to (b?.path("yaml")?.asText()?.substringAfter("version: ")?.substringBefore("\n"))),
                "rules" to listOf(mapOf("id" to "no-install", "kind" to "bash", "match" to listOf("npm install"), "how" to "contains", "phases" to "all",
                    "reason" to "A person adds packages.", "enforced" to mapOf("before" to listOf("claude", "api"), "after" to false,
                        "by" to listOf(mapOf("when" to "before", "who" to "hook", "label" to "keel's PreToolUse hook", "engines" to listOf("claude")))))),
                "engines" to listOf(mapOf("engine" to "claude", "title" to "Claude Code", "protection" to "before")),
                "enforcers" to listOf(mapOf("who" to "hook", "label" to "keel's PreToolUse hook")))
        }
        // the rules work's engine side: list, install (409 the same version / another version without replace), uninstall
        engine.extraRoutes["/rules/packs"] = { _ -> 200 to packs.entries.sortedBy { it.key }.map { (n, p) -> mapOf("name" to n) + p } }
        engine.extraRoutes["/rules/packs/install"] = { b ->
            val name = b!!.path("name").asText()
            val v = b.path("version").asText()
            val have = packs[name]
            when {
                b.path("yaml").asText().contains("rules: []") -> 422 to mapOf("error" to "The rule pack is not valid.", "hint" to "rules: a list with at least one rule")
                have != null && have["version"] == v && !b.path("replace").asBoolean() -> 409 to mapOf("error" to "$name $v is installed already.")
                have != null && !b.path("replace").asBoolean() ->
                    409 to mapOf("error" to "$name ${have["version"]} is installed; installing $v replaces it (replace).")
                else -> {
                    packs[name] = mapOf("version" to v, "source" to b.path("source").asText())
                    200 to mapOf("pack" to mapOf("name" to name, "version" to v, "source" to b.path("source").asText()),
                        "installed" to packs.map { (n, p) -> mapOf("name" to n) + p })
                }
            }
        }
    }

    @AfterEach
    fun after() {
        listOf("/marketplace/rule-packs", "/marketplace/rule-packs/no-new-deps", "/marketplace/rule-packs/future",
            "/marketplace/rule-packs/no-new-deps/fetch", "/rules/read", "/rules/packs", "/rules/packs/install").forEach { engine.extraRoutes.remove(it) }
    }

    @Test
    fun `search says what this project has installed and what has an update`() {
        val (pid, _) = newProject("mr-search")
        packs["no-new-deps"] = mapOf("version" to "1.0.0", "source" to "marketplace", "edited" to true)
        packs["strict-git"] = mapOf("version" to "1.0.0", "source" to "library")
        val found = get("/api/marketplace/rule-packs?q=deps&category=safety&project=$pid").andExpect(status().isOk).json()
        assertThat(engine.calls.last { it.path == "/marketplace/rule-packs" }.query).isEqualTo("q=deps&category=safety")
        val (deps, git, future) = found["rules"].toList()
        assertThat(deps["installed"]["version"].asText()).isEqualTo("1.0.0")
        assertThat(deps["installed"]["edited"].asBoolean()).isTrue()
        assertThat(deps["installed"]["source"].asText()).isEqualTo("marketplace")
        assertThat(deps["update"].asText()).isEqualTo("1.1.0")
        assertThat(git["installed"]["source"].asText()).isEqualTo("library")
        assertThat(git["update"].isNull).isTrue()
        assertThat(future["installed"].isNull).isTrue()
        assertThat(found["categories"].map { it.asText() }).contains("safety", "git")
        // without a project nothing is installed
        val none = get("/api/marketplace/rule-packs").json()
        assertThat(none["rules"].all { it["installed"].isNull && it["update"].isNull }).isTrue()
        get("/api/marketplace/rule-packs?project=nope").andExpect(status().isNotFound)
    }

    @Test
    fun `one pack has its verified file and keel's reading of each rule with who enforces it`() {
        val (pid, _) = newProject("mr-detail")
        val one = get("/api/marketplace/rule-packs/no-new-deps?project=$pid").andExpect(status().isOk).json()
        assertThat(engine.lastBody("/marketplace/rule-packs/no-new-deps/fetch")!!["version"].asText()).isEqualTo("1.1.0")
        assertThat(one["yaml"].asText()).isEqualTo(yaml110)
        assertThat(engine.lastBody("/rules/read")!!["yaml"].asText()).isEqualTo(yaml110)
        assertThat(one["fetch_error"].isNull).isTrue()
        assertThat(one["installed"].isNull).isTrue()
        val rule = one["rules"].single()
        assertThat(rule["kind"].asText()).isEqualTo("bash")
        assertThat(rule["enforced"]["before"].map { it.asText() }).containsExactly("claude", "api")
        assertThat(rule["enforced"]["after"].asBoolean()).isFalse()
        assertThat(one["engines"][0]["title"].asText()).isEqualTo("Claude Code")
        assertThat(one["enforcers"][0]["who"].asText()).isEqualTo("hook")
        assertThat(one["pack"]["version"].asText()).isEqualTo("1.1.0")
        assertThat(one["catalog_review"]["rules"].asInt()).isEqualTo(1)
        assertThat(one["checks"].size()).isEqualTo(1)

        // a pack keel would refuse is not fetched
        val before = engine.calls.count { it.path.endsWith("/fetch") }
        val future = get("/api/marketplace/rule-packs/future").andExpect(status().isOk).json()
        assertThat(future["yaml"].isNull).isTrue()
        assertThat(future["rules"].size()).isEqualTo(0)
        assertThat(engine.calls.count { it.path.endsWith("/fetch") }).isEqualTo(before)

        // a fetch the engine refuses (a bad signature): the page still opens and says why
        fetchRefusal = 502 to mapOf("error" to "The signature of no-new-deps 1.1.0 does not match its publisher's key: x.", "hint" to "keel installed nothing.")
        val bad = get("/api/marketplace/rule-packs/no-new-deps").andExpect(status().isOk).json()
        assertThat(bad["yaml"].isNull).isTrue()
        assertThat(bad["fetch_error"]["error"].asText()).startsWith("The signature of no-new-deps 1.1.0")
        get("/api/marketplace/rule-packs/Bad_Name").andExpect(status().isBadRequest)
    }

    @Test
    fun `install hands the verified file to the rules api with source marketplace, update asks for replace`() {
        val (pid, root) = newProject("mr-install")
        val done = post("/api/projects/$pid/rule-packs/market/install", mapOf("name" to "no-new-deps", "version" to "1.0.0"))
            .andExpect(status().isOk).json()
        val sent = engine.lastBody("/rules/packs/install")!!
        assertThat(sent["source"].asText()).isEqualTo("marketplace")
        assertThat(sent["name"].asText()).isEqualTo("no-new-deps")
        assertThat(sent["version"].asText()).isEqualTo("1.0.0")
        assertThat(sent["yaml"].asText()).contains("version: 1.0.0")
        assertThat(sent["replace"].asBoolean()).isFalse()
        assertThat(sent["root"].asText()).isEqualTo(root.toString())
        assertThat(done["pack"]["source"].asText()).isEqualTo("marketplace")
        assertThat(done["market"]["catalog"].asText()).isEqualTo("keel")
        assertThat(done["market"]["version"].asText()).isEqualTo("1.0.0")
        assertThat(get("/api/projects/$pid/rule-packs").json()[0]["source"].asText()).isEqualTo("marketplace")

        // the same version again, and an update without replace: the rules api's 409 as it gives it
        val again = post("/api/projects/$pid/rule-packs/market/install", mapOf("name" to "no-new-deps", "version" to "1.0.0"))
            .andExpect(status().isConflict).json()
        assertThat(again["error"].asText()).isEqualTo("no-new-deps 1.0.0 is installed already.")
        val upd = post("/api/projects/$pid/rule-packs/market/install", mapOf("name" to "no-new-deps")).andExpect(status().isConflict).json()
        assertThat(upd["error"].asText()).isEqualTo("no-new-deps 1.0.0 is installed; installing 1.1.0 replaces it (replace).")
        post("/api/projects/$pid/rule-packs/market/install", mapOf("name" to "no-new-deps", "replace" to true)).andExpect(status().isOk)
        assertThat(engine.lastBody("/rules/packs/install")!!["replace"].asBoolean()).isTrue()
        assertThat(packs["no-new-deps"]!!["version"]).isEqualTo("1.1.0")

        // a fetch the engine refuses installs nothing
        fetchRefusal = 502 to mapOf("error" to "The download of no-new-deps 1.1.0 does not match the catalog's sha256.", "hint" to "keel installed nothing.")
        val calls = engine.calls.count { it.path == "/rules/packs/install" }
        val bad = post("/api/projects/$pid/rule-packs/market/install", mapOf("name" to "no-new-deps", "replace" to true))
            .andExpect(status().isBadGateway).json()
        assertThat(bad["error"].asText()).contains("sha256")
        assertThat(engine.calls.count { it.path == "/rules/packs/install" }).isEqualTo(calls)
        post("/api/projects/$pid/rule-packs/market/install", mapOf("name" to "Bad Name")).andExpect(status().isBadRequest)
        post("/api/projects/nope/rule-packs/market/install", mapOf("name" to "no-new-deps")).andExpect(status().isNotFound)
    }

    @Test
    fun `a pack the rules api finds invalid keeps its 422, and install needs the admin MCP level`() {
        val (pid, _) = newProject("mr-invalid")
        engine.extraRoutes["/marketplace/rule-packs/no-new-deps/fetch"] = { _ ->
            200 to mapOf("name" to "no-new-deps", "version" to "1.0.0", "catalog" to "keel", "yaml" to "schema: 1\nrules: []\n", "review" to review)
        }
        val bad = post("/api/projects/$pid/rule-packs/market/install", mapOf("name" to "no-new-deps")).andExpect(status().isUnprocessableEntity).json()
        assertThat(bad["error"].asText()).isEqualTo("The rule pack is not valid.")
        assertThat(bad["hint"].asText()).isEqualTo("rules: a list with at least one rule")
        val mcp = mapOf("X-Keel-Via" to "mcp", "X-Keel-Client" to "test", "X-Keel-Tool" to "t")
        post("/api/projects/$pid/rule-packs/market/install", mapOf("name" to "no-new-deps"), mcp).andExpect(status().isForbidden)
    }
}
