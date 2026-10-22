package keel.api.review

import com.fasterxml.jackson.databind.ObjectMapper
import keel.api.agents.AgentCatalog
import keel.api.agents.AgentService
import keel.api.common.BadRequest
import keel.api.settings.Model
import keel.api.settings.SettingKey
import keel.api.settings.SettingsSection
import keel.api.settings.SettingsService
import keel.api.workflows.WorkflowService
import org.springframework.stereotype.Component

/**
 * One extra button on every review thread. [mode] ask: one cheap model call as [agent], like "Is the reviewer right?"
 * (same model, effort and cap rules); workflow: [workflow] runs as a flow on the pull request's branch, like "Address
 * it". [prompt] is a template: {{thread}} {{file}} {{lines}} {{diff}} {{pr}}.
 */
data class ThreadButton(
    val label: String = "",
    val mode: String = "ask",
    val agent: String? = null,
    val workflow: String? = null,
    val prompt: String = "",
) {
    /** A stable id from the label (the cache and the route use it). */
    val id: String get() = label.lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-').ifEmpty { "button" }
}

/** What applies to one project: "Is the reviewer right?", "Address it" and the extra buttons. */
data class ThreadConfig(
    val judgeMode: String,
    val judgeAgent: String,
    /** null: the cheapest model keel has configured */
    val judgeModel: Model?,
    val judgeEffort: String,
    val judgeTokenCap: Int,
    val judgeAllowHarder: Boolean,
    val judgeWorkflow: String,
    val addressWorkflow: String,
    val buttons: List<ThreadButton>,
)

/**
 * The Code Review plugin's thread settings, in keel's plugin settings (`plugins.review.<key>`): keel-wide in General,
 * a project may override any key. They are checked here (keel does not check a plugin's values), on the plugin's own
 * routes: GET|PUT /api/review/settings and /api/projects/{pid}/review/settings.
 */
