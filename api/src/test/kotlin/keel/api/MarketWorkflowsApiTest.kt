package keel.api

import com.fasterxml.jackson.databind.JsonNode
import keel.api.support.ApiTest
import keel.api.workflows.MarketVersions
import keel.api.workflows.MarketWorkflows
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import java.io.ByteArrayInputStream
import java.util.zip.ZipInputStream

/**
 * The workflow marketplace's api (docs/plugins/21-workflow-marketplace.md §9) against the stub engine's catalog: search
 * and one workflow with installed/update, install into a project or all projects, the needs refusals, a review that is
 * not the catalog's, update (unchanged, keep, replace), the market field only on marketplace rows, remove, publish.
 */
class MarketWorkflowsApiTest : ApiTest() {
    @Autowired lateinit var jdbc: JdbcTemplate

    @BeforeEach
    fun clean() {
        engine.market.reset()
        jdbc.update("DELETE FROM workflow_versions WHERE workflow_id IN (SELECT id FROM workflows WHERE market_name IS NOT NULL OR project_id IS NULL)")
        jdbc.update("DELETE FROM workflows WHERE market_name IS NOT NULL OR project_id IS NULL")
    }

    @AfterEach
    fun after() = engine.market.reset()

    private fun install(pid: String, name: String, scope: String = "project", version: String? = null) =
        post("/api/projects/$pid/workflows/market/install", mapOf("name" to name, "scope" to scope, "version" to version))

    private fun listed(pid: String, wid: String): JsonNode = get("/api/projects/$pid/workflows").json().first { it["id"].asText() == wid }

    // ---------- find and read

    @Test
    fun `search and one workflow say what this project has, and the page gets the yaml, the steps and keel's review`() {
        val (pid, _) = newProject("mw-search")
        val found = get("/api/marketplace/workflows?q=release&project=$pid").andExpect(status().isOk).json()
        assertThat(found["categories"].map { it.asText() }).contains("docs", "quality")
        val hit = found["workflows"].single()
        assertThat(hit["name"].asText()).isEqualTo("release-notes")
        assertThat(hit["kind"].asText()).isEqualTo("workflow")
        assertThat(hit["installed"].isNull).isTrue()
        assertThat(hit["update"].isNull).isTrue()
        assertThat(engine.calls.last { it.path == "/marketplace/workflows" }.query).isEqualTo("q=release&category=")
        assertThat(get("/api/marketplace/workflows?category=quality").json()["workflows"].map { it["name"].asText() }).containsExactly("runs-tests")
        get("/api/marketplace/workflows?project=nope").andExpect(status().isNotFound)

        val one = get("/api/marketplace/workflows/release-notes?project=$pid").andExpect(status().isOk).json()
        assertThat(one["version"].asText()).isEqualTo("1.3.0")
        assertThat(one["versions"].map { it["version"].asText() }).containsExactly("1.3.0", "1.2.0")
        assertThat(one["yaml"].asText()).contains("look around (1.3.0)")
        assertThat(one["steps"].map { it["id"].asText() }).containsExactly("look", "check")
        assertThat(one["steps"][0]["agent"].asText()).isEqualTo("explorer")
        assertThat(one["steps"][1]["kind"].asText()).isEqualTo("gate")
        // keel's own Install review (more than the catalog's: valid, warnings); the catalog's stays as catalog_review
        assertThat(one["review"]["agents"].map { it.asText() }).containsExactly("explorer")
        assertThat(one["review"]["edits_files"].asBoolean()).isFalse()
        assertThat(one["review"].has("warnings")).isTrue()
        assertThat(one["review"]["est_tokens"].asInt()).isEqualTo(0)
        // GET /api/marketplace/workflows is this list, never the page of a plugin called "workflows"
        assertThat(engine.calls.none { it.path == "/marketplace/plugins/workflows" }).isTrue()
        assertThat(one["catalog_review"]["steps"].asInt()).isEqualTo(2)
        assertThat(one["installed"].isNull).isTrue()
        assertThat(engine.lastBody("/marketplace/workflows/release-notes/fetch")!!["version"].asText()).isEqualTo("1.3.0")

        // a workflow that needs a plugin keel does not run still shows its yaml (only an install refuses it)
        val needs = get("/api/marketplace/workflows/needs-db").andExpect(status().isOk).json()
        assertThat(needs["yaml"].asText()).contains("Needs a database")
        assertThat(needs["missing_plugins"].map { it.asText() }).containsExactly("db")
        // a workflow keel would refuse (an old catalog): no yaml, no steps, and why
        val old = get("/api/marketplace/workflows/old-one").andExpect(status().isOk).json()
        assertThat(old["yaml"].isNull).isTrue()
        assertThat(old["steps"].size()).isEqualTo(0)
        assertThat(old["refused"]["error"].asText()).contains("is old")
        // keel's review is not the catalog's: refused
        val liar = get("/api/marketplace/workflows/liar").andExpect(status().isConflict).json()
        assertThat(liar["error"].asText()).isEqualTo("keel's review of Says less than it does 1.0.0 is not the catalog's.")
        assertThat(liar["differences"].map { it.asText() }).containsExactly(
            "commands: keel finds rm -rf build, the catalog says none",
            "edits files: keel finds it changes files, the catalog says it does not")
        assertThat(liar["review"]["commands"].map { it.asText() }).containsExactly("rm -rf build")
        get("/api/marketplace/workflows/nope").andExpect(status().isNotFound)
        get("/api/marketplace/workflows/Not_A_Name").andExpect(status().isBadRequest)
        // a refused download or check keeps the engine's status and words
        engine.market.refusals["fetch:release-notes"] = 502 to mapOf("error" to "The signature of release-notes 1.3.0 does not match its publisher's key.",
            "hint" to "keel installed nothing.")
        val bad = get("/api/marketplace/workflows/release-notes").andExpect(status().isBadGateway).json()
        assertThat(bad["error"].asText()).contains("does not match its publisher's key")
    }

