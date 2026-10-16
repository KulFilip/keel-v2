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
 * keel 0.18.6 a plugin's modes: a full-screen view of its own (a list, a detail per item, keys), still only data.
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
    /** 0.18.6 a template for a block of text (under the title) */
    val text: String? = null,
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

/** 0.18.6 a mode's list item mark: `text` when the item's `field` is in the list at `list` (strings, or items with that field). */
data class ModeMark(val list: String = "", val field: String = "", val text: String = "")

/** The mode's list: the items (a path into the mode's state), one line each. */
data class ModeList(val title: String? = null, val items: String = "", val line: String = "", val mark: ModeMark? = null, val empty: String? = null)

/** Notes under the detail's lines: the items at `items` whose `path` field is the open item's path and whose `line`
 *  field is the line's number (`side`: the field that says RIGHT or LEFT), each as `text`. */
data class ModeNote(val items: String = "", val path: String = "path", val line: String = "line", val side: String? = null, val text: String = "",
                    val tone: String? = null)

/** The detail of one item: a GET call, and the answer's diff (a field) or text (a template), with notes under lines. */
data class ModeDetail(val title: String? = null, val call: TuiCall = TuiCall(), val diff: String? = null, val text: String? = null,
                      val notes: List<ModeNote> = emptyList())

data class ModeChoice(val label: String = "", val value: String = "")

/** Pick one first: the items at `items` of a GET call's answer (or of the mode's state without a call), filtered by
 *  `match` (field: template), one `line` each; or one of `choices`. The chosen one is {choice}. */
data class ModePick(val title: String = "", val call: TuiCall? = null, val items: String? = null, val line: String? = null,
                    val match: Map<String, String>? = null, val choices: List<ModeChoice>? = null)

/** A key in the mode: pick, ask, confirm, then call; then show the answer, read the state again or open the mode anew. */
data class ModeKey(
    val key: String = "",
    val label: String = "",
    /** where it works: list, detail or both (the default) */
    val view: String? = null,
    val pick: ModePick? = null,
    /** a question the person answers with text: {text} */
    val ask: String? = null,
    /** a yes/no question first */
    val confirm: String? = null,
    val call: TuiCall? = null,
    val show: TuiShow? = null,
    /** read the mode's state (and the open detail) again afterwards */
    val reload: Boolean = false,
    /** open the mode again with this argument (a template) */
    val open: String? = null,
    /** what to say when it worked (a template; {answer.x} is the call's answer) */
    val done: String? = null,
)

/** 0.18.6 a plugin's mode: /<name> [args] takes keel TUI's screen (keel's header and status line stay) until Esc. */
data class TuiMode(
    val name: String = "",
    val title: String = "",
    val args: String? = null,
    val summary: String = "",
    /** GET calls read in order when the mode opens; each answer is in the templates under its name ({view.key}) */
    val state: Map<String, TuiCall> = emptyMap(),
    /** a template for the mode's status line */
    val status: String? = null,
    val list: ModeList = ModeList(),
    val detail: ModeDetail? = null,
    val keys: List<ModeKey> = emptyList(),
)

