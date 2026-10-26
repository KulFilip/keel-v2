package keel.api

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * keel 0.18.57 the project notes are opt-in (`knowledge.build` in .keel/config.yml): /memory says whether they are
 * on, with the engine's rule, and the estimate sends the project folder so building them shows what the librarians
 * read of its code.
 */
class NotesApiTest : ApiTest() {

    private fun notes(pid: String) = get("/api/projects/$pid/memory").json()["notes"]

    @Test
    fun `a new project has the notes off, one that has them keeps them, and the config's switch wins`() {
        val (fresh, _) = newProject("notes-new")
        assertThat(notes(fresh)["on"].asBoolean()).isFalse()
        assertThat(notes(fresh)["setting"].isNull).isTrue()

        val (old, _) = newProject("notes-old", mapOf("docs/knowledge/data.md" to "# Data\n\nIn `README.md:1`.\n", "README.md" to "# x\n"))
        assertThat(notes(old)["on"].asBoolean()).isTrue()
        assertThat(notes(old)["written"].asInt()).isEqualTo(1)

        val (off, _) = newProject("notes-off", mapOf("docs/knowledge/data.md" to "# Data\n", ".keel/config.yml" to "knowledge:\n  build: off\n"))
        assertThat(notes(off)["on"].asBoolean()).isFalse()
        assertThat(notes(off)["setting"].asText()).isEqualTo("off")

        val (on, _) = newProject("notes-on", mapOf(".keel/config.yml" to "knowledge:\n  build: 'on'\n"))
        assertThat(notes(on)["on"].asBoolean()).isTrue()
    }

    @Test
    fun `the estimate sends the project folder to the engine`() {
        val (pid, root) = newProject("notes-cost")
        get("/api/projects/$pid/estimate?workflow_id=knowledge-refresh&acs=0").andExpect(status().isOk)
        assertThat(engine.lastBody("/workflows/estimate")!!["root"].asText()).isEqualTo(root.toString())
    }
}