@Component
class ReviewThreadSettings(
    private val settings: SettingsService,
    private val agents: AgentService,
    private val catalog: AgentCatalog,
    private val workflows: WorkflowService,
    private val mapper: ObjectMapper,
) : SettingsSection {
    companion object {
        const val NAME = "review"
        /** keel's quick checker today; another branch renames it pr-reviewer, so either name finds the other */
        const val DEFAULT_AGENT = "ticket-reviewer"
        val ALIASES = mapOf("pr-reviewer" to "ticket-reviewer", "ticket-reviewer" to "pr-reviewer")
        val MODES = listOf("quick", "workflow")
        val EFFORTS = listOf("low", "medium", "high")
        const val MAX_BUTTONS = 6
        const val MAX_LABEL = 30
        const val MIN_CAP = 200
        const val MAX_CAP = 1_000_000
        val PLACEHOLDERS = setOf("thread", "file", "lines", "diff", "pr")
    }

    override val id = "review-threads"
    override val title = "Code Review threads"
    override val order = 95
    override val keys = listOf(
        SettingKey("plugins.$NAME.judge_mode", "choice", "quick", MODES),
        SettingKey("plugins.$NAME.judge_agent", "text", DEFAULT_AGENT),
        SettingKey("plugins.$NAME.judge_model", "model", null),
        SettingKey("plugins.$NAME.judge_effort", "choice", "low", EFFORTS),
        SettingKey("plugins.$NAME.judge_token_cap", "int", 25_000),
        SettingKey("plugins.$NAME.judge_allow_harder", "bool", true),
        SettingKey("plugins.$NAME.judge_workflow", "text", "review"),
        SettingKey("plugins.$NAME.address_workflow", "text", "small"),
        SettingKey("plugins.$NAME.thread_buttons", "list", emptyList<Any>()),
    )
    private val names = keys.map { it.key.removePrefix("plugins.$NAME.") }.toSet()

    private fun store() = settings.plugin(NAME)

    // ---------------------------------------------------------------- reading

    private fun model(v: Any?): Model? = v?.takeIf { it is Map<*, *> && it.isNotEmpty() }?.let { runCatching { mapper.convertValue(it, Model::class.java) }.getOrNull() }

    private fun buttons(v: Any?): List<ThreadButton> = (v as? List<*>).orEmpty().mapNotNull { runCatching { mapper.convertValue(it, ThreadButton::class.java) }.getOrNull() }

    fun config(values: Map<String, Any?>): ThreadConfig = ThreadConfig(
        judgeMode = (values["judge_mode"] as? String)?.takeIf { it in MODES } ?: "quick",
        judgeAgent = (values["judge_agent"] as? String)?.trim()?.ifEmpty { null } ?: DEFAULT_AGENT,
        judgeModel = model(values["judge_model"]),
        judgeEffort = (values["judge_effort"] as? String)?.takeIf { it in EFFORTS } ?: "low",
        judgeTokenCap = (values["judge_token_cap"] as? Number)?.toInt()?.coerceIn(MIN_CAP, MAX_CAP) ?: 25_000,
        judgeAllowHarder = values["judge_allow_harder"] as? Boolean ?: true,
        judgeWorkflow = (values["judge_workflow"] as? String)?.trim()?.ifEmpty { null } ?: "review",
        addressWorkflow = (values["address_workflow"] as? String)?.trim()?.ifEmpty { null } ?: "small",
        buttons = buttons(values["thread_buttons"]),
    )

    fun effective(pid: String): ThreadConfig = config(store().effective(pid))

    /** The agent a name means here (the alias when the name itself is not there), or null. */
    fun agentId(pid: String?, name: String): String? {
        val ids = agentIds(pid)
        return name.takeIf { it in ids } ?: ALIASES[name]?.takeIf { it in ids }
    }

    private fun agentIds(pid: String?): Set<String> =
        if (pid != null) agents.list(pid).filter { it.enabled }.map { it.id }.toSet() else catalog.defaults().map { it.id }.toSet()

    /** null: keel cannot list them now (the engine is down): the check is skipped. */
    private fun workflowIds(pid: String?): Set<String>? = runCatching {
        if (pid != null) workflows.list(pid).map { it.id }.toSet() else workflows.templates().map { it.id }.toSet()
    }.getOrNull()

    /** What the web's settings form needs: the values per scope and what the pickers offer. */
    fun view(pid: String?): Map<String, Any?> {
        val s = store()
        val defaults = names.associateWith { s.defaults()[it] }
        val general = s.general()
        val own = pid?.let { s.overrides(it) }
        val eff = defaults + general + own.orEmpty()
        val flows = runCatching { if (pid != null) workflows.list(pid).map { mapOf("id" to it.id, "name" to it.name) } else workflows.templates().map { mapOf("id" to it.id, "name" to it.name) } }
            .getOrDefault(emptyList())
        val models = (if (pid != null) settings.effective(pid) else settings.general()).let { e ->
            listOf("default" to e.defaultModel, "cheaper" to e.cheaperModel, "reviewer" to e.reviewerModel, "implementer" to e.implementerModel)
                .map { (role, m) -> mapOf("role" to role, "model" to m) }
        }
        return mapOf(
            "defaults" to defaults, "general" to general, "overrides" to own, "effective" to eff,
            "agents" to agentIds(pid).sorted(), "workflows" to flows, "models" to models,
            "limits" to mapOf("buttons" to MAX_BUTTONS, "label" to MAX_LABEL, "min_cap" to MIN_CAP, "max_cap" to MAX_CAP,
                "placeholders" to PLACEHOLDERS.sorted()),
        )
    }

    // ---------------------------------------------------------------- writing (checked)

    fun update(pid: String?, patch: Map<String, Any?>): Map<String, Any?> {
        val unknown = patch.keys - names
        if (unknown.isNotEmpty()) throw BadRequest("Unknown setting: ${unknown.joinToString()}", "Code Review takes: ${names.sorted().joinToString()}")
        val problems = patch.entries.flatMap { (k, v) -> if (v == null) emptyList() else check(pid, k, v) }
        if (problems.isNotEmpty()) throw BadRequest(problems.first(), problems.drop(1).joinToString(" ").ifBlank { null })
        val clean = patch.mapValues { (k, v) -> if (v == null) null else normal(k, v) }
        if (pid == null) store().updateGeneral(clean) else store().updateProject(pid, clean)
        return view(pid)
    }

    private fun normal(k: String, v: Any): Any? = when (k) {
        "thread_buttons" -> buttons(v).map { b ->
            mapOf("label" to b.label.trim(), "mode" to b.mode, "agent" to b.agent?.trim()?.takeIf { b.mode == "ask" },
                "workflow" to b.workflow?.trim()?.takeIf { b.mode == "workflow" }, "prompt" to b.prompt.trim())
        }
        "judge_agent", "judge_workflow", "address_workflow" -> v.toString().trim()
        else -> v
    }

    private fun check(pid: String?, k: String, v: Any): List<String> {
        val flows by lazy { workflowIds(pid) }
        fun agentOk(name: String) = agentId(pid, name) != null
        fun flowOk(id: String) = flows?.contains(id) ?: true
        return when (k) {
            "judge_mode" -> if (v !in MODES) listOf("judge_mode is quick or workflow") else emptyList()
            "judge_effort" -> if (v !in EFFORTS) listOf("judge_effort is low, medium or high") else emptyList()
            "judge_allow_harder" -> if (v !is Boolean) listOf("judge_allow_harder is true or false") else emptyList()
            "judge_token_cap" -> if (v !is Number || v.toInt() !in MIN_CAP..MAX_CAP) listOf("judge_token_cap is a number from $MIN_CAP to $MAX_CAP") else emptyList()
            "judge_model" -> if (v !is Map<*, *> || (v.isNotEmpty() && model(v) == null)) listOf("judge_model is a model {provider, mode, model}, or null for the cheapest") else emptyList()
            "judge_agent" -> if (!agentOk(v.toString().trim())) listOf("There is no agent called \"$v\"") else emptyList()
            "judge_workflow", "address_workflow" -> if (!flowOk(v.toString().trim())) listOf("There is no workflow called \"$v\"") else emptyList()
            "thread_buttons" -> checkButtons(v, ::agentOk, ::flowOk)
            else -> emptyList()
        }
    }

    private fun checkButtons(v: Any, agentOk: (String) -> Boolean, flowOk: (String) -> Boolean): List<String> {
        if (v !is List<*>) return listOf("thread_buttons is a list of buttons")
        if (v.size > MAX_BUTTONS) return listOf("At most $MAX_BUTTONS extra thread buttons")
        val list = buttons(v)
        if (list.size != v.size) return listOf("Each thread button is {label, mode, agent or workflow, prompt}")
        val out = mutableListOf<String>()
        list.forEachIndexed { i, b ->
            val n = "Button ${i + 1}"
            val label = b.label.trim()
            if (label.isEmpty()) out += "$n needs a label"
            if (label.length > MAX_LABEL) out += "$n: the label \"${label.take(40)}\" is longer than $MAX_LABEL characters"
            when (b.mode) {
                "ask" -> if (b.agent.isNullOrBlank()) out += "$n (ask) needs an agent" else if (!agentOk(b.agent.trim())) out += "$n: there is no agent called \"${b.agent}\""
                "workflow" -> if (b.workflow.isNullOrBlank()) out += "$n (workflow) needs a workflow" else if (!flowOk(b.workflow.trim())) out += "$n: there is no workflow called \"${b.workflow}\""
                else -> out += "$n: mode is ask or workflow"
            }
            if (b.prompt.isBlank()) out += "$n needs a prompt"
            if (b.prompt.length > 4000) out += "$n: the prompt is longer than 4000 characters"
            Regex("\\{\\{\\s*([a-zA-Z_]+)\\s*}}").findAll(b.prompt).map { it.groupValues[1] }.filter { it !in PLACEHOLDERS }.toSet()
                .forEach { out += "$n: {{$it}} is not a placeholder (${PLACEHOLDERS.sorted().joinToString { p -> "{{$p}}" }})" }
        }
        val dup = list.groupBy { it.id }.filterValues { it.size > 1 }.keys
        if (dup.isNotEmpty()) out += "Two buttons have the same label: ${dup.joinToString()}"
        return out
    }

    /** What the threads view needs to draw its buttons. */
    fun client(pid: String): Map<String, Any?> {
        val c = effective(pid)
        return mapOf(
            "judge" to mapOf("mode" to c.judgeMode, "workflow" to c.judgeWorkflow, "allow_harder" to c.judgeAllowHarder, "token_cap" to c.judgeTokenCap,
                "agent" to c.judgeAgent),
            "address_workflow" to c.addressWorkflow,
            "buttons" to c.buttons.map { mapOf("id" to it.id, "label" to it.label, "mode" to it.mode, "agent" to it.agent, "workflow" to it.workflow) },
        )
    }
}
