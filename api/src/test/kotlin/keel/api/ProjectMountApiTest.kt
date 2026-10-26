package keel.api

import keel.api.projects.HostMount
import keel.api.projects.ProjectService
import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.jdbc.core.JdbcTemplate
import java.nio.file.Files
import java.nio.file.Path

/**
 * 0.18.57 one project folder on the person's computer is one keel project, however keel2 mounts it: the plain start
 * mounts it at /workspace, --docker at its own path, native runs on it. Switching to --docker hid the project and made
 * "<name>-2", without its Jira connection, caps or history.
 */
class ProjectMountApiTest : ApiTest() {
    @Autowired lateinit var projectService: ProjectService
    @Autowired lateinit var jdbc: JdbcTemplate

    private val saved by lazy { projectService.mount }

    @AfterEach
    fun back() { projectService.mount = saved }

    private fun repo(at: Path): Path {
        Files.createDirectories(at)
        git(at, "init", "-q", "-b", "main")
        Files.writeString(at.resolve("README.md"), "# shop\n")
        git(at, "add", "-A")
        git(at, "commit", "-q", "-m", "first commit")
        return at
    }

    private fun ids() = get("/api/projects").json().map { it["id"].asText() }

    @Test
    fun `a repo in the workspace keeps its project when keel2 switches to --docker`() {
        saved
        val host = Files.createTempDirectory("host-projects")          // ~/Projects on the person's computer
        val plain = Files.createTempDirectory("plain-workspace")      // /workspace: the same folder, mounted
        // plain start: keel2 start ~/Projects mounts it at /workspace; the repo in it is a project
        projectService.mount = HostMount(plain.toString(), host.toString())
        val first = projectService.register(repo(plain.resolve("shop-b10")).toString())
        jdbc.update("INSERT INTO jira_connections(project_id, json, updated_at) VALUES (?, '{}', '2026-10-26T00:00:00Z')", first.id)
        // keel2 start --docker ~/Projects: the same folder at its own path; /workspace is empty now
        plain.resolve("shop-b10").toFile().deleteRecursively()
        projectService.mount = HostMount(host.toString(), host.toString())
        val again = projectService.register(repo(host.resolve("shop-b10")).toString())
        assertThat(again.id).isEqualTo(first.id)
        assertThat(again.root).isEqualTo(host.resolve("shop-b10").toString())
        assertThat(ids()).contains(first.id).doesNotContain("${first.id}-2")
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM jira_connections WHERE project_id = ?", Int::class.java, first.id)).isEqualTo(1)
        // and back to the plain start: still the same project
        host.resolve("shop-b10").toFile().deleteRecursively()
        projectService.mount = HostMount(plain.toString(), host.toString())
        val back = projectService.register(repo(plain.resolve("shop-b10")).toString())
        assertThat(back.id).isEqualTo(first.id)
    }

    @Test
    fun `a project registered before keel knew host paths is found from the plain mount`() {
        saved
        val host = Files.createTempDirectory("host-projects")
        // 0.18.56 and older saved only /workspace/<repo>: no host path was known
        jdbc.update("INSERT INTO projects(id, name, root, created_at) VALUES ('legacy-b10', 'legacy-b10', '/workspace/legacy-b10', '2026-10-01T00:00:00Z')")
        projectService.mount = HostMount(host.toString(), host.toString())
        val again = projectService.register(repo(host.resolve("legacy-b10")).toString())
        assertThat(again.id).isEqualTo("legacy-b10")
    }

    @Test
    fun `the main project keeps its project across modes, also under another name`() {
        saved
        val host = repo(Files.createTempDirectory("host").resolve("ana-shop"))
        val plain = repo(Files.createTempDirectory("plain").resolve("workspace"))
        projectService.mount = HostMount(plain.toString(), host.toString())
        val first = projectService.registerWorkspace(plain.toString(), "ana-shop")
        // --docker: the folder at its own path; keel2 named it differently this time (KEEL_PROJECT_NAME)
        plain.toFile().deleteRecursively()
        projectService.mount = HostMount(host.toString(), host.toString())
        val again = projectService.registerWorkspace(host.toString(), "Ana Shop (docker)")
        assertThat(again.id).isEqualTo(first.id)
        assertThat(again.root).isEqualTo(host.toString())
    }

    @Test
    fun `another folder with the same name is another project`() {
        saved
        val hostA = Files.createTempDirectory("host-a")
        val hostB = Files.createTempDirectory("host-b")
        val plain = Files.createTempDirectory("plain-workspace")
        projectService.mount = HostMount(plain.toString(), hostA.toString())
        val a = projectService.register(repo(plain.resolve("bo-shop")).toString())
        plain.resolve("bo-shop").toFile().deleteRecursively()
        projectService.mount = HostMount(hostB.toString(), hostB.toString())
        val b = projectService.register(repo(hostB.resolve("bo-shop")).toString())
        assertThat(b.id).isNotEqualTo(a.id)
    }
}
