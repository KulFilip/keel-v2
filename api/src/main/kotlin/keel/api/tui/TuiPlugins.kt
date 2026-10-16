package keel.api.tui

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory
import keel.api.pluginhost.PluginHost
import keel.api.projects.ProjectService
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.nio.file.Files
import java.nio.file.Path

/**
 * keel 0.18.3 what plugins add to keel TUI (docs/plugins/25-tui-plugins.md): commands and a panel, written as data in
 * the plugin's manifest under `contributes.tui`, never code. Each one calls the plugin's own api routes and says how
 * the answer reads. keel TUI asks GET /api/tui/plugins?project=<id> at start; this checks every entry again (the
 * names, the paths, POST only with a question first) and leaves a wrong one out with the reason.
 */
data class TuiCall(val method: String = "GET", val path: String = "", val body: Map<String, Any?>? = null)

data class TuiShow(
    /** a template for the first line: {field} of the answer ({a.b} for a nested one) */
    val title: String? = null,
    /** the answer's list to show line by line: a field name, or "." when the answer is the list */
    val items: String? = null,
    /** the template of one item's line */
    val line: String? = null,
    /** a field that holds a unified diff, shown with line numbers and colours */
    val diff: String? = null,
    /** what to say when the list is empty */
    val empty: String? = null,
    val max: Int? = null,
)

data class TuiAction(val summary: String = "", val call: TuiCall = TuiCall(), val show: TuiShow = TuiShow(), val confirm: String? = null)

data class TuiCommand(
    val name: String = "",
    val args: String? = null,
    val summary: String = "",
    /** subcommands by their first word (/git status, /git log); or one call for the whole command */
    val sub: Map<String, TuiAction>? = null,
    val call: TuiCall? = null,
    val show: TuiShow? = null,
    val confirm: String? = null,
)

data class TuiPanel(val title: String = "", val key: String? = null, val every: Int = 10, val call: TuiCall = TuiCall(), val show: TuiShow = TuiShow())

data class TuiPluginView(val name: String, val title: String, val version: String, val commands: List<TuiCommand>, val panel: TuiPanel?)
data class TuiProblem(val plugin: String, val error: String)
data class TuiPlugins(val plugins: List<TuiPluginView>, val problems: List<TuiProblem>)

@Service
class TuiPluginService(private val host: PluginHost, private val jdbc: JdbcTemplate, private val projects: ProjectService) {
    private val yaml = ObjectMapper(YAMLFactory()).findAndRegisterModules()

    fun list(pid: String?): TuiPlugins {
        val on = pid?.let { projects.require(it); turnedOn(it) }
        val views = mutableListOf<TuiPluginView>()
        val problems = mutableListOf<TuiProblem>()
        for (p in host.plugins) {
            val manifest = runCatching { yaml.readTree(Files.readString(Path.of(p.dir).resolve("keel-plugin.yml"))) }.getOrNull() ?: continue
            val tui = manifest.path("contributes").path("tui")
            if (tui.isMissingNode || tui.isNull) continue
            // a plugin turned on per project adds its commands only where it is on
            if (manifest.path("per_project").asBoolean(false) && on != null && p.name !in on) continue
            try {
                views += check(p.name, p.title.ifBlank { p.name }, p.version, tui)
            } catch (e: IllegalArgumentException) {
                problems += TuiProblem(p.name, e.message ?: "contributes.tui is not valid")
            }
        }
        return TuiPlugins(views.sortedBy { it.name }, problems)
    }

    /** The plugins turned on for this project (or for every project), from core's project_plugins table: core reads the
     *  table itself, as keel's fence wants (it never calls a plugin's package). */
    private fun turnedOn(pid: String): Set<String> {
        val rows = jdbc.query("SELECT project_id, plugin, enabled FROM project_plugins WHERE project_id IN (?, '*')",
            { rs, _ -> Triple(rs.getString(1), rs.getString(2), rs.getInt(3) == 1) }, pid)
        val here = rows.filter { it.first == pid }.associate { it.second to it.third }
        val all = rows.filter { it.first == "*" }.associate { it.second to it.third }
        return (here.keys + all.keys).filter { here[it] ?: all[it] ?: false }.toSet()
    }