    // ---------- install

    @Test
    fun `install into this project, then into all projects, and the same name again in the same scope is refused`() {
        val (pid, _) = newProject("mw-install")
        val (other, _) = newProject("mw-install-other")
        val res = install(pid, "release-notes").andExpect(status().isOk).json()
        val wf = res["workflow"]
        val wid = wf["id"].asText()
        assertThat(wf["source"].asText()).isEqualTo("marketplace")
        assertThat(wf["name"].asText()).isEqualTo("Release notes")
        assertThat(wf["market"]["catalog"].asText()).isEqualTo("keel")
        assertThat(wf["market"]["name"].asText()).isEqualTo("release-notes")
        assertThat(wf["market"]["version"].asText()).isEqualTo("1.3.0")
        assertThat(wf["market"].has("update")).isTrue()
        assertThat(wf["market"]["update"].isNull).isTrue()
        assertThat(res["review"]["steps"].asInt()).isEqualTo(2)
        assertThat(res["review"]["source"].asText()).isEqualTo("marketplace")
        assertThat(engine.calls.any { it.path == "/workflows/validate" && it.body!!["yaml"].asText().contains("look around (1.3.0)") }).isTrue()

        val mine = listed(pid, wid)
        assertThat(mine["market"]["version"].asText()).isEqualTo("1.3.0")
        assertThat(mine["yaml"].asText()).contains("look around (1.3.0)")
        assertThat(get("/api/projects/$other/workflows").json().none { it["id"].asText() == wid }).isTrue()
        val hit = get("/api/marketplace/workflows?q=release&project=$pid").json()["workflows"].single()
        assertThat(hit["installed"]["version"].asText()).isEqualTo("1.3.0")
        assertThat(hit["installed"]["scope"].asText()).isEqualTo("project")
        assertThat(hit["installed"]["wid"].asText()).isEqualTo(wid)
        assertThat(get("/api/marketplace/workflows?q=release&project=$other").json()["workflows"].single()["installed"].isNull).isTrue()

        val again = install(pid, "release-notes").andExpect(status().isConflict).json()
        assertThat(again["error"].asText()).isEqualTo("release-notes 1.3.0 is installed already in this project.")
        assertThat(again["installed"]["wid"].asText()).isEqualTo(wid)

        val all = install(pid, "release-notes", scope = "all").andExpect(status().isOk).json()["workflow"]
        assertThat(all["id"].asText()).isEqualTo("mkt-release-notes")
        assertThat(listed(other, "mkt-release-notes")["market"]["name"].asText()).isEqualTo("release-notes")
        val elsewhere = get("/api/marketplace/workflows/release-notes?project=$other").json()
        assertThat(elsewhere["installed"]["scope"].asText()).isEqualTo("all")
        assertThat(get("/api/marketplace/workflows?q=release").json()["workflows"].single()["installed"]["scope"].asText()).isEqualTo("all")
        install(other, "release-notes", scope = "all").andExpect(status().isConflict)
        // this project sees its own copy first
        assertThat(get("/api/marketplace/workflows/release-notes?project=$pid").json()["installed"]["wid"].asText()).isEqualTo(wid)

        install(pid, "release-notes", scope = "nowhere").andExpect(status().isBadRequest)
        install("nope", "release-notes").andExpect(status().isNotFound)
        install(pid, "Bad Name").andExpect(status().isBadRequest)
        install(pid, "nope").andExpect(status().isNotFound)

        // remove: the existing Delete; the search says it is gone
        delete("/api/workflows/$wid").andExpect(status().isOk)
        assertThat(get("/api/marketplace/workflows?q=release&project=$pid").json()["workflows"].single()["installed"]["scope"].asText()).isEqualTo("all")
        delete("/api/workflows/mkt-release-notes").andExpect(status().isOk)
        assertThat(get("/api/marketplace/workflows?q=release&project=$pid").json()["workflows"].single()["installed"].isNull).isTrue()
    }

