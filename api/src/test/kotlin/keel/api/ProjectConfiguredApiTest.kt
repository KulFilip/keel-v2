package keel.api

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import java.nio.file.Files
import java.nio.file.Path

/** keel 0.18.55 a project says whether keel knows it (`configured`: it has a .keel/config.yml), so adding one can offer init. */
class ProjectConfiguredApiTest : ApiTest() {

    private fun repo(name: String): Path {
        val root = Files.createTempDirectory("keel-conf").resolve(name)
        Files.createDirectories(root)
        git(root, "init", "-q", "-b", "main")
        return root
    }

    @Test
    fun `a new project is not configured until it has a keel config`() {
        val (pid, root) = newProject("shop")
        val added = get("/api/projects/$pid").andExpect(status().isOk).json()
        assertThat(added["configured"].asBoolean()).isFalse()

        Files.createDirectories(root.resolve(".keel"))
        Files.writeString(root.resolve(".keel/config.yml"), "project: shop\n")
        assertThat(get("/api/projects/$pid").json()["configured"].asBoolean()).isTrue()
        assertThat(get("/api/projects").json().first { it["id"].asText() == pid }["configured"].asBoolean()).isTrue()
    }

    @Test
    fun `the add answers say whether keel knows the project`() {
        val plain = repo("blog")
        val known = repo("docs")
        Files.createDirectories(known.resolve(".keel"))
        Files.writeString(known.resolve(".keel/config.yml"), "project: docs\n")
        val one = post("/api/projects", mapOf("root" to plain.toString())).andExpect(status().isOk).json()
        assertThat(one["configured"].asBoolean()).isFalse()
        val bulk = post("/api/projects/bulk", mapOf("roots" to listOf(known.toString()))).andExpect(status().isOk).json()
        assertThat(bulk["added"].map { it["configured"].asBoolean() }).containsExactly(true)
    }
}
