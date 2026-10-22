package keel.api

import keel.api.common.Forbidden
import keel.api.repo.RepoService
import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import java.nio.file.Files

/** safePath checks the real file behind a link, and the .git name in any letter case. */
class RepoSafePathApiTest : ApiTest() {
    @Autowired lateinit var repo: RepoService

    @Test
    fun `a link to a secret file or into dot git is refused`() {
        val (pid, root) = newProject("safe-links", mapOf("README.md" to "# x\n", "src/a.txt" to "a\n"))
        Files.writeString(root.resolve(".env"), "SECRET=1\n")
        Files.createSymbolicLink(root.resolve("notes.txt"), root.resolve(".env"))
        Files.createSymbolicLink(root.resolve("x"), root.resolve(".git"))
        Files.createSymbolicLink(root.resolve("src/ok.txt"), root.resolve("src/a.txt"))

        assertThatThrownBy { repo.safePath(root, "notes.txt") }.isInstanceOf(Forbidden::class.java).hasMessageContaining("secret")
        assertThatThrownBy { repo.safePath(root, "x/config") }.isInstanceOf(Forbidden::class.java).hasMessageContaining(".git")
        assertThatThrownBy { repo.safePath(root, "x") }.isInstanceOf(Forbidden::class.java)
        assertThat(repo.safePath(root, "src/ok.txt")).isEqualTo(root.resolve("src/ok.txt"))
        get("/api/projects/$pid/file?path=notes.txt").andReturn().response.status.let { assertThat(it).isIn(403, 404) }
    }

    @Test
    fun `dot git is refused in any letter case`() {
        val (_, root) = newProject("safe-case")
        assertThatThrownBy { repo.safePath(root, ".GIT/config") }.isInstanceOf(Forbidden::class.java)
        assertThatThrownBy { repo.safePath(root, "sub/.Git/config") }.isInstanceOf(Forbidden::class.java)
        assertThatThrownBy { repo.safePath(root, ".git") }.isInstanceOf(Forbidden::class.java)
        assertThat(repo.safePath(root, "README.md")).isEqualTo(root.resolve("README.md"))
        assertThat(repo.safePath(root, ".github/ci.yml")).isEqualTo(root.resolve(".github/ci.yml"))
    }
}
