package keel.api

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

class WorkflowApiTest : ApiTest() {
    @Autowired lateinit var jdbc: JdbcTemplate

    @Test
    fun `templates come from the engine and project workflows are listed with them`() {
        val (pid, _) = newProject("wf-list")
        val list = get("/api/projects/$pid/workflows").andExpect(status().isOk).json()
        val feature = list.first { it["id"].asText() == "feature" }
        assertThat(feature["source"].asText()).isEqualTo("keel")
        assertThat(feature["steps"].size()).isEqualTo(7)
        // an included step keeps where it came from (the web folds an include into one block); others have no such key
        assertThat(feature["steps"].first { it["id"].asText() == "ship_verify" }["included_from"].asText()).isEqualTo("ship")
        assertThat(feature["steps"].first { it["id"].asText() == "red" }.has("included_from")).isFalse()
        assertThat(feature["yaml"].asText()).contains("name:")
    }

    @Test
    fun `locked steps cannot be removed while keel rules are on`() {
        val (pid, _) = newProject("wf-locked")
        val wf = post("/api/projects/$pid/workflows", mapOf("name" to "Hotfix", "from" to "template:feature", "keel_rules" to true))
            .andExpect(status().isOk).json()
        val wid = wf["id"].asText()
        assertThat(wf["version"].asInt()).isEqualTo(1)
        assertThat(wf["based_on"].asText()).isEqualTo("keel/feature")

        val withoutGate = wf["steps"].filter { it["id"].asText() != "g-spec" }
        val refused = put("/api/workflows/$wid", mapOf("steps" to withoutGate)).andExpect(status().isConflict).json()
        assertThat(refused["error"].asText()).contains("spec approval")
        assertThat(refused["hint"].asText()).isEqualTo("Turn keel rules off for this workflow")
        assertThat(get("/api/workflows/$wid").json()["version"].asInt()).isEqualTo(1)

        // Removing an unlocked step is fine.
        val withoutSpec = wf["steps"].filter { it["id"].asText() != "spec" }
        val v2 = put("/api/workflows/$wid", mapOf("steps" to withoutSpec)).andExpect(status().isOk).json()
        assertThat(v2["version"].asInt()).isEqualTo(2)

        // With keel rules off, the gate can go.
        val v3 = put("/api/workflows/$wid", mapOf("keel_rules" to false, "steps" to v2["steps"].filter { it["id"].asText() != "g-spec" }))
            .andExpect(status().isOk).json()
        assertThat(v3["version"].asInt()).isEqualTo(3)
        assertThat(v3["keel_rules"].asBoolean()).isFalse()
        assertThat(v3["steps"].map { it["id"].asText() }).doesNotContain("g-spec")
    }

    @Test
    fun `the engine validates every save`() {
        val (pid, _) = newProject("wf-validate")
        val wid = post("/api/projects/$pid/workflows", mapOf("name" to "Mine", "from" to "blank")).json()["id"].asText()
        val bad = "name: Mine\nkeel_rules: false\nsteps:\n  - { id: INVALID, kind: code, name: nope }\n"
        val e = put("/api/workflows/$wid", mapOf("yaml" to bad)).andExpect(status().isUnprocessableEntity).json()
        assertThat(e["hint"].asText()).contains("INVALID")
        put("/api/workflows/feature", mapOf("name" to "x")).andExpect(status().isConflict)
    }

