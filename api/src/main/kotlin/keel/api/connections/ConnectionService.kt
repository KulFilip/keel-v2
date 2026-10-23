package keel.api.connections

import com.fasterxml.jackson.databind.JsonNode
import keel.api.common.BadRequest
import keel.api.common.KvStore
import keel.api.common.NotFound
import keel.api.engine.EngineClient
import keel.api.settings.SettingsService
import org.springframework.stereotype.Service

/** [need]: what a mode that is not ready misses: "cli" (not installed) or "login" (no login saved); null when ready. */
data class ModeView(val id: String, val label: String, val ready: Boolean, val detail: String, val need: String? = null)

data class ProviderView(
    val id: String,
    val label: String,
    val modes: List<ModeView>,
    val selected: String,
    val keySet: Boolean,
    val keyHint: String? = null,
    /** Secret name of the CLI login (subscription), e.g. CLAUDE_CODE_OAUTH_TOKEN; null when the provider has none. */
    val loginSecret: String? = null,
    val loginSet: Boolean = false,
    val loginHint: String? = null,
)

data class MachineTool(val name: String, val ok: Boolean, val version: String? = null)
data class Connections(val providers: List<ProviderView>, val machine: List<MachineTool>)

@Service
class ConnectionService(
    private val secrets: SecretService,
    private val kv: KvStore,
    private val engine: EngineClient,
    private val settings: SettingsService,
    private val servers: ModelServerService,
) {
    /** Programs on this machine, checked in parallel and cached for a minute (MachineTools). */
    internal var tools = MachineTools()

    private fun selectedModes(): Map<String, String> = kv.get<Map<String, String>>(KEY) ?: emptyMap()

    private fun keyView(provider: String): Pair<Boolean, String?> {
        if (provider in ModelServerService.PROVIDERS) return servers.summary(provider).let { (ready, line) -> ready to line.takeIf { ready } }
        val name = SecretService.KEY_NAMES[provider] ?: return false to null
        if (secrets.has(name)) return true to secrets.hintOf(name)
        val env = System.getenv(name)
        return if (!env.isNullOrBlank()) true to "from the environment" else false to null
    }

    private fun loginView(provider: String): Triple<String?, Boolean, String?> {
        val name = SecretService.LOGIN_NAMES[provider] ?: return Triple(null, false, null)
        if (secrets.has(name)) return Triple(name, true, secrets.hintOf(name))
        val env = System.getenv(name)
        return if (!env.isNullOrBlank()) Triple(name, true, "from the environment") else Triple(name, false, null)
    }

    fun connections(): Connections {
        val sel = selectedModes()
        // Every program at once: the answer takes about the slowest single check (up to 5 s), not their sum.
        val machine = tools.check(MACHINE)
        val found = MACHINE.zip(machine).toMap()
        // A CLI mode is ready only when keel has its login too: keel's agents never use the person's own CLI login
        // (in the container, or in native mode where they have their own home). OpenCode keeps its own login
        // (`opencode auth login`), so it needs none from keel.
        fun cliMode(id: String, label: String, bin: String, loginSet: Boolean = true): ModeView {
            val t = found[bin] ?: tools.check(bin)
            return when {
                !t.ok -> ModeView(id, label, false, "$bin is not installed. Build the image with INSTALL_CLIS=1.", "cli")
                !loginSet -> ModeView(id, label, false, "${CLI_NAMES[bin] ?: bin} found — add your login: ${LOGIN_HOW[bin] ?: "Set up login"}.", "login")
                else -> ModeView(id, label, true, "${t.version ?: bin} found, login saved.")
            }
        }
        val providers = PROVIDERS.map { (id, label) ->
            val (keySet, hint) = keyView(id)
            val (loginName, loginSet, loginHint) = loginView(id)
            val modes = when (id) {
                "fake" -> listOf(ModeView("api", "Fake model (no network)", true, "Deterministic answers for demos and tests."))
                "claude" -> listOf(
                    cliMode("subscription", "Claude subscription (Claude Code CLI)", "claude", loginSet),
                    ModeView("api", "Anthropic API key", keySet, if (keySet) "Key saved." else "Add ANTHROPIC_API_KEY."),
                )
                "codex" -> listOf(
                    cliMode("subscription", "ChatGPT subscription (Codex CLI)", "codex", loginSet),
                    ModeView("api", "OpenAI API key", keySet, if (keySet) "Key saved." else "Add OPENAI_API_KEY."),
                )
                "copilot" -> listOf(
                    cliMode("subscription", "Copilot CLI", "copilot", loginSet),
                    cliMode("opencode", "OpenCode", "opencode"),
                    ModeView("api", "GitHub Models (token)", keySet, if (keySet) "Token saved." else "Add GITHUB_TOKEN."),
                )
                "vertex" -> servers.summary(id).let { (ready, line) -> listOf(ModeView("api", "Vertex AI (Google Cloud)", ready, line)) }
                "local" -> servers.summary(id).let { (ready, line) -> listOf(ModeView("api", "Local model server", ready, line)) }
                else -> emptyList()
            }
            val selected = sel[id] ?: modes.firstOrNull { it.ready }?.id ?: modes.first().id
            ProviderView(id, label, modes, selected, keySet, hint, loginName, loginSet, loginHint)
        }
        return Connections(providers, machine)
    }

    fun select(provider: String, mode: String): Connections {
        val p = connections().providers.firstOrNull { it.id == provider } ?: throw NotFound("No provider called \"$provider\"")
        if (p.modes.none { it.id == mode }) throw BadRequest("$provider has no mode \"$mode\"", "Modes: ${p.modes.joinToString { it.id }}")
        kv.put(KEY, selectedModes() + (provider to mode))
        return connections()
    }

    /** Asks the engine to run "Reply with exactly: OK" with the selected mode. */
    fun test(provider: String): JsonNode {
        val p = connections().providers.firstOrNull { it.id == provider } ?: throw NotFound("No provider called \"$provider\"")
        val general = settings.general()
        val chosen = listOf(general.defaultModel, general.implementerModel, general.reviewerModel, general.cheaperModel)
            .firstOrNull { it.provider == provider }?.model
        // local models: no agent uses one yet, so there is no model to ask: say whether keel reaches each server instead
        if (provider == "local" && chosen == null) return testServers()
        val model = chosen ?: DEFAULT_MODELS[provider] ?: provider
        val body = mutableMapOf<String, Any?>("provider" to provider, "mode" to p.selected, "model" to model)
        val secret = if (p.selected == "api") secrets.keyForProvider(provider) else secrets.loginFor(provider)
        secret?.let { body["key"] = it }
        val res = engine.providerTest(body)
        // When the test fails, say what is wrong with the saved value's shape (never the value itself).
        val problem = if (res.path("ok").asBoolean(false) || secret == null || provider in ModelServerService.PROVIDERS) null else shapeProblem(provider, p.selected, secret)
        return if (problem == null) res else (res as com.fasterxml.jackson.databind.node.ObjectNode).put("error", problem)
    }

    /** Every local model server: does keel reach it, and how many models it has. {ok, text, ms} or {ok: false, error}. */
    private fun testServers(): JsonNode {
        val eps = servers.local().endpoints
        val out = com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.objectNode()
        if (eps.isEmpty()) return out.put("ok", false).put("ms", 0).put("error", "No local model server yet. Add one under Local models.")
        val results = eps.map { it.name to servers.testEndpoint(it.name) }
        val bad = results.filter { !it.second.path("ok").asBoolean(false) }
        out.put("ms", results.sumOf { it.second.path("ms").asLong(0) })
        return if (bad.isEmpty()) out.put("ok", true).put("text", results.joinToString(" · ") { (n, r) -> "$n: ${r.path("models").size()} models" })
        else out.put("ok", false).put("error", bad.joinToString(" ") { (n, r) -> "$n: ${r.path("error").asText("no answer")}" })
    }

    /** Plain checks on a saved login or key; the message never contains the value. */
    fun shapeProblem(provider: String, mode: String, v: String): String? {
        val bad = v.filter { !(it.isLetterOrDigit() && it.code < 128) && it !in "-_.=" }
        val what = if (mode == "api") "API key" else "login token"
        return when {
            bad.isNotEmpty() -> "The saved $what has characters a token never has (${bad.toSet().joinToString("") { if (it.isWhitespace()) "␣" else it.toString() }}): " +
                "probably a copy with spaces, line breaks or • dots. Paste it again in one piece."
            provider == "claude" && mode == "subscription" && !v.startsWith("sk-ant-oat01-") ->
                "The saved Claude login token does not start with sk-ant-oat01- (it has ${v.length} characters). Copy the whole token that `claude setup-token` prints and save it again."
            provider == "claude" && mode == "api" && !v.startsWith("sk-ant-") -> "The saved Anthropic API key does not start with sk-ant-. Check that you pasted the right key."
            else -> null
        }
    }

    companion object {
        const val KEY = "connections"
        val PROVIDERS = listOf("fake" to "Fake (demo)", "claude" to "Claude", "codex" to "GPT / Codex", "copilot" to "Copilot",
            "vertex" to "Vertex AI", "local" to "Local models")
        val DEFAULT_MODELS = mapOf("fake" to "fake", "claude" to "sonnet", "codex" to "gpt-5", "copilot" to "gpt-5", "vertex" to "claude-sonnet-5-5")
        val CLI_NAMES = mapOf("claude" to "Claude Code", "codex" to "Codex", "copilot" to "Copilot CLI", "opencode" to "OpenCode")
        /** How to get a CLI's login for keel (the mode's detail when it is missing). */
        val LOGIN_HOW = mapOf(
            "claude" to "claude setup-token, then Set up login",
            "codex" to "codex login, then Set up login",
            "copilot" to "Set up login",
        )
        /** What "This machine" lists, in this order. */
        val MACHINE = listOf("node", "git", "java", MachineTools.DOCKER, "claude", "codex", "copilot", "opencode")
    }
}