data class TuiPluginView(val name: String, val title: String, val version: String, val commands: List<TuiCommand>, val panel: TuiPanel?,
                         val modes: List<TuiMode> = emptyList())
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
        val modes = (tui.path("modes").takeIf { it.isArray } ?: yaml.createArrayNode()).map { read(it, TuiMode::class.java, "a mode") }
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
        require(modes.size <= 4) { "at most 4 modes" }
        for (m in modes) mode(name, m, commands)
        return TuiPluginView(name, title, version, commands, panel, modes)
    }

    /** One mode: its name like a command's, only GET reads for its state, list and detail, and keys keel TUI does not use;
     *  a key that changes something (POST) asks first: a confirm question, or text the person types (ask). */
    private fun mode(plugin: String, m: TuiMode, commands: List<TuiCommand>) {
        val at = "the mode /${m.name}"
        require(NAME.matches(m.name) && (m.name == plugin || m.name.startsWith("$plugin-"))) { "the mode '${m.name}' must be named $plugin or $plugin-<word>" }
        require(m.title.isNotBlank() && m.title.length <= 40) { "$at needs a title (at most 40 characters)" }
        require(m.summary.isNotBlank() && m.summary.length <= 120) { "$at needs a summary (at most 120 characters)" }
        commands.firstOrNull { it.name == m.name }?.let {
            require(it.sub != null) { "/${m.name} is a mode and a command: the command has sub (its words run outside the mode)" }
        }
        require(m.state.isNotEmpty() && m.state.size <= 5) { "$at reads its state with 1 to 5 calls" }
        m.state.forEach { (k, c) ->
            require(WORD.matches(k) && k !in VARS) { "$at: the state's name '$k' is one word, not one of ${VARS.joinToString()}" }
            read(plugin, "$at state $k", c)
        }
        require(m.list.items.isNotBlank() && m.list.line.isNotBlank()) { "$at: its list needs items and line" }
        m.list.mark?.let { require(it.list.isNotBlank() && it.field.isNotBlank() && it.text.isNotBlank()) { "$at: a list mark needs list, field and text" } }
        m.detail?.let { d ->
            read(plugin, "$at detail", d.call)
            require((d.diff == null) != (d.text == null)) { "$at: its detail shows either a diff or a text" }
            require(d.notes.size <= 5) { "$at: at most 5 kinds of notes" }
            for (n in d.notes) {
                require(n.items.isNotBlank() && n.text.isNotBlank()) { "$at: a note needs items and text" }
                require(n.tone == null || n.tone in TONES) { "$at: a note's tone is one of ${TONES.joinToString()}" }
            }
        }
        require(m.keys.size <= 20) { "$at: at most 20 keys" }
        require(m.keys.map { it.key }.toSet().size == m.keys.size) { "$at: a key is used twice" }
        for (k in m.keys) {
            val w = "$at key ${k.key}"
            require(Regex("^[a-zA-Z0-9]$").matches(k.key) && k.key !in MODE_KEYS) {
                "$at: a key is one letter or digit, not one of the mode's own (${MODE_KEYS.joinToString()})"
            }
            require(k.label.isNotBlank() && k.label.length <= 24) { "$w needs a label (at most 24 characters)" }
            require(k.view == null || k.view in setOf("list", "detail", "both")) { "$w: view is list, detail or both" }
            require(k.call != null || k.show != null || k.reload || k.open != null) { "$w does nothing: it needs a call, show, reload or open" }
            k.pick?.let { p ->
                require(p.title.isNotBlank()) { "$w: its pick needs a title" }
                require((p.choices != null) != (p.call != null || p.items != null)) {
                    "$w: its pick reads items (from its call's answer, or from the state) or has choices"
                }
                require(p.choices != null || !p.line.isNullOrBlank()) { "$w: its pick needs a line for each item" }
                p.call?.let { read(plugin, "$w pick", it) }
                p.choices?.let { cs -> require(cs.isNotEmpty() && cs.size <= 9 && cs.all { it.label.isNotBlank() }) { "$w: 1 to 9 choices, each with a label" } }
            }
            k.call?.let { c ->
                require(c.method == "GET" || !k.confirm.isNullOrBlank() || !k.ask.isNullOrBlank()) {
                    "$w changes something (POST): it needs confirm (a yes/no question) or ask (the person's own words)"
                }
                call(plugin, w, c, "asks first")
            }
        }
    }

    private fun read(plugin: String, where: String, c: TuiCall) {
        require(c.method == "GET") { "$where only reads (GET)" }
        call(plugin, where, c, null)
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
        /** a mode's own keys (besides arrows, Enter, Esc, PgUp/PgDn, Tab): j/k move, q leaves */
        val MODE_KEYS = listOf("j", "k", "q")
        /** the names templates give keel TUI's own values; a state call cannot take one */
        val VARS = listOf("pid", "arg", "item", "line", "side", "text", "choice", "answer")
        val TONES = listOf("accent", "dim", "warn", "bad", "ok")
    }
}

@RestController
class TuiPluginController(private val tui: TuiPluginService) {
    @GetMapping("/api/tui/plugins")
    fun list(@RequestParam(required = false) project: String?): TuiPlugins = tui.list(project?.ifBlank { null })
}
