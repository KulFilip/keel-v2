package keel.api.wiki

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/** 0.17.3 a spec's build status (docs/plugins/24-wiki-sections-spec-status.md): which flow built each spec, from the
 *  file history's rows and the flows' saved state. */
class SpecStatusApiTest : ApiTest() {

    @Autowired lateinit var jdbc: JdbcTemplate

    private fun spec(title: String, acs: Int) = "# $title\n\n" + (1..acs).joinToString("") { "- **AC-$it** [API] rule $it holds\n" }

    private fun project(name: String) = newProject(name, mapOf(
        "docs/specs/built.md" to spec("Built", 2), "docs/specs/running.md" to spec("Running", 1),
        "docs/specs/stopped.md" to spec("Stopped", 3), "docs/specs/old.md" to spec("Old", 1),
        "docs/specs/never.md" to spec("Never", 2),
    )).first

    /** A flow as keel stores it (status, phase, saved state); `spec` puts the spec path in its state. */
    private fun flow(pid: String, tid: String, status: String, created: String, spec: String? = null, phase: String = "red",
                     waiting: String? = null, worktree: String? = null, hidden: Boolean = false) {
        val state = mapper.writeValueAsString(mapOf("thread_id" to tid, "status" to status, "phase" to phase, "spec" to spec,
            "waiting" to waiting?.let { mapOf("step" to "ac_gate", "title" to it) }))
        jdbc.update("INSERT INTO threads(id, project_id, workflow_id, title, status, phase, state_json, worktree, hidden_at, created_at, updated_at) " +
            "VALUES (?, ?, 'feature', ?, ?, ?, ?, ?, ?, ?, ?)", tid, pid, "flow $tid", status, phase, state, worktree,
            if (hidden) created else null, created, created)
    }

    /** A version of a spec written by a flow (the file history, 0.15.9). */
    private fun wrote(pid: String, tid: String, path: String, version: Int = 1) {
        jdbc.update("INSERT INTO doc_versions(id, project_id, path, kind, version, sha256, size, by_kind, thread_id, at) " +
            "VALUES (?, ?, ?, 'spec', ?, 'x', 1, 'agent', ?, '2026-10-14T10:00:00Z')", "dv-$tid-$version-${path.hashCode()}", pid, path, version, tid)
    }

    private fun status(pid: String) = get("/api/projects/$pid/specs/status").andExpect(status().isOk).json()
        .associateBy { it["path"].asText() }

    @Test
    fun `built, in progress, stopped and resumable, not built`() {
        val pid = project("spec-status-states")
        flow(pid, "t-built", "done", "2026-10-01T10:00:00Z")
        wrote(pid, "t-built", "docs/specs/built.md")
        wrote(pid, "t-built", "docs/specs/built.md", 2)
        flow(pid, "t-run", "waiting", "2026-10-02T10:00:00Z", spec = "docs/specs/running.md", waiting = "AC-1 gate", worktree = "wt-run")
        flow(pid, "t-stop", "stopped", "2026-10-03T10:00:00Z", spec = "docs/specs/stopped.md")
        val s = status(pid)
        assertThat(s.keys).containsExactlyInAnyOrder("docs/specs/built.md", "docs/specs/running.md", "docs/specs/stopped.md",
            "docs/specs/old.md", "docs/specs/never.md")

        val built = s.getValue("docs/specs/built.md")
        assertThat(built["state"].asText()).isEqualTo("built")
        assertThat(built["spec"].asText()).isEqualTo("spec:docs/specs/built.md")
        assertThat(built["title"].asText()).isEqualTo("Built")
        assertThat(built["acs"].asInt()).isEqualTo(2)
        assertThat(built["thread_id"].asText()).isEqualTo("t-built")
        assertThat(built["workflow"].asText()).isEqualTo("feature")
        assertThat(built["flows"].map { it["thread_id"].asText() }).containsExactly("t-built")

        val running = s.getValue("docs/specs/running.md")
        assertThat(running["state"].asText()).isEqualTo("in_progress")
        assertThat(running["status"].asText()).isEqualTo("waiting")
        assertThat(running["phase"].asText()).isEqualTo("red")
        assertThat(running["waiting"].asText()).isEqualTo("AC-1 gate")

        val stopped = s.getValue("docs/specs/stopped.md")
        assertThat(stopped["state"].asText()).isEqualTo("stopped")
        assertThat(stopped["resumable"].asBoolean()).isTrue()        // the project's newest flow
        assertThat(stopped["why"].isNull).isTrue()

        val never = s.getValue("docs/specs/never.md")
        assertThat(never["state"].asText()).isEqualTo("not_built")
        assertThat(never["thread_id"].isNull).isTrue()
        assertThat(never["flows"].size()).isZero()
    }

    @Test
    fun `a stopped flow that is not the last one cannot be resumed and says why`() {
        val pid = project("spec-status-not-resumable")
        flow(pid, "t-old-stop", "stopped", "2026-10-01T10:00:00Z", spec = "docs/specs/stopped.md", worktree = "wt-1")
        flow(pid, "t-newer", "done", "2026-10-05T10:00:00Z", spec = "docs/specs/built.md")
        val stopped = status(pid).getValue("docs/specs/stopped.md")
        assertThat(stopped["state"].asText()).isEqualTo("stopped")
        assertThat(stopped["resumable"].asBoolean()).isFalse()
        assertThat(stopped["why"].asText()).contains("only the last stopped flow can be resumed")
    }

    @Test
    fun `several flows on one spec - the one that runs wins, the list is newest first, a hidden run is left out`() {
        val pid = project("spec-status-several")
        flow(pid, "t-1", "running", "2026-10-01T10:00:00Z", spec = "docs/specs/old.md", phase = "green")
        flow(pid, "t-2", "stopped", "2026-10-02T10:00:00Z")
        wrote(pid, "t-2", "docs/specs/old.md")
        flow(pid, "t-3", "done", "2026-10-03T10:00:00Z", spec = "docs/specs/old.md")
        flow(pid, "t-hidden", "done", "2026-10-04T10:00:00Z", spec = "docs/specs/old.md", hidden = true)
        val old = status(pid).getValue("docs/specs/old.md")
        assertThat(old["state"].asText()).isEqualTo("in_progress")
        assertThat(old["thread_id"].asText()).isEqualTo("t-1")
        assertThat(old["phase"].asText()).isEqualTo("green")
        assertThat(old["flows"].map { it["thread_id"].asText() }).containsExactly("t-3", "t-2", "t-1")
        assertThat(old["flows"].map { it["state"].asText() }).containsExactly("built", "stopped", "in_progress")

        // when nothing runs, the newest flow counts
        jdbc.update("UPDATE threads SET status = 'failed' WHERE id = 't-1'")
        val after = status(pid).getValue("docs/specs/old.md")
        assertThat(after["state"].asText()).isEqualTo("built")
        assertThat(after["thread_id"].asText()).isEqualTo("t-3")
    }

    @Test
    fun `a project with no specs has an empty list, and an unknown project is not found`() {
        val (pid, _) = newProject("spec-status-empty")
        assertThat(get("/api/projects/$pid/specs/status").andExpect(status().isOk).json().size()).isZero()
        get("/api/projects/nope/specs/status").andExpect(status().isNotFound)
    }
}
