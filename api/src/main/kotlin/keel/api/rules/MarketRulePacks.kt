package keel.api.rules

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import keel.api.common.ApiException
import keel.api.marketplace.Marketplace
import keel.api.projects.ProjectService
import keel.api.workflows.MarketVersions
import org.springframework.stereotype.Service
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/** POST /api/projects/{pid}/rule-packs/market/install. [replace]: an update over another installed version. */
data class MarketPackInstall(val name: String = "", val version: String? = null, val replace: Boolean = false)

/**
 * Rule packs in the marketplace, api side (docs/plugins/23-rules-in-marketplace.md): the engine finds a pack in the signed
 * catalogs and fetches its verified file; keel reads it with the rules work's parser (each rule, and who enforces it), and
 * the rules api installs it into one project as `.keel/rules/<name>.yaml` with source "marketplace". The pack file is
 * installed exactly as published. Nothing restarts: the guard reads the packs on every tool call.
 *
 * Remove is the rules api's uninstall (`POST /api/projects/{pid}/rule-packs/uninstall {name}`).
 */
@Service
class MarketRulePacks(
    private val marketplace: Marketplace,
    private val rules: RulesService,
    private val projects: ProjectService,
    private val mapper: ObjectMapper,
) {
    /** The project's installed packs by name (the rules api's GET), or nothing without a project. */
    private fun installedOf(project: String?): Map<String, JsonNode> {
        if (project.isNullOrBlank()) return emptyMap()
        projects.require(project)
        return rules.installed(project).associateBy { it.path("name").asText() }
    }

    /** A hit + installed {version, edited, source} (or null) and update (a newer version that fits, or null). */
    private fun decorate(hit: ObjectNode, have: Map<String, JsonNode>) {
        val mine = have[hit.path("name").asText()]
        if (mine == null) hit.putNull("installed") else hit.set<JsonNode>("installed", mapper.createObjectNode()
            .put("version", mine.path("version").asText())
            .put("edited", mine.path("edited").asBoolean(false))
            .put("source", mine.path("source").asText("file")))
        val best = hit.path("version").takeIf { it.isTextual }?.asText()
        val update = if (mine != null && best != null && MarketVersions.newer(best, mine.path("version").asText())) best else null
        if (update == null) hit.putNull("update") else hit.put("update", update)
    }

    fun search(q: String?, category: String?, project: String?): JsonNode {
        val have = installedOf(project)
        val out = marketplace.rulePacks(q, category).deepCopy<JsonNode>() as ObjectNode
        out.path("rules").forEach { decorate(it as ObjectNode, have) }
        return out
    }

    /**
     * The engine's detail + installed/update + the verified file of the newest fitting version (yaml), keel's review of
     * it, and keel's own reading (the rules work's parser): `pack` (its header), `rules` (each with kind, match, how,
     * phases, lanes, except, reason and `enforced: {before: [engine], after, engines, by}`), `engines` and `enforcers`.
     * A pack keel would refuse (an old catalog, no version for this keel) has yaml null and no rules; a fetch that fails
     * (a bad signature, a changed file, a review that is not the catalog's) is `fetch_error: {error, hint}`.
     */
    fun detail(name: String, project: String?): JsonNode {
        val have = installedOf(project)
        val out = marketplace.rulePack(name).deepCopy<JsonNode>() as ObjectNode
        decorate(out, have)
        out.set<JsonNode>("catalog_review", out.path("review").deepCopy())
        out.putNull("yaml")
        out.putArray("rules")
        out.putNull("fetch_error")
        val version = out.path("version").takeIf { it.isTextual }?.asText()
        if (version == null || !out.path("refused").isNull && !out.path("refused").isMissingNode) return out
        try {
            val fetched = marketplace.fetchRulePack(name, version)
            val yaml = fetched.path("yaml").asText("")
            val reading = marketplace.readRulePack(yaml)
            out.put("yaml", yaml)
            out.set<JsonNode>("review", fetched.path("review"))
            out.set<JsonNode>("pack", reading.path("pack"))
            out.set<JsonNode>("rules", reading.path("rules"))
            out.set<JsonNode>("engines", reading.path("engines"))
            out.set<JsonNode>("enforcers", reading.path("enforcers"))
        } catch (e: ApiException) {
            out.set<JsonNode>("fetch_error", mapper.createObjectNode().put("error", e.message).put("hint", e.hint))
        }
        return out
    }

    /**
     * Fetch the verified file and hand it to the rules api's install with source "marketplace", the name and the version.
     * The rules api's refusals come back as it gives them: 409 the same version installed, or another version without
     * [MarketPackInstall.replace]; 422 a pack that is not valid or whose requires.keel this keel does not meet.
     */
    fun install(pid: String, body: MarketPackInstall): JsonNode {
        projects.require(pid)
        val name = Marketplace.checkPackName(body.name)
        val fetched = marketplace.fetchRulePack(name, body.version)
        val version = fetched.path("version").asText()
        val done = rules.installPack(pid, RulePackInstall(source = "marketplace", name = name, version = version,
            yaml = fetched.path("yaml").asText(""), replace = body.replace))
        val out = done.deepCopy<JsonNode>() as ObjectNode
        out.set<JsonNode>("market", mapper.createObjectNode().put("catalog", fetched.path("catalog").asText()).put("name", name)
            .put("version", version).put("sha256", fetched.path("sha256").asText()))
        out.set<JsonNode>("review", fetched.path("review"))
        return out
    }
}

/** The marketplace's rule packs (docs/plugins/23-rules-in-marketplace.md §5). Install is admin for MCP (McpLevels.kt). */
@RestController
@RequestMapping("/api")
class MarketRulePackController(private val market: MarketRulePacks) {
    @GetMapping("/marketplace/rule-packs")
    fun search(@RequestParam(required = false) q: String?, @RequestParam(required = false) category: String?,
               @RequestParam(required = false) project: String?): JsonNode = market.search(q, category, project)

    @GetMapping("/marketplace/rule-packs/{name}")
    fun detail(@PathVariable name: String, @RequestParam(required = false) project: String?): JsonNode = market.detail(name, project)

    @PostMapping("/projects/{pid}/rule-packs/market/install")
    fun install(@PathVariable pid: String, @RequestBody body: MarketPackInstall): JsonNode = market.install(pid, body)
}
