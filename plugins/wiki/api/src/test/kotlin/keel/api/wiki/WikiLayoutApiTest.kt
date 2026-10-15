package keel.api.wiki

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import java.nio.file.Files

/** v0.15.8 keel v1's layouts in the wiki (the Wiki plugin's part of keel's LayoutApiTest): its specs, knowledge, ADRs
 *  and runbook come from the folders the layout names, and it says when keel cannot see an external layout's folder. */
class WikiLayoutApiTest : ApiTest() {

    private val spec = "# Scores\n\n- **AC-1** [API] a score is saved\n- **AC-2** [API] the top ten\n"

    private fun wiki(pid: String) = get("/api/projects/$pid/wiki").andExpect(status().isOk).json()

    @Test
    fun `repo layout lists docs specs and reads a spec page`() {
        val (pid, _) = newProject("wiki-layout-repo", mapOf(
            "docs/specs/scores.md" to spec, "docs/knowledge/architecture.md" to "# A\n`README.md:1`\n",
            "docs/adr/0001-db.md" to "# Use SQLite\n", "docs/RUNNING.md" to "# Run\n",
        ))
        val w = wiki(pid)
        assertThat(w["layout"].asText()).isEqualTo("repo")
        assertThat(w["sections"].map { it["id"].asText() }).containsExactly("specs", "knowledge", "workflows", "runbook", "decisions")
        assertThat(w["sections"].first { it["id"].asText() == "specs" }["items"].map { it["id"].asText() }).containsExactly("spec:docs/specs/scores.md")
        val page = get("/api/projects/$pid/wiki/page?id=spec:docs/specs/scores.md").andExpect(status().isOk).json()
        assertThat(page["title"].asText()).isEqualTo("Scores")
        assertThat(page["meta"]["acs"].asInt()).isEqualTo(2)
        get("/api/projects/$pid/wiki/page?id=spec:../../etc/passwd").andExpect(status().isNotFound)
    }

    @Test
    fun `keel layout reads everything under dot keel`() {
        val (pid, _) = newProject("wiki-layout-keel", mapOf(
            ".keel/config.yml" to "layout: keel\n", ".keel/specs/x.md" to "# X\n\n- **AC-1** [API] x works\n",
            ".keel/knowledge/domain.md" to "# Domain\n`README.md:1`\n", ".keel/adr/0002.md" to "# Keep it\n", ".keel/RUNNING.md" to "# Run it\n",
        ))
        val w = wiki(pid)
        assertThat(w["layout"].asText()).isEqualTo("keel")
        assertThat(w["sections"].first { it["id"].asText() == "specs" }["items"].map { it["id"].asText() }).containsExactly("spec:.keel/specs/x.md")
        val kb = w["sections"].first { it["id"].asText() == "knowledge" }["items"].first { it["id"].asText() == "kb:domain" }
        assertThat(kb["status"].asText()).isEqualTo("written")
        assertThat(get("/api/projects/$pid/wiki/page?id=kb:domain").json()["meta"]["path"].asText()).isEqualTo(".keel/knowledge/domain.md")
        assertThat(get("/api/projects/$pid/wiki/page?id=runbook").json()["meta"]["from"].asText()).isEqualTo(".keel/RUNNING.md")
        assertThat(get("/api/projects/$pid/wiki/page?id=adr:0002.md").json()["meta"]["path"].asText()).isEqualTo(".keel/adr/0002.md")
    }

    @Test
    fun `external layout follows the link, and says so when its folder is not visible`() {
        val (pid, root) = newProject("wiki-layout-external")
        val target = Files.createTempDirectory("keel-ext")
        Files.createDirectories(target.resolve("specs"))
        Files.writeString(target.resolve("config.yml"), "layout: external\n")
        Files.writeString(target.resolve("specs/e.md"), "# E\n")
        Files.createSymbolicLink(root.resolve(".keel"), target)
        assertThat(wiki(pid)["notice"].isNull).isTrue()

        val (pid2, root2) = newProject("wiki-layout-external-gone")
        Files.createSymbolicLink(root2.resolve(".keel"), root2.resolveSibling("no-such-keel-folder"))
        val w = wiki(pid2)
        assertThat(w["layout"].asText()).isEqualTo("external")
        assertThat(w["notice"].asText()).contains("keel2 add").contains("no-such-keel-folder")
    }

    @Test
    fun `a symlinked spec is not read`() {
        val (pid, root) = newProject("wiki-layout-hostile", mapOf(
            ".keel/config.yml" to "layout: repo\nspecs:\n  dir: ../../\n", "docs/specs/ok.md" to "# Ok\n",
        ))
        val outside = Files.createTempFile("keel-secret", ".md")
        Files.writeString(outside, "# secret\n")
        Files.createSymbolicLink(root.resolve("docs/specs/leak.md"), outside)
        get("/api/projects/$pid/wiki/page?id=spec:docs/specs/ok.md").andExpect(status().isOk)
        get("/api/projects/$pid/wiki/page?id=spec:docs/specs/leak.md").andExpect(status().isNotFound)
    }
}