    @Test
    fun `export then import gives the same workflow`() {
        val (pid, _) = newProject("wf-roundtrip")
        val wf = post("/api/projects/$pid/workflows", mapOf("name" to "Round trip", "from" to "template:feature")).json()
        val wid = wf["id"].asText()

        val res = get("/api/workflows/$wid/export")
            .andExpect(status().isOk)
            .andExpect(header().string("Content-Disposition", "attachment; filename=$wid.workflow.yaml"))
            .andReturn().response
        assertThat(res.contentType).startsWith("text/yaml")
        val yaml = res.contentAsString
        assertThat(yaml).contains("name: Round trip").contains("lock: true")

        val imported = post("/api/projects/$pid/workflows/import", mapOf("yaml" to yaml)).andExpect(status().isOk).json()
        val iw = imported["workflow"]
        assertThat(iw["id"].asText()).isNotEqualTo(wid)
        assertThat(iw["name"].asText()).isEqualTo("Round trip")
        assertThat(iw["keel_rules"].asBoolean()).isEqualTo(wf["keel_rules"].asBoolean())
        assertThat(iw["steps"]).isEqualTo(wf["steps"])

        val review = imported["review"]
        assertThat(review["steps"].asInt()).isEqualTo(7)   // included_from survives the round trip (steps are equal above)
        assertThat(review["gates"].asInt()).isEqualTo(2)
        assertThat(review["agents"].map { it.asText() }).containsExactly("explorer", "test-author", "implementer")
        assertThat(review["edits_files"].asBoolean()).isTrue()
        assertThat(review["valid"].asBoolean()).isTrue()
    }

    @Test
    fun `bad imports are refused`() {
        val (pid, _) = newProject("wf-badimport")
        post("/api/projects/$pid/workflows/import", mapOf("yaml" to "just: [a list")).andExpect(status().isBadRequest)
        post("/api/projects/$pid/workflows/import", mapOf("url" to "file:///etc/passwd")).andExpect(status().isBadRequest)
        post("/api/projects/$pid/workflows/import", emptyMap<String, String>()).andExpect(status().isBadRequest)
    }

    @Test
    fun `an import link to this computer or a private network is refused`() {
        val (pid, _) = newProject("wf-ssrf")
        val server = com.sun.net.httpserver.HttpServer.create(java.net.InetSocketAddress(java.net.InetAddress.getLoopbackAddress(), 0), 0)
        server.createContext("/w.yaml") { ex -> val b = "name: x\nsteps: []\n".toByteArray(); ex.sendResponseHeaders(200, b.size.toLong()); ex.responseBody.write(b); ex.close() }
        server.start()
        try {
            val res = post("/api/projects/$pid/workflows/import", mapOf("url" to "http://127.0.0.1:${server.address.port}/w.yaml"))
                .andExpect(status().isBadRequest).json()
            assertThat(res["error"].asText()).contains("private network")
            post("/api/projects/$pid/workflows/import", mapOf("url" to "http://169.254.169.254/latest/meta-data")).andExpect(status().isBadRequest)
        } finally { server.stop(0) }
    }

    @Test
    fun `library items install per project or for all`() {
        val (pid, _) = newProject("wf-library")
        val lib = get("/api/library?project=$pid").json()
        assertThat(lib.map { it["id"].asText() }).containsExactlyInAnyOrder(
            "dependency-upgrade", "flaky-test-fixer", "api-contract-first", "release-notes", "weekly-hunt",
        )
        val notes = lib.first { it["id"].asText() == "release-notes" }
        assertThat(notes["mcp"].map { it.asText() }).contains("github")
        assertThat(notes["steps"].asInt()).isEqualTo(4)
        assertThat(notes["installed"].asBoolean()).isFalse()

        val w = post("/api/projects/$pid/library/release-notes/install", mapOf("scope" to "project")).andExpect(status().isOk).json()
        assertThat(w["source"].asText()).isEqualTo("library")
        assertThat(get("/api/library?project=$pid").json().first { it["id"].asText() == "release-notes" }["installed"].asBoolean()).isTrue()
        // again = same workflow
        val again = post("/api/projects/$pid/library/release-notes/install", mapOf("scope" to "project")).json()
        assertThat(again["id"]).isEqualTo(w["id"])

        val all = post("/api/projects/$pid/library/weekly-hunt/install", mapOf("scope" to "all")).andExpect(status().isOk).json()
        val (other, _) = newProject("wf-library-other")
        assertThat(get("/api/projects/$other/workflows").json().map { it["id"].asText() }).contains(all["id"].asText())
        delete("/api/workflows/${all["id"].asText()}").andExpect(status().isOk)
        delete("/api/workflows/feature").andExpect(status().isConflict)
    }

    private fun thread(pid: String, wid: String, tid: String, title: String, status: String) = jdbc.update(
        "INSERT INTO threads(id, project_id, workflow_id, title, status, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '{}', 'now', 'now')",
        tid, pid, wid, title, status,
    )