    /** One plugin's contributes.tui, checked; IllegalArgumentException says what is wrong. */
    fun check(name: String, title: String, version: String, tui: JsonNode): TuiPluginView {
        fun <T> read(node: JsonNode, type: Class<T>, what: String): T = try {
            yaml.treeToValue(node, type)
        } catch (e: Exception) {
            throw IllegalArgumentException("$what: ${e.message?.lineSequence()?.first()?.substringBefore(" (class")}")
        }
        val commands = (tui.path("commands").takeIf { it.isArray } ?: yaml.createArrayNode()).map { read(it, TuiCommand::class.java, "a command") }
        val panel = tui.path("panel").takeIf { it.isObject }?.let { read(it, TuiPanel::class.java, "the panel") }
        require(commands.size <= 10) { "at most 10 commands" }
        for (c in commands) {
            require(NAME.matches(c.name) && (c.name == name || c.name.startsWith("$name-"))) {
                "the command '${c.name}' must be named $name or $name-<word>"
            }
            require(c.summary.isNotBlank() && c.summary.length <= 120) { "/${c.name} needs a summary (at most 120 characters)" }
            require((c.sub != null) != (c.call != null)) { "/${c.name} has either sub (subcommands) or one call" }
            c.call?.let { call(name, "/${c.name}", it, c.confirm) }
            c.sub?.forEach { (word, a) ->
                require(WORD.matches(word)) { "/${c.name} $word: a subcommand is one word (a-z, 0-9, -)" }
                call(name, "/${c.name} $word", a.call, a.confirm)
            }
        }
        panel?.let {
            require(it.title.isNotBlank()) { "the panel needs a title" }
            require(it.key == null || Regex("^[a-z]$").matches(it.key) && it.key !in TAKEN_KEYS) {
                "the panel's key is one letter (Ctrl+<key>), not one of keel's own (${TAKEN_KEYS.joinToString()})"
            }
            require(it.every in 5..3600) { "the panel's every is 5 to 3600 seconds" }
            require(it.call.method == "GET") { "the panel only reads (GET)" }
            call(name, "the panel", it.call, null)
        }
        return TuiPluginView(name, title, version, commands, panel)
    }

    private fun call(plugin: String, where: String, c: TuiCall, confirm: String?) {
        require(c.method == "GET" || c.method == "POST") { "$where: the method is GET or POST" }
        require(c.method == "GET" || !confirm.isNullOrBlank()) { "$where changes something (POST): it needs a confirm question" }
        val path = c.path.substringBefore('?')
        require(path.startsWith("/projects/{pid}/$plugin/") || path == "/projects/{pid}/$plugin" || path.startsWith("/$plugin/")) {
            "$where may only call the plugin's own routes (/projects/{pid}/$plugin/…), not ${c.path}"
        }
        require(!c.path.contains("..") && !c.path.contains("://") && !c.path.contains("//")) { "$where: ${c.path} is not a plain path" }
    }

    companion object {
        private val NAME = Regex("^[a-z][a-z0-9-]{0,31}$")
        private val WORD = Regex("^[a-z][a-z0-9-]{0,23}$")
        /** Ctrl+F, Ctrl+A, Ctrl+B are keel TUI's panels; Ctrl+C quits, Ctrl+U clears the line */
        val TAKEN_KEYS = listOf("a", "b", "c", "f", "u")
    }
}

@RestController
class TuiPluginController(private val tui: TuiPluginService) {
    @GetMapping("/api/tui/plugins")
    fun list(@RequestParam(required = false) project: String?): TuiPlugins = tui.list(project?.ifBlank { null })
}
