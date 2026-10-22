package keel.api

import keel.api.flow.branchName
import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/** A flow's branch: {flow} is its workflow id, a fix goes on fix/, and a fix of a hunt finding gets its own worktree. */
class FlowBranchApiTest : ApiTest() {
    @Autowired lateinit var jdbc: JdbcTemplate

    @Test
    fun `the branch pattern names the workflow and a fix goes on fix`() {
        assertThat(branchName(null, "Top 10 scores", "feature")).isEqualTo("feat/top-10-scores")
        assertThat(branchName("", "Average is wrong", "fix")).isEqualTo("fix/average-is-wrong")
        assertThat(branchName("feat/{slug}", "Average is wrong", "fix")).isEqualTo("fix/average-is-wrong")
        assertThat(branchName("{user}/{flow}/{slug}", "Ranks", "hunt")).isEqualTo("keel/hunt/ranks")
        assertThat(branchName("{flow}/{slug}", "Ranks", "fix")).isEqualTo("fix/ranks")
        assertThat(branchName("work/{slug}", "Ranks", "fix")).isEqualTo("work/ranks")
    }

    @Test
    fun `a fix started on main gets a fix branch`() {
        val fix = engine.featureTemplate + mapOf("id" to "fix", "name" to "fix (keel)")
        engine.extraTemplates += fix
        try {
            val (pid, root) = newProject("fix-branch")
            post("/api/projects/$pid/flows", mapOf("workflow_id" to "fix", "title" to "Average is wrong")).andExpect(status().isOk)
            assertThat(git(root, "rev-parse", "--abbrev-ref", "HEAD").trim()).isEqualTo("fix/average-is-wrong")
        } finally {
            engine.extraTemplates -= fix
        }
    }

    @Test
    fun `a start the engine refuses leaves the checkout on its own branch and drops the new one`() {
        val fix = engine.featureTemplate + mapOf("id" to "fix", "name" to "fix (keel)")
        engine.extraTemplates += fix
        engine.threadRefusal = 409 to mapOf("error" to "This workflow needs Database.")
        try {
            val (pid, root) = newProject("branch-undo")
            post("/api/projects/$pid/flows", mapOf("workflow_id" to "fix", "title" to "Average is wrong")).andExpect(status().is4xxClientError)
            assertThat(git(root, "rev-parse", "--abbrev-ref", "HEAD").trim()).isEqualTo("main")
            assertThat(git(root, "branch", "--list", "fix/*").trim()).isEmpty()
        } finally {
            engine.threadRefusal = null
            engine.extraTemplates -= fix
        }
    }

    @Test
    fun `a flow the engine gave its own worktree records it instead of the parent's`() {
        val (pid, _) = newProject("fix-own-worktree")
        engine.nextThreadIds.add("t-hunt-next")
        post("/api/projects/$pid/flows", mapOf("workflow_id" to "feature", "title" to "Hunt next", "allow_fake" to true)).andExpect(status().isOk)
        post("/internal/events", listOf(mapOf("type" to "thread.started", "thread_id" to "t-fix-own", "project_id" to pid,
            "at" to java.time.Instant.now().toString(), "data" to mapOf("title" to "F-001: ranks", "workflow_id" to "fix",
                "parent" to mapOf("thread_id" to "t-hunt-next"),
                "worktree" to mapOf("name" to "flow-f-001-ranks-abc123", "branch" to "fix/f-001-ranks", "base" to "main")))),
            mapOf("X-Keel-Token" to TOKEN)).andExpect(status().isOk)
        val row = jdbc.queryForMap("SELECT worktree, branch FROM threads WHERE id = 't-fix-own'")
        assertThat(row["worktree"]).isEqualTo("flow-f-001-ranks-abc123")
        assertThat(row["branch"]).isEqualTo("fix/f-001-ranks")
    }
}