    @Test
    fun `a workflow cannot be deleted while one of its flows runs or waits at a gate`() {
        val (pid, _) = newProject("wf-del-running")
        val mk = { n: String -> post("/api/projects/$pid/workflows", mapOf("name" to n, "from" to "blank")).json()["id"].asText() }

        val running = mk("Busy")
        thread(pid, running, "t-del-run", "Add login", "running")
        val e = delete("/api/workflows/$running").andExpect(status().isConflict).json()
        assertThat(e["error"].asText()).isEqualTo("Busy has a flow running (Add login): stop it or let it finish first.")
        get("/api/workflows/$running").andExpect(status().isOk)

        val waiting = mk("Waits")
        thread(pid, waiting, "t-del-wait", "Fix totals", "waiting")
        assertThat(delete("/api/workflows/$waiting").andExpect(status().isConflict).json()["error"].asText())
            .isEqualTo("Waits has a flow running (Fix totals): stop it or let it finish first.")

        // finished (and stopped) flows keep their history; the workflow can go
        val finished = mk("Done")
        thread(pid, finished, "t-del-done", "Old work", "done")
        thread(pid, finished, "t-del-stop", "Older work", "stopped")
        delete("/api/workflows/$finished").andExpect(status().isOk)
        get("/api/workflows/$finished").andExpect(status().isNotFound)
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM threads WHERE workflow_id = ?", Int::class.java, finished)).isEqualTo(2)
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM workflow_versions WHERE workflow_id = ?", Int::class.java, finished)).isEqualTo(0)
    }

    @Test
    fun `a YAML with another workflow's id is refused on save, it is an import`() {
        val (pid, _) = newProject("wf-other-id")
        val wid = post("/api/projects/$pid/workflows", mapOf("name" to "Mine", "from" to "blank")).json()["id"].asText()
        val other = "id: feature\nname: Feature\nkeel_rules: false\nsteps:\n  - { id: s1, kind: code, name: one, action: report }\n"
        val e = put("/api/workflows/$wid", mapOf("yaml" to other)).andExpect(status().isConflict).json()
        assertThat(e["error"].asText()).isEqualTo("This YAML is a different workflow (id feature). Use Import to add it as a new workflow.")
        assertThat(get("/api/workflows/$wid").json()["version"].asInt()).isEqualTo(1)
        // its own id, or no id (a rename), saves
        put("/api/workflows/$wid", mapOf("yaml" to other.replace("id: feature", "id: $wid"))).andExpect(status().isOk)
        put("/api/workflows/$wid", mapOf("yaml" to other.replace("id: feature\n", "").replace("Feature", "Renamed"))).andExpect(status().isOk)
    }

    @Test
    fun `check, save and import give each error at its line and keep the old texts`() {
        val (pid, _) = newProject("wf-lines")
        val wid = post("/api/projects/$pid/workflows", mapOf("name" to "Mine", "from" to "blank")).json()["id"].asText()
        val bad = "name: Mine\nkeel_rules: false\nsteps:\n  - { id: a, kind: code, name: a, action: report }\n  - { id: INVALID, kind: code, name: nope }\n"

        val check = post("/api/projects/$pid/workflows/check", mapOf("yaml" to bad)).andExpect(status().isOk).json()
        assertThat(check["valid"].asBoolean()).isFalse()
        assertThat(check["errors"].map { it.asText() }).containsExactly("step INVALID is not allowed")
        assertThat(check["lines"].map { it["line"].asInt() to it["message"].asText() }).containsExactly(5 to "step INVALID is not allowed")
        val ok = post("/api/projects/$pid/workflows/check", mapOf("yaml" to bad.replace("INVALID", "b"))).json()
        assertThat(ok["valid"].asBoolean()).isTrue()
        assertThat(ok["lines"].size()).isEqualTo(0)

        val saved = put("/api/workflows/$wid", mapOf("yaml" to bad)).andExpect(status().isUnprocessableEntity).json()
        assertThat(saved["hint"].asText()).isEqualTo("step INVALID is not allowed")
        assertThat(saved["lines"][0]["line"].asInt()).isEqualTo(5)

        val imported = post("/api/projects/$pid/workflows/import", mapOf("yaml" to bad)).andExpect(status().isUnprocessableEntity).json()
        assertThat(imported["lines"][0]["line"].asInt()).isEqualTo(5)

        // keel's own reading refuses it (no name): 400 as before, and a line
        val noName = put("/api/workflows/$wid", mapOf("yaml" to "keel_rules: false\nsteps: []\n")).andExpect(status().isBadRequest).json()
        assertThat(noName["error"].asText()).isEqualTo("The workflow has no name")
        assertThat(noName["lines"][0]["line"].asInt()).isEqualTo(1)
        val noNameCheck = post("/api/projects/$pid/workflows/check", mapOf("yaml" to "keel_rules: false\nsteps: []\n")).json()
        assertThat(noNameCheck["errors"].map { it.asText() }).containsExactly("The workflow has no name", "Add `name:` at the top of the file.")
        assertThat(noNameCheck["lines"].size()).isEqualTo(1)
    }