    @Test
    fun `an install is refused when a plugin or an agent it needs is missing, or when keel's review is not the catalog's`() {
        val (pid, _) = newProject("mw-needs")
        val before = jdbc.queryForObject("SELECT COUNT(*) FROM workflows", Int::class.java)
        val plugin = install(pid, "needs-db").andExpect(status().isConflict).json()
        assertThat(plugin["error"].asText()).isEqualTo("Needs a database needs db, which this keel does not run.")
        assertThat(plugin["missing_plugins"].map { it.asText() }).containsExactly("db")
        val agent = install(pid, "needs-agent").andExpect(status().isConflict).json()
        assertThat(agent["error"].asText()).isEqualTo("Needs an agent needs agents keel does not have: release-writer.")
        assertThat(agent["missing_agents"].map { it.asText() }).containsExactly("release-writer")
        val liar = install(pid, "liar").andExpect(status().isConflict).json()
        assertThat(liar["differences"].size()).isEqualTo(2)
        assertThat(liar["catalog_review"]["commands"].size()).isEqualTo(0)
        install(pid, "old-one").andExpect(status().isConflict)
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM workflows", Int::class.java)).isEqualTo(before)
        // a workflow that runs a command and says so installs; its review shows the command
        val runs = install(pid, "runs-tests").andExpect(status().isOk).json()
        assertThat(runs["review"]["commands"].map { it.asText() }).containsExactly("make test")
        assertThat(runs["review"]["warnings"].map { it.asText() }).contains("It runs 1 shell command(s) in your repo.")
    }

    // ---------- update

    @Test
    fun `an unchanged copy gets the new version in the same row, and the list says an update is ready`() {
        val (pid, _) = newProject("mw-update")
        engine.market.workflowNewest["release-notes"] = "1.2.0"
        val wid = install(pid, "release-notes").andExpect(status().isOk).json()["workflow"]["id"].asText()
        assertThat(listed(pid, wid)["market"]["update"].isNull).isTrue()
        engine.market.workflowNewest.clear()                                        // 1.3.0 is out
        assertThat(listed(pid, wid)["market"]["update"].asText()).isEqualTo("1.3.0")
        val hit = get("/api/marketplace/workflows?q=release&project=$pid").json()["workflows"].single()
        assertThat(hit["update"].asText()).isEqualTo("1.3.0")
        assertThat(hit["installed"]["version"].asText()).isEqualTo("1.2.0")

        val res = post("/api/projects/$pid/workflows/market/$wid/update", mapOf("mode" to "keep")).andExpect(status().isOk).json()
        assertThat(res["kept"].isNull).isTrue()
        assertThat(res["workflow"]["id"].asText()).isEqualTo(wid)
        assertThat(res["workflow"]["version"].asInt()).isEqualTo(2)
        assertThat(res["workflow"]["market"]["version"].asText()).isEqualTo("1.3.0")
        assertThat(res["workflow"]["yaml"].asText()).contains("look around (1.3.0)")
        assertThat(listed(pid, wid)["market"]["update"].isNull).isTrue()
        // the old version stays (Roll back)
        assertThat(jdbc.queryForList("SELECT yaml FROM workflow_versions WHERE workflow_id = ? ORDER BY version", String::class.java, wid)
            .map { it.contains("(1.2.0)") }).containsExactly(true, false)

        val same = post("/api/projects/$pid/workflows/market/$wid/update", null).andExpect(status().isConflict).json()
        assertThat(same["error"].asText()).isEqualTo("release-notes 1.3.0 is installed already.")
        post("/api/projects/$pid/workflows/market/$wid/update", mapOf("mode" to "merge")).andExpect(status().isBadRequest)
        post("/api/projects/$pid/workflows/market/nope/update", null).andExpect(status().isNotFound)
        val mineId = post("/api/projects/$pid/workflows", mapOf("name" to "Mine", "from" to "blank")).json()["id"].asText()
        post("/api/projects/$pid/workflows/market/$mineId/update", null).andExpect(status().isConflict)
        // an explicit older version is a change too (back to 1.2.0)
        val back = post("/api/projects/$pid/workflows/market/$wid/update", mapOf("version" to "1.2.0", "mode" to "replace")).andExpect(status().isOk).json()
        assertThat(back["workflow"]["market"]["version"].asText()).isEqualTo("1.2.0")
    }

