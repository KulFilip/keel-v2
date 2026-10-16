package keel.api

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import keel.api.common.KeelProperties
import keel.api.pluginhost.PluginHost
import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import java.nio.file.Files
import java.nio.file.Path

/** keel 0.18.3 what plugins add to keel TUI (contributes.tui, docs/plugins/25-tui-plugins.md): checked, per project. */
class TuiPluginsApiTest : ApiTest() {
    @Autowired lateinit var host: PluginHost
    @Autowired lateinit var props: KeelProperties

    private fun plugin(name: String, manifest: String): Map<String, Any> {
        val dir = Files.createTempDirectory("tui-plugin-$name")
        Files.writeString(dir.resolve("keel-plugin.yml"), manifest)
        return mapOf("name" to name, "title" to name.replaceFirstChar { it.uppercase() }, "version" to "1.0.0", "source" to "image", "dir" to dir.toString())
    }

    private fun <T> withPlugins(vararg plugins: Map<String, Any>, block: () -> T): T {
        val run = Files.createDirectories(props.dataDir.resolve("plugins").resolve("run"))
        val file = run.resolve("resolved.json")
        Files.writeString(file, jacksonObjectMapper().writeValueAsString(mapOf("sdk" to 1, "mode" to "on", "plugins" to plugins.toList(), "problems" to emptyList<Any>())))
        host.reload()
        try {
            return block()
        } finally {
            Files.deleteIfExists(file)
            host.reload()
        }
    }

    private val repo: Path = Path.of(System.getProperty("user.dir")).parent

    @Test
    fun `the git plugin's commands and branch panel, only where git is on`() {
        val git = plugin("git", Files.readString(repo.resolve("plugins/git/keel-plugin.yml")))
        withPlugins(git) {
            val (pid, _) = newProject("tui-git")
            assertThat(get("/api/tui/plugins?project=$pid").andExpect(status().isOk).json()["plugins"]).isEmpty()   // git is off here
            put("/api/projects/$pid/plugins/git", mapOf("enabled" to true)).andExpect(status().isOk)
            val body = get("/api/tui/plugins?project=$pid").json()
            val p = body["plugins"][0]
            assertThat(p["name"].asText()).isEqualTo("git")
            val cmd = p["commands"][0]
            assertThat(cmd["name"].asText()).isEqualTo("git")
            assertThat(cmd["sub"].fieldNames().asSequence().toList()).containsExactly("status", "log", "diff")
            assertThat(cmd["sub"]["status"]["call"]["path"].asText()).isEqualTo("/projects/{pid}/git/status")
            assertThat(cmd["sub"]["diff"]["show"]["diff"].asText()).isEqualTo("diff")
            assertThat(p["panel"]["key"].asText()).isEqualTo("g")
            assertThat(body["problems"]).isEmpty()
        }
    }

    @Test
    fun `a wrong entry is left out with the reason, and another plugin's routes are not reachable`() {
        val sneaky = plugin("notes", """
            name: notes
            contributes:
              tui:
                commands:
                  - name: notes
                    summary: reads the database
                    call: { path: "/projects/{pid}/db/query" }
        """.trimIndent())
        val pushy = plugin("pushy", """
            name: pushy
            contributes:
              tui:
                commands:
                  - name: pushy
                    summary: pushes
                    call: { method: POST, path: "/projects/{pid}/pushy/push" }
        """.trimIndent())
        val odd = plugin("odd", "name: odd\ncontributes:\n  tui:\n    commands:\n      - { name: odd, summary: x, call: { path: /odd/x }, color: red }\n")
        val none = plugin("quiet", "name: quiet\n")
        withPlugins(sneaky, pushy, odd, none) {
            val body = get("/api/tui/plugins").json()
            assertThat(body["plugins"]).isEmpty()
            val problems = body["problems"].associate { it["plugin"].asText() to it["error"].asText() }
            assertThat(problems["notes"]).isEqualTo("/notes may only call the plugin's own routes (/projects/{pid}/notes/…), not /projects/{pid}/db/query")
            assertThat(problems["pushy"]).isEqualTo("/pushy changes something (POST): it needs a confirm question")
            assertThat(problems["odd"]).startsWith("a command:").contains("color")
            assertThat(problems).doesNotContainKey("quiet")
        }
    }
}