    @Test
    fun `a save stores the workflow as the engine writes it`() {
        val (pid, _) = newProject("wf-tidy")
        val wid = post("/api/projects/$pid/workflows", mapOf("name" to "Mine", "from" to "blank")).json()["id"].asText()
        val messy = "# mine\nsteps:\n- {name: r, id: r, kind: code, action: report}\nkeel_rules: false\nname: Mine\n"
        val tidy = "# mine\n\nname: Mine\nkeel_rules: false\n\nsteps:\n\n  - id: r\n    kind: code\n    name: r\n    action: report\n"
        engine.extraRoutes["/workflows/validate"] = { _ -> 200 to mapOf("ok" to true, "errors" to emptyList<String>(), "lines" to emptyList<Any>(), "formatted" to tidy) }
        try {
            val out = put("/api/workflows/$wid", mapOf("yaml" to messy)).andExpect(status().isOk).json()
            assertThat(out["yaml"].asText()).isEqualTo(tidy)
            assertThat(get("/api/workflows/$wid/export").andReturn().response.contentAsString).isEqualTo(tidy)
        } finally {
            engine.extraRoutes.remove("/workflows/validate")
        }
        // an engine that sends no formatted: the YAML as it came
        val again = "name: Mine\nkeel_rules: false\nsteps:\n  - { id: r, kind: code, name: r2, action: report }\n"
        assertThat(put("/api/workflows/$wid", mapOf("yaml" to again)).json()["yaml"].asText()).isEqualTo(again)
    }

    @Test
    fun `a new workflow starts from the engine's small example, which saves as it is`() {
        val (pid, _) = newProject("wf-starter")
        val shown = get("/api/projects/$pid/workflows/starter?name=Hotfix&keel_rules=false").andExpect(status().isOk).json()
        val id = shown["id"].asText()
        assertThat(shown["yaml"].asText()).startsWith("# Hotfix: a small workflow to start from.").contains("id: $id\nname: Hotfix\n").contains("keel_rules: false")

        val wf = post("/api/projects/$pid/workflows", mapOf("name" to "Hotfix", "from" to "blank", "keel_rules" to true)).andExpect(status().isOk).json()
        assertThat(wf["id"].asText()).isEqualTo(id)
        assertThat(wf["steps"].map { it["id"].asText() }).containsExactly("plan", "plan_ok")
        assertThat(wf["keel_rules"].asBoolean()).isTrue()
        assertThat(wf["yaml"].asText()).contains("id: $id\n").contains("keel_rules: true")
        assertThat(wf["source"].asText()).isEqualTo("yours")
        // Save as it is (the blocks' Save sends the steps): a new version
        assertThat(put("/api/workflows/$id", mapOf("yaml" to wf["yaml"].asText() + "\n")).andExpect(status().isOk).json()["version"].asInt()).isEqualTo(2)
        assertThat(put("/api/workflows/$id", mapOf("steps" to wf["steps"])).andExpect(status().isOk).json()["version"].asInt()).isEqualTo(3)
    }
}
