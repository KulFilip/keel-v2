package keel.api.helper

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import java.nio.file.Files

/** 0.18.57 one owner per task: a side agent on what a flow or another side agent already works on is refused (force starts it). */
class HelperOwnersApiTest : ApiTest() {

    @Test
    fun `a side session on a ticket a flow works on is refused, naming the flow, and force starts it`() {
        val (pid, _) = newProject("side-owners")
        engine.nextThreadIds.add("t-side-a")
        post("/api/projects/$pid/flows", mapOf("workflow_id" to "feature", "title" to "SHOPS-1234: Euro prices", "allow_fake" to true))
            .andExpect(status().isOk)
        val res = post("/api/projects/$pid/helper/sessions", mapOf("mode" to "side", "title" to "SHOPS-1234 price rounding"))
            .andExpect(status().isConflict).json()
        assertThat(res["error"].asText()).contains("flow SHOPS-1234: Euro prices").contains("the same ticket SHOPS-1234")
        post("/api/projects/$pid/helper/sessions", mapOf("mode" to "side", "title" to "SHOPS-1234 price rounding", "force" to true))
            .andExpect(status().isOk)
        // ask mode only reads: never refused
        post("/api/projects/$pid/helper/sessions", mapOf("mode" to "ask", "title" to "SHOPS-1234 how do prices work")).andExpect(status().isOk)
    }

    @Test
    fun `a flow on a ticket a side agent works on names the side agent`() {
        val (pid, root) = newProject("side-first")
        val sid = post("/api/projects/$pid/helper/sessions", mapOf("mode" to "side", "title" to "SHOPS-77 cart badge"))
            .andExpect(status().isOk).json()["id"].asText()
        val wt = Files.createDirectories(root.resolve(".keel/worktrees/helper-x"))
        engine.helperSessions[sid]!!["worktree"] = wt.toString()
        val res = post("/api/projects/$pid/flows", mapOf("workflow_id" to "feature", "title" to "SHOPS-77: Cart badge", "allow_fake" to true))
            .andExpect(status().isConflict).json()
        assertThat(res["error"].asText()).contains("side agent $sid")
        assertThat(res["owners"][0]["kind"].asText()).isEqualTo("side")
    }
}
