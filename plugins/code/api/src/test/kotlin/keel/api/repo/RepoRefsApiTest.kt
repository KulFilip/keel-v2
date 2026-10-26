package keel.api.repo

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import java.nio.file.Files
import java.nio.file.Path

/** A file at another branch, review ref or commit (a link from a KeelBot answer, a review or a flow made there), read
 *  without checking anything out; and the refs that have a file the work tree does not (plugins/code, RepoRefs). */
class RepoRefsApiTest : ApiTest() {

    private val file = "src/Orders/ExportService.php"

    /** shop: main is checked out; feature/SHOPS-1234-export adds the export service (line 13 says so); a review ref
     *  of PR 7 is one commit further. */
    private fun shop(name: String): Pair<String, Path> {
        val (pid, root) = newProject(name)
        git(root, "checkout", "-q", "-b", "feature/SHOPS-1234-export")
        val f = root.resolve(file)
        Files.createDirectories(f.parent)
        Files.writeString(f, (1..20).joinToString("\n") { if (it == 13) "    return \$this->export(\$orders);" else "// line $it" } + "\n")
        git(root, "add", "-A")
        git(root, "commit", "-q", "-m", "feat: export orders")
        Files.writeString(f, Files.readString(f) + "// reviewed\n")
        git(root, "commit", "-q", "-am", "fix: review note")
        git(root, "update-ref", "refs/keel/review-pr/7", "HEAD")
        git(root, "reset", "-q", "--hard", "HEAD~1")
        git(root, "checkout", "-q", "main")
        return pid to root
    }

    private fun at(pid: String, path: String, ref: String, from: String? = null) = mvc.perform(
        MockMvcRequestBuilders.get("/api/projects/$pid/repo/file-at").param("path", path).param("ref", ref)
            .apply { if (from != null) param("from", from) },
    )

    @Test
    fun `a file on a branch that is not checked out is read from the branch, with what the banner needs`() {
        val (pid, root) = shop("refs-read")
        assertThat(Files.exists(root.resolve(file))).isFalse()
        val r = at(pid, file, "feature/SHOPS-1234-export").andExpect(status().isOk).json()
        assertThat(r["path"].asText()).isEqualTo(file)
        assertThat(r["text"].asText().lines()[12]).isEqualTo("    return \$this->export(\$orders);")
        assertThat(r["sha"].asText()).isEqualTo(git(root, "rev-parse", "feature/SHOPS-1234-export").trim())
        assertThat(r["kind"].asText()).isEqualTo("branch")
        assertThat(r["branch"].asText()).isEqualTo("feature/SHOPS-1234-export")
        assertThat(r["current"].asBoolean()).isFalse()
        assertThat(r["checked_out"].asText()).isEqualTo("main")
        assertThat(r["source"].asText()).isEqualTo("ref")
        assertThat(r["binary"].asBoolean()).isFalse()
        assertThat(r.has("worktree")).isFalse()
        // a review ref and a commit id work the same way; neither is a branch to check out
        val review = at(pid, file, "refs/keel/review-pr/7").andExpect(status().isOk).json()
        assertThat(review["kind"].asText()).isEqualTo("review")
        assertThat(review.path("branch").isMissingNode || review.path("branch").isNull).isTrue()
        assertThat(review["text"].asText()).endsWith("// reviewed\n")
        val sha = git(root, "rev-parse", "feature/SHOPS-1234-export").trim()
        assertThat(at(pid, file, sha.take(10)).andExpect(status().isOk).json()["kind"].asText()).isEqualTo("commit")
        // the checked-out branch itself is "current": the editor shows the work tree's file
        assertThat(at(pid, "README.md", "main").andExpect(status().isOk).json()["current"].asBoolean()).isTrue()
        // the folder's uncommitted changes are counted ("Check out" refuses while there are any)
        val before = at(pid, file, "feature/SHOPS-1234-export").json()["dirty"].asInt()
        Files.writeString(root.resolve("README.md"), "# changed\n")
        assertThat(at(pid, file, "feature/SHOPS-1234-export").json()["dirty"].asInt()).isEqualTo(before + 1)
    }

