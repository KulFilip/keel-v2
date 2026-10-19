package keel.api.wiki

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/** The wiki's order: what a client needs to group and sort the menu (kind, path, number, label, updated, also), specs
 *  and decisions by number, a folder's README left out, the same spec in two folders shown once, the index as overview. */
class WikiOrderApiTest : ApiTest() {

    private fun items(pid: String, section: String) =
        get("/api/projects/$pid/wiki").andExpect(status().isOk).json()["sections"].first { it["id"].asText() == section }["items"]

    @Test
    fun `specs and decisions come by number with readable labels, without the folder README, each file once`() {
        val (pid, _) = newProject("wiki-order", mapOf(
            "docs/specs/README.md" to "# Specs\n\nThe list.\n",
            "docs/specs/SPEC-10-later.md" to "# SPEC-10: Later one\n",
            "docs/specs/SPEC-2-early.md" to "# SPEC-2: Early one\n",
            "docs/specs/plugin-substrate.md" to "no heading here\n",
            ".keel/specs/SPEC-2-early.md" to "# SPEC-2: Early one\n",
            "docs/adr/0002-b.md" to "# ADR 0002 — Second\n",
            "docs/adr/0001-a.md" to "# 0001 — First\n",
            "docs/adr/index.md" to "# Decisions\n",
            "docs/knowledge/index.md" to "# What an agent needs to know\n",
            "docs/knowledge/architecture.md" to "# Architecture of the app\n",
        ))
        val specs = items(pid, "specs")
        assertThat(specs.map { it["id"].asText() })
            .containsExactly("spec:docs/specs/SPEC-2-early.md", "spec:docs/specs/SPEC-10-later.md", "spec:docs/specs/plugin-substrate.md")
        assertThat(specs.map { it["label"].asText() }).containsExactly("Early one", "Later one", "Plugin substrate")
        assertThat(specs.map { it["kind"].asText() }.toSet()).containsExactly("spec")
        assertThat(specs[0]["title"].asText()).isEqualTo("SPEC-2: Early one")
        assertThat(specs[0]["number"].asText()).isEqualTo("2")
        assertThat(specs[0]["path"].asText()).isEqualTo("docs/specs/SPEC-2-early.md")
        assertThat(specs[0]["updated"].asText()).isNotBlank()
        assertThat(specs[0]["also"].map { it.asText() }).containsExactly(".keel/specs/SPEC-2-early.md")
        assertThat(specs[2].path("number").isNull || specs[2].path("number").isMissingNode).isTrue()

        val adrs = items(pid, "decisions")
        assertThat(adrs.map { it["id"].asText() }).containsExactly("adr:0001-a.md", "adr:0002-b.md")
        assertThat(adrs.map { it["label"].asText() }).containsExactly("First", "Second")

        val kb = items(pid, "knowledge")
        assertThat(kb[0]["id"].asText()).isEqualTo("kb:index")
        assertThat(kb[0]["kind"].asText()).isEqualTo("overview")
        assertThat(kb[0]["title"].asText()).isEqualTo("What an agent needs to know")
        val arch = kb.first { it["id"].asText() == "kb:architecture" }
        assertThat(arch["title"].asText()).isEqualTo("Architecture")         // what old clients show
        assertThat(arch["label"].asText()).isEqualTo("Architecture of the app")
        assertThat(kb.first { it["id"].asText() == "kb:domain" }["label"].asText()).isEqualTo("Domain")
        assertThat(get("/api/projects/$pid/wiki/page?id=kb:index").json()["title"].asText()).isEqualTo("What an agent needs to know")

        // an old link to the README or the duplicate still opens; the spec status leaves the README out
        get("/api/projects/$pid/wiki/page?id=spec:docs/specs/README.md").andExpect(status().isOk)
        get("/api/projects/$pid/wiki/page?id=spec:.keel/specs/SPEC-2-early.md").andExpect(status().isOk)
        val st = get("/api/projects/$pid/specs/status").andExpect(status().isOk).json()
        assertThat(st.map { it["path"].asText() }).doesNotContain("docs/specs/README.md")
        assertThat(st.first { it["path"].asText() == "docs/specs/plugin-substrate.md" }["title"].asText()).isEqualTo("Plugin substrate")
    }

    @Test
    fun `labels and numbers from the file names keel projects use`() {
        assertThat(WikiService.NUMBER.find("SPEC-101-wave")?.groupValues?.get(1)).isEqualTo("101")
        assertThat(WikiService.NUMBER.find("0001-v5-web")?.groupValues?.get(1)).isEqualTo("0001")
        assertThat(WikiService.NUMBER.find("ADR_0002-x")?.groupValues?.get(1)).isEqualTo("0002")
        assertThat(WikiService.NUMBER.find("v1.1.0-plugin-substrate")).isNull()
        assertThat(WikiService.NUMBER.find("1.2-notes")).isNull()
        assertThat(WikiService.label("SPEC-200 — v5: Full web port", "200")).isEqualTo("v5: Full web port")
        assertThat(WikiService.label("Spec 001 — Authentication", "001")).isEqualTo("Authentication")
        assertThat(WikiService.label("ADR 0001 — Call the API", "0001")).isEqualTo("Call the API")
        assertThat(WikiService.label("SPEC-7: Other number", "8")).isEqualTo("SPEC-7: Other number")
        assertThat(WikiService.label("Scores", null)).isEqualTo("Scores")
        assertThat(WikiService.humanize("v1.1.0-plugin_substrate")).isEqualTo("V1.1.0 plugin substrate")
    }
}
