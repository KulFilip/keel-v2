package keel.api

import keel.api.knowledge.Layout
import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import java.nio.file.Files

/** v0.15.8 keel v1's layouts (`layout:` in .keel/config.yml): where keel's files are, read in the keel docs. The wiki's
 *  part is the Wiki plugin's (plugins/wiki/api: WikiLayoutApiTest). */
class LayoutApiTest : ApiTest() {

    private val spec = "# Scores\n\n- **AC-1** [API] a score is saved\n- **AC-2** [API] the top ten\n"

    private fun docs(pid: String) = get("/api/projects/$pid/keel-docs").andExpect(status().isOk).json().map { it["path"].asText() }

    @Test
    fun `repo layout reads docs specs, knowledge, adr and the runbook`() {
        val (pid, _) = newProject("layout-repo", mapOf(
            "docs/specs/scores.md" to spec, "docs/knowledge/architecture.md" to "# A\n`README.md:1`\n",
            "docs/adr/0001-db.md" to "# Use SQLite\n", "docs/RUNNING.md" to "# Run\n",
        ))
        assertThat(docs(pid)).contains("docs/specs/scores.md", "docs/adr/0001-db.md", "docs/knowledge/", "docs/RUNNING.md")
        val lay = get("/api/projects/$pid/layout").json()
        assertThat(lay["name"].asText()).isEqualTo("repo")
        assertThat(lay["specs"].asText()).isEqualTo("docs/specs")
    }

    @Test
    fun `keel layout reads everything under dot keel`() {
        val (pid, _) = newProject("layout-keel", mapOf(
            ".keel/config.yml" to "layout: keel\n", ".keel/specs/x.md" to "# X\n\n- **AC-1** [API] x works\n",
            ".keel/knowledge/domain.md" to "# Domain\n`README.md:1`\n", ".keel/adr/0002.md" to "# Keep it\n", ".keel/RUNNING.md" to "# Run it\n",
        ))
        assertThat(docs(pid)).contains(".keel/specs/x.md", ".keel/adr/0002.md", ".keel/knowledge/", ".keel/RUNNING.md")
        val kb = get("/api/projects/$pid/memory").json()["knowledge"].first { it["id"].asText() == "domain" }
        assertThat(kb["status"].asText()).isEqualTo("written")
    }

    @Test
    fun `a mixed project shows both spec folders`() {
        val (pid, _) = newProject("layout-mixed", mapOf(
            ".keel/config.yml" to "layout: keel\n", ".keel/specs/new.md" to "# New\n", "docs/specs/old.md" to "# Old\n",
        ))
        assertThat(docs(pid)).contains(".keel/specs/new.md", "docs/specs/old.md")
        val lay = get("/api/projects/$pid/layout").json()
        assertThat(lay["spec_dirs"].map { it.asText() }).containsExactly(".keel/specs", "docs/specs")
    }

    @Test
    fun `external layout follows the link, and says so when its folder is not visible`() {
        val (pid, root) = newProject("layout-external")
        val target = Files.createTempDirectory("keel-ext")
        Files.createDirectories(target.resolve("specs"))
        Files.writeString(target.resolve("config.yml"), "layout: external\n")
        Files.writeString(target.resolve("specs/e.md"), "# E\n")
        Files.createSymbolicLink(root.resolve(".keel"), target)
        assertThat(docs(pid)).contains(".keel/specs/e.md")

        val (pid2, root2) = newProject("layout-external-gone")
        Files.createSymbolicLink(root2.resolve(".keel"), root2.resolveSibling("no-such-keel-folder"))
        val lay = get("/api/projects/$pid2/layout").json()
        assertThat(lay["name"].asText()).isEqualTo("external")
        assertThat(lay["missing"].asText()).contains("keel2 add").contains("no-such-keel-folder")
    }

    @Test
    fun `config folders outside the project and symlinked specs are not read`() {
        val (pid, root) = newProject("layout-hostile", mapOf(
            ".keel/config.yml" to "layout: repo\nspecs:\n  dir: ../../\nsetup:\n  runbook: ../../.zshrc\nmemory:\n  dir: /etc\n",
            "docs/specs/ok.md" to "# Ok\n",
        ))
        val outside = Files.createTempFile("keel-secret", ".md")
        Files.writeString(outside, "# secret\n")
        Files.createSymbolicLink(root.resolve("docs/specs/leak.md"), outside)
        val lay = get("/api/projects/$pid/layout").json()
        assertThat(lay["specs"].asText()).isEqualTo("docs/specs")
        assertThat(lay["runbook"].asText()).isEqualTo("docs/RUNNING.md")
        assertThat(lay["knowledge"].asText()).isEqualTo("docs/knowledge")
        assertThat(docs(pid)).contains("docs/specs/ok.md").doesNotContain("docs/specs/leak.md")
    }

    @Test
    fun `a config that names keel's folders stays repo`() {
        val (_, root) = newProject("layout-specs-dir", mapOf(".keel/config.yml" to "version: 4\nspecs:\n  dir: design/specs\n"))
        assertThat(Layout.resolve(root).name).isEqualTo("repo")
        assertThat(Layout.resolve(root).specs).isEqualTo("design/specs")
    }

    @Test
    fun `the resolver's default without a layout key`() {
        val (_, fresh) = newProject("layout-default-new")
        assertThat(Layout.resolve(fresh).name).isEqualTo(Layout.NEW_PROJECT)
        val (_, legacy) = newProject("layout-default-legacy", mapOf("docs/knowledge/data.md" to "# Data\n"))
        assertThat(Layout.resolve(legacy).name).isEqualTo("repo")
    }

    @Test
    fun `keel's own files in a hidden layout do not count as uncommitted work`() {
        val (pid, root) = newProject("layout-dirty", mapOf(".keel/config.yml" to "layout: keel\n"))
        git(root, "rm", "-r", "-q", "--cached", ".keel")
        git(root, "commit", "-q", "-m", "untrack .keel")
        Files.createDirectories(root.resolve(".keel/specs"))
        Files.writeString(root.resolve(".keel/specs/x.md"), "# X\n")
        post("/api/projects/$pid/flows", mapOf("workflow_id" to "feature", "title" to "x")).andExpect(status().isOk)
    }

    @Test
    fun `the guard's spec bucket covers every spec folder`() {
        val (_, root) = newProject("layout-classify", mapOf(".keel/config.yml" to "layout: keel\n", "docs/specs/old.md" to "# Old\n"))
        val cfg = keel.api.repo.ClassifyConfig.load(root)
        assertThat(keel.api.repo.KeelRules.classify(cfg, ".keel/specs/a.md")).isEqualTo("specs")
        assertThat(keel.api.repo.KeelRules.classify(cfg, "docs/specs/old.md")).isEqualTo("specs")
    }
}
