package keel.api

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/**
 * keel 0.18.57 Start a flow warns when a KeelBot Ask or Edit chat reads the project folder: a flow on its own branch
 * would check that branch out under it. A side session (its own worktree) and an old chat do not count.
 */
class FolderActivityApiTest : ApiTest() {

    @Test
    fun `folder activity lists the Ask and Edit chats that read the project folder now`() {
        val (pid, _) = newProject("folder-activity")
        val now = java.time.Instant.now().toString()
        val old = java.time.Instant.now().minus(java.time.Duration.ofHours(3)).toString()
        fun sess(id: String, mode: String, status: String, at: String, worktree: String? = null) {
            engine.helperSessions[id] = mutableMapOf("id" to id, "project" to pid, "mode" to mode, "title" to "chat $id",
                "status" to status, "updated_at" to at, "worktree" to worktree)
        }
        sess("h_fa_ask", "ask", "idle", now)
        sess("h_fa_edit", "edit", "running", old)
        sess("h_fa_side", "side", "running", now, "/w/side")
        sess("h_fa_old", "ask", "idle", old)
        try {
            val a = get("/api/projects/$pid/folder-activity").json()
            assertThat(a["chats"].map { it["id"].asText() }).containsExactlyInAnyOrder("h_fa_ask", "h_fa_edit")
            assertThat(a["chats"].first { it["id"].asText() == "h_fa_ask" }["title"].asText()).isEqualTo("chat h_fa_ask")
            assertThat(a["flow"].isNull).isTrue()
            assertThat(a["worktree_ok"].isNull).isTrue()        // this keel's engine has no start check: not known
        } finally {
            listOf("h_fa_ask", "h_fa_edit", "h_fa_side", "h_fa_old").forEach { engine.helperSessions.remove(it) }
        }
    }
}