    @Test
    fun `a changed copy is kept as the person's own with keep, or replaced with replace`() {
        val (pid, _) = newProject("mw-changed")
        engine.market.workflowNewest["release-notes"] = "1.2.0"
        val wid = install(pid, "release-notes").json()["workflow"]["id"].asText()
        val edited = listed(pid, wid)["yaml"].asText().replace("check it", "check it twice")
        put("/api/workflows/$wid", mapOf("yaml" to edited)).andExpect(status().isOk)
        engine.market.workflowNewest.clear()

        val kept = post("/api/projects/$pid/workflows/market/$wid/update", mapOf("mode" to "keep")).andExpect(status().isOk).json()
        assertThat(kept["kept"].asText()).isEqualTo(wid)
        val copy = kept["workflow"]
        assertThat(copy["id"].asText()).isNotEqualTo(wid)
        assertThat(copy["name"].asText()).isEqualTo("Release notes 1.3.0")
        assertThat(copy["market"]["version"].asText()).isEqualTo("1.3.0")
        assertThat(copy["yaml"].asText()).contains("name: 'Release notes 1.3.0'").contains("look around (1.3.0)")
        val theirs = listed(pid, wid)
        assertThat(theirs["yaml"].asText()).isEqualTo(edited)
        assertThat(theirs["source"].asText()).isEqualTo("yours")
        assertThat(theirs.has("market")).isFalse()
        // the new copy is unchanged: its next update needs no question
        assertThat(get("/api/marketplace/workflows/release-notes?project=$pid").json()["installed"]["wid"].asText()).isEqualTo(copy["id"].asText())

        val (pid2, _) = newProject("mw-replace")
        engine.market.workflowNewest["release-notes"] = "1.2.0"
        val w2 = install(pid2, "release-notes").json()["workflow"]["id"].asText()
        put("/api/workflows/$w2", mapOf("yaml" to listed(pid2, w2)["yaml"].asText().replace("check it", "mine"))).andExpect(status().isOk)
        engine.market.workflowNewest.clear()
        val replaced = post("/api/projects/$pid2/workflows/market/$w2/update", mapOf("mode" to "replace")).andExpect(status().isOk).json()
        assertThat(replaced["kept"].isNull).isTrue()
        assertThat(replaced["workflow"]["id"].asText()).isEqualTo(w2)
        assertThat(replaced["workflow"]["version"].asInt()).isEqualTo(3)
        assertThat(replaced["workflow"]["yaml"].asText()).doesNotContain("mine").contains("look around (1.3.0)")
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM workflow_versions WHERE workflow_id = ?", Int::class.java, w2)).isEqualTo(3)
    }

    // ---------- the market field, and parity

    @Test
    fun `only a marketplace workflow has the market field, and a list without one does not ask the catalogs`() {
        val (pid, _) = newProject("mw-field")
        val mine = post("/api/projects/$pid/workflows", mapOf("name" to "Mine", "from" to "blank")).json()["id"].asText()
        val calls = engine.calls.size
        val list = get("/api/projects/$pid/workflows").andExpect(status().isOk).json()
        assertThat(list.none { it.has("market") }).isTrue()
        assertThat(engine.calls.drop(calls).none { it.path.startsWith("/marketplace/") }).isTrue()
        assertThat(get("/api/workflows/$mine").json().has("market")).isFalse()
        assertThat(get("/api/workflows/feature").json().has("market")).isFalse()

        engine.market.workflowNewest["release-notes"] = "1.2.0"
        val wid = install(pid, "release-notes").json()["workflow"]["id"].asText()
        engine.market.workflowNewest.clear()
        val after = get("/api/projects/$pid/workflows").json()
        assertThat(after.filter { it.has("market") }.map { it["id"].asText() }).containsExactly(wid)
        assertThat(listed(pid, wid)["market"]["update"].asText()).isEqualTo("1.3.0")
        // the catalogs do not answer: the list still does, with no update
        engine.market.refusals["workflows"] = 502 to mapOf("error" to "The catalogs do not read.")
        assertThat(listed(pid, wid)["market"]["update"].isNull).isTrue()
    }

