package keel.api

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/** keel 0.18.6: the project and the KeelBot chat the person looks at, shared by the dashboard and keel TUI. */
class UiFocusApiTest : ApiTest() {

    @Test
    fun `the project and each project's chat are kept, and a project that is gone is dropped`() {
        val (a, _) = newProject("focus-a")
        val (b, _) = newProject("focus-b")
        put("/api/ui/focus", mapOf("project" to a, "by" to "web", "client" to "tab-1")).andExpect(status().isOk)
        put("/api/ui/focus", mapOf("chat" to "s-1", "by" to "tui", "client" to "tui-1")).andExpect(status().isOk)
        put("/api/ui/focus", mapOf("project" to b, "chat" to "s-9", "by" to "tui", "client" to "tui-1")).andExpect(status().isOk)
        val f = get("/api/ui/focus").andExpect(status().isOk).json()
        assertThat(f["project"].asText()).isEqualTo(b)
        assertThat(f["chats"][a].asText()).isEqualTo("s-1")
        assertThat(f["chats"][b].asText()).isEqualTo("s-9")
        assertThat(f["by"].asText()).isEqualTo("tui")
        assertThat(f["client"].asText()).isEqualTo("tui-1")
        // close closes it
        put("/api/ui/focus", mapOf("close" to true, "chat_project" to a)).andExpect(status().isOk)
        assertThat(get("/api/ui/focus").json()["chats"].has(a)).isFalse()
    }

    @Test
    fun `an unknown project is refused`() {
        put("/api/ui/focus", mapOf("project" to "nope-nope")).andExpect(status().isNotFound)
    }
}
