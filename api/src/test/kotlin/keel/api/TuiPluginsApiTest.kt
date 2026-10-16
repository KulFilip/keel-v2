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

/** keel 0.18.3 what plugins add to keel TUI (contributes.tui, docs/plugins/25-tui-plugins.md): checked, per project.
 *  0.18.6 its modes (contributes.tui.modes): a full-screen view as data, the Code Review plugin's review mode. */
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

    @Test
    fun `the review plugin's mode - its state, list, detail with notes and keys - and its commands outside the mode`() {
        val review = plugin("review", Files.readString(repo.resolve("plugins/review/keel-plugin.yml")))
        withPlugins(review) {
            val (pid, _) = newProject("tui-review")
            put("/api/projects/$pid/plugins/review", mapOf("enabled" to true)).andExpect(status().isOk)
            val body = get("/api/tui/plugins?project=$pid").andExpect(status().isOk).json()
            assertThat(body["problems"]).isEmpty()
            val p = body["plugins"][0]
            assertThat(p["commands"][0]["sub"].fieldNames().asSequence().toList()).containsExactly("prs", "branch")
            val m = p["modes"][0]
            assertThat(m["name"].asText()).isEqualTo("review")
            assertThat(m["title"].asText()).isEqualTo("Code Review")
            assertThat(m["state"].fieldNames().asSequence().toList()).containsExactly("view", "ai")      // in order: ai reads {view.key}
            assertThat(m["state"]["view"]["path"].asText()).isEqualTo("/projects/{pid}/review/open?ref={arg}")
            assertThat(m["list"]["items"].asText()).isEqualTo("view.files")
            assertThat(m["list"]["mark"]["list"].asText()).isEqualTo("view.viewed")
            assertThat(m["detail"]["diff"].asText()).isEqualTo("diff")
            assertThat(m["detail"]["notes"].map { it["items"].asText() }).containsExactly("view.threads", "view.drafts", "ai.findings.result.findings")
            val keys = m["keys"].associateBy { it["key"].asText() }
            assertThat(keys.keys).containsExactly("c", "r", "x", "v", "e", "f", "o", "F", "s", "p", "g")
            assertThat(keys["c"]!!["view"].asText()).isEqualTo("detail")
            assertThat(keys["c"]!!["call"]["body"]["line"].asText()).isEqualTo("{line}")
            assertThat(keys["s"]!!["pick"]["choices"].map { it["value"].asText() }).containsExactly("APPROVE", "REQUEST_CHANGES", "COMMENT")
            assertThat(keys["s"]!!["confirm"].asText()).startsWith("Send \"{choice.label}\"")
            assertThat(keys["p"]!!["open"].asText()).isEqualTo("{choice.number}")
            assertThat(keys["g"]!!["reload"].asBoolean()).isTrue()
        }
    }

    @Test
    fun `a mode's rules - own routes, reads only for its state, a question before a change, keel TUI's keys stay its own`() {
        fun mode(name: String, extra: String) = plugin(name, """
            name: $name
            contributes:
              tui:
                modes:
                  - name: $name
                    title: Notes
                    summary: the notes
                    state:
                      all: { path: "/projects/{pid}/$name/list" }
                    list: { items: all, line: "{title}" }
        """.trimIndent() + "\n" + extra.trimIndent().prependIndent("        "))
        val ok = mode("good", """
            keys:
              - { key: d, label: delete, confirm: "Delete {item.title}?", call: { method: POST, path: "/projects/{pid}/good/delete/{item.id}" }, reload: true }
              - { key: a, label: add, ask: "The note", call: { method: POST, path: "/projects/{pid}/good/add", body: { text: "{text}" } } }
        """)
        val pushy = mode("pushy", "keys:\n  - { key: d, label: delete, call: { method: POST, path: \"/projects/{pid}/pushy/delete\" } }")
        val taken = mode("taken", "keys:\n  - { key: q, label: quit, reload: true }")
        val sneaky = mode("sneaky", "detail: { call: { path: \"/projects/{pid}/db/query\" }, text: \"{rows}\" }")
        val writer = plugin("writer", """
            name: writer
            contributes:
              tui:
                modes:
                  - name: writer
                    title: W
                    summary: w
                    state: { all: { method: POST, path: "/projects/{pid}/writer/list" } }
                    list: { items: all, line: "{title}" }
        """.trimIndent())
        val clash = plugin("clash", """
            name: clash
            contributes:
              tui:
                commands:
                  - { name: clash, summary: one call, call: { path: "/projects/{pid}/clash/x" } }
                modes:
                  - { name: clash, title: C, summary: c, state: { all: { path: "/projects/{pid}/clash/list" } }, list: { items: all, line: "{t}" } }
        """.trimIndent())
        withPlugins(ok, pushy, taken, sneaky, writer, clash) {
            val body = get("/api/tui/plugins").json()
            assertThat(body["plugins"].map { it["name"].asText() }).containsExactly("good")
            assertThat(body["plugins"][0]["modes"][0]["keys"].size()).isEqualTo(2)
            val problems = body["problems"].associate { it["plugin"].asText() to it["error"].asText() }
            assertThat(problems["pushy"]).isEqualTo("the mode /pushy key d changes something (POST): it needs confirm (a yes/no question) or ask (the person's own words)")
            assertThat(problems["taken"]).isEqualTo("the mode /taken: a key is one letter or digit, not one of the mode's own (j, k, q)")
            assertThat(problems["sneaky"]).isEqualTo("the mode /sneaky detail may only call the plugin's own routes (/projects/{pid}/sneaky/…), not /projects/{pid}/db/query")
            assertThat(problems["writer"]).isEqualTo("the mode /writer state all only reads (GET)")
            assertThat(problems["clash"]).isEqualTo("/clash is a mode and a command: the command has sub (its words run outside the mode)")
        }
    }
}