    // ---------- publish

    @Test
    fun `publish gives a zip with the yaml, the marketplace entry and the commands, and never a signature`() {
        val (pid, _) = newProject("mw-publish")
        val wid = post("/api/projects/$pid/workflows", mapOf("name" to "Release notes mine", "from" to "library:release-notes")).json()["id"].asText()
        val res = get("/api/workflows/$wid/publish").andExpect(status().isOk)
            .andExpect(header().string("Content-Type", "application/zip"))
            .andExpect(header().string("Content-Disposition", "attachment; filename=release-notes-mine-1.0.0.zip"))
            .andReturn().response.contentAsByteArray
        val files = unzip(res)
        assertThat(files.keys).containsExactlyInAnyOrder("release-notes-mine-1.0.0.yaml", "workflows/release-notes-mine.yml", "PUBLISH.md")
        val yaml = files.getValue("release-notes-mine-1.0.0.yaml")
        assertThat(yaml).contains("name: Release notes mine").contains("run:git log")
        assertThat(yaml.lines().none { it.startsWith("version:") }).isTrue()        // the engine reads version as a number
        val entry = files.getValue("workflows/release-notes-mine.yml")
        assertThat(entry).contains("name: release-notes-mine\n", "title: 'Release notes mine'\n", "publisher: you ", "category: other ",
            "repo: https://github.com/you/keel-workflows ", "tags: []\n")
        val guide = files.getValue("PUBLISH.md")
        assertThat(guide).contains("keel-plugin workflow lint release-notes-mine-1.0.0.yaml", "keel-plugin keygen you",
            "keel-plugin sign release-notes-mine-1.0.0.yaml --key-file you.key", "gh pr create --repo keel-studio/keel-marketplace")
        assertThat(files.keys.none { it.endsWith(".minisig") }).isTrue()

        val custom = unzip(get("/api/workflows/$wid/publish?name=notes&version=2.1.0&summary=Notes&category=docs&publisher=ana-k")
            .andExpect(status().isOk).andReturn().response.contentAsByteArray)
        assertThat(custom.keys).contains("notes-2.1.0.yaml", "workflows/notes.yml")
        assertThat(custom.getValue("workflows/notes.yml")).contains("publisher: ana-k", "category: docs", "summary: 'Notes'\n")
        get("/api/workflows/$wid/publish?category=games").andExpect(status().isBadRequest)
        get("/api/workflows/$wid/publish?version=1.0").andExpect(status().isBadRequest)
        get("/api/workflows/$wid/publish?name=Bad_Name").andExpect(status().isBadRequest)
        get("/api/workflows/nope/publish").andExpect(status().isNotFound)
        // a marketplace workflow: its name, and the next patch version
        val mkt = install(pid, "release-notes").json()["workflow"]["id"].asText()
        assertThat(unzip(get("/api/workflows/$mkt/publish").andReturn().response.contentAsByteArray).keys).contains("release-notes-1.3.1.yaml")
    }

    @Test
    fun `versions sort in semver's order and the export drops a version keel's engine cannot read`() {
        assertThat(MarketVersions.newer("1.10.0", "1.9.0")).isTrue()
        assertThat(MarketVersions.newer("1.0.0", "1.0.0-beta.2")).isTrue()
        assertThat(MarketVersions.newer("1.0.0-beta.10", "1.0.0-beta.2")).isTrue()
        assertThat(MarketVersions.newer("1.0.0", "1.0.0")).isFalse()
        assertThat(MarketWorkflows.exportYaml("name: x\nversion: 2.0.1\nsteps: []\n")).isEqualTo("name: x\nsteps: []\n")
        assertThat(MarketWorkflows.exportYaml("name: x\nversion: 3\nsteps: []\n")).isEqualTo("name: x\nversion: 3\nsteps: []\n")
    }

    private fun unzip(bytes: ByteArray): Map<String, String> {
        val out = linkedMapOf<String, String>()
        ZipInputStream(ByteArrayInputStream(bytes)).use { z ->
            while (true) {
                val e = z.nextEntry ?: break
                out[e.name] = z.readAllBytes().toString(Charsets.UTF_8)
            }
        }
        return out
    }
}