    @Test
    fun `bad refs and bad paths are refused before git sees them as options, ranges or files outside`() {
        val (pid, _) = shop("refs-bad")
        for (bad in listOf("--output=/tmp/x", "-n", "main..feature/SHOPS-1234-export", "main...x", "HEAD@{1}", "main^", "main~1",
            "main:README.md", "a b", "x;rm -rf /", "\$(id)", ".git/HEAD", "feature/", "x//y", "")) {
            at(pid, "README.md", bad).andExpect(status().isBadRequest)
        }
        at(pid, file, "no-such-branch").andExpect(status().isNotFound)
        at(pid, "src/Nope.php", "feature/SHOPS-1234-export").andExpect(status().isNotFound)
        at(pid, "src/Orders", "feature/SHOPS-1234-export").andExpect(status().isBadRequest)          // a folder
        for (bad in listOf("../outside.txt", "src/../../x", "/etc/passwd", ".git/config", "src/.GIT/HEAD", ".env", "keys/id_rsa")) {
            at(pid, bad, "feature/SHOPS-1234-export").andExpect(status().isForbidden)
        }
    }

    @Test
    fun `a branch a worktree has checked out names the worktree, and from=worktree reads its uncommitted file`() {
        val (pid, root) = shop("refs-worktree")
        val wt = root.parent.resolve("side-abc")
        git(root, "worktree", "add", "-q", "-b", "keel/helper/abc", wt.toString(), "feature/SHOPS-1234-export")
        Files.writeString(wt.resolve(file), "<?php // not committed yet\n")
        val r = at(pid, file, "keel/helper/abc").andExpect(status().isOk).json()
        assertThat(r["source"].asText()).isEqualTo("ref")
        assertThat(r["text"].asText()).startsWith("// line 1")
        assertThat(r["worktree"]["branch"].asText()).isEqualTo("keel/helper/abc")
        assertThat(Path.of(r["worktree"]["path"].asText()).toRealPath()).isEqualTo(wt.toRealPath())
        val w = at(pid, file, "keel/helper/abc", "worktree").andExpect(status().isOk).json()
        assertThat(w["source"].asText()).isEqualTo("worktree")
        assertThat(w["text"].asText()).isEqualTo("<?php // not committed yet\n")
        // no worktree has main's other branch out: from=worktree is a 404, and a secret file stays refused there too
        at(pid, file, "feature/SHOPS-1234-export", "worktree").andExpect(status().isNotFound)
        Files.writeString(wt.resolve(".env"), "KEY=1\n")
        at(pid, ".env", "keel/helper/abc", "worktree").andExpect(status().isForbidden)
    }

    @Test
    fun `a file the work tree does not have is found on the branches and review refs keel knows`() {
        val (pid, root) = shop("refs-find")
        git(root, "update-ref", "refs/remotes/origin/feature/SHOPS-1234-export", "feature/SHOPS-1234-export")
        val r = get("/api/projects/$pid/repo/find?path=$file").andExpect(status().isOk).json()
        assertThat(r["in_work_tree"].asBoolean()).isFalse()
        assertThat(r["checked_out"].asText()).isEqualTo("main")
        val refs = r["refs"].map { it["ref"].asText() }
        // the local branch first; the remote branch at the same commit is the same file (one per commit); the review ref
        assertThat(refs).containsExactly("feature/SHOPS-1234-export", "refs/keel/review-pr/7")
        assertThat(r["refs"][1]["label"].asText()).isEqualTo("PR #7 (review)")
        assertThat(r["refs"][0]["kind"].asText()).isEqualTo("branch")
        // README.md is in the work tree; the checked-out branch is never offered
        val readme = get("/api/projects/$pid/repo/find?path=README.md").json()
        assertThat(readme["in_work_tree"].asBoolean()).isTrue()
        assertThat(readme["refs"].map { it["ref"].asText() }).doesNotContain("main")
        get("/api/projects/$pid/repo/find?path=../x").andExpect(status().isForbidden)
    }
}
