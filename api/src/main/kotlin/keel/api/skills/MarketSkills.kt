package keel.api.skills

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import keel.api.agents.FrontMatter
import keel.api.common.ApiException
import keel.api.marketplace.Marketplace
import keel.api.projects.ProjectService
import keel.api.workflows.MarketVersions
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service

/** POST /api/projects/{pid}/skills/market/install. [agents]: put it on them; [replace]: an update over another version. */
data class MarketSkillInstall(val name: String = "", val version: String? = null, val agents: List<String>? = null, val replace: Boolean = false)

/**
 * Skills in the marketplace, api side (keel 0.18.6, the fourth kind): the engine finds a skill in the signed catalogs and
 * fetches its verified SKILL.md; the api saves it as one of the project's skills with where it came from (catalog, name,
 * version, sha256: V18__skill_market.sql) and puts it on the agents the person picks. Nothing restarts: an agent reads
 * its skills at its next run.
 *
 * keel's own skills (content/skills and each keel pack's) are listed too, under `builtin`: they are in every project
 * already, so the tab offers to put them on agents, not to install them. Remove is `DELETE /api/projects/{pid}/skills/{sid}`.
 */
@Service
class MarketSkills(
    private val marketplace: Marketplace,
    private val skills: SkillService,
    private val projects: ProjectService,
    private val mapper: ObjectMapper,
) {
    private fun decorate(hit: ObjectNode, pid: String?) {
        val mine = pid?.let { skills.fromMarket(it, hit.path("name").asText()) }
        if (mine == null) hit.putNull("installed") else hit.set<JsonNode>("installed", mapper.createObjectNode()
            .put("version", mine.market!!.version).put("edited", mine.market.edited).put("sid", mine.id)
            .set<JsonNode>("agents", mapper.valueToTree(mine.agents)))
        val best = hit.path("version").takeIf { it.isTextual }?.asText()
        val update = if (mine != null && best != null && MarketVersions.newer(best, mine.market!!.version)) best else null
        if (update == null) hit.putNull("update") else hit.put("update", update)
    }

    /** keel's own skills in the project (its agents, on or off), or as keel ships them without a project. */
    private fun library(pid: String?, q: String?, category: String?): List<Map<String, Any?>> {
        val now = pid?.let { p -> skills.list(p).associateBy { it.id } } ?: emptyMap()
        val words = q.orEmpty().lowercase().split(' ').filter { it.isNotBlank() }
        return skills.library().filter { s ->
            val text = "${s.id} ${s.about} ${s.kind} ${s.stack}".lowercase()
            words.all { it in text } && (category.isNullOrBlank() || category(s.kind) == category)
        }.map { s ->
            val here = now[s.id]
            mapOf("name" to s.id, "title" to title(s.id, s.body), "summary" to s.about, "source" to s.source, "kind" to s.kind,
                "category" to category(s.kind), "stack" to s.stack, "version" to s.version, "tokens" to s.tokens,
                "agents" to (here?.agents ?: s.agents), "when" to (here?.`when` ?: s.`when`), "enabled" to (here?.enabled ?: true),
                "refs" to s.refs.size, "builtin" to true, "publisher" to "keel", "trust" to "content")
        }
    }

    /**
     * The catalogs' skills (+ installed {version, edited, sid, agents} | null and update) and keel's own (`builtin`). When no
     * catalog answers, `skills` is empty and `catalog_error` says why; keel's own are still there.
     */
    fun search(q: String?, category: String?, project: String?): JsonNode {
        if (!project.isNullOrBlank()) projects.require(project)
        val out = try {
            marketplace.skills(q, category).deepCopy<JsonNode>() as ObjectNode
        } catch (e: ApiException) {
            mapper.createObjectNode().apply {
                putArray("skills")
                putArray("sources")
                set<JsonNode>("categories", mapper.valueToTree(CATEGORIES))
                set<JsonNode>("catalog_error", mapper.createObjectNode().put("error", e.message).put("hint", e.hint))
            }
        }
        out.path("skills").forEach { decorate(it as ObjectNode, project) }
        if (!out.has("catalog_error")) out.putNull("catalog_error")
        out.set<JsonNode>("builtin", mapper.valueToTree(library(project, q, category)))
        return out
    }

    /**
     * One skill: the catalog's detail + installed/update + the verified SKILL.md of the newest fitting version (`text`),
     * keel's review of it (`review`) and the catalog's (`catalog_review`); a fetch that fails is `fetch_error: {error, hint}`
     * (the page still opens). A name no catalog lists but keel has is keel's own: `builtin: true`, its text and review.
     */
    fun detail(name: String, project: String?): JsonNode {
        if (!project.isNullOrBlank()) projects.require(project)
        val found = try {
            marketplace.skill(name).deepCopy<JsonNode>() as ObjectNode
        } catch (e: ApiException) {
            if (e.status != HttpStatus.NOT_FOUND && e.status != HttpStatus.BAD_GATEWAY && e.status != HttpStatus.SERVICE_UNAVAILABLE) throw e
            return builtin(name, project) ?: throw e
        }
        decorate(found, project)
        found.set<JsonNode>("catalog_review", found.path("review").deepCopy())
        found.putNull("text")
        found.putNull("fetch_error")
        found.put("builtin", false)
        val version = found.path("version").takeIf { it.isTextual }?.asText()
        if (version == null || !found.path("refused").isNull && !found.path("refused").isMissingNode) return found
        try {
            val fetched = marketplace.fetchSkill(name, version)
            found.put("text", fetched.path("text").asText(""))
            found.set<JsonNode>("review", fetched.path("review"))
        } catch (e: ApiException) {
            found.set<JsonNode>("fetch_error", mapper.createObjectNode().put("error", e.message).put("hint", e.hint))
        }
        return found
    }

    private fun builtin(name: String, project: String?): JsonNode? {
        val s = skills.library().firstOrNull { it.id == name } ?: return null
        val here = project?.let { p -> skills.list(p).firstOrNull { it.id == name } }
        return mapper.valueToTree(mapOf(
            "name" to s.id, "title" to title(s.id, s.body), "summary" to s.about, "source" to s.source, "kind" to s.kind,
            "category" to category(s.kind), "stack" to s.stack, "version" to s.version, "builtin" to true, "publisher" to "keel",
            "publisher_title" to "keel", "verified" to true, "trust" to "content", "text" to s.body,
            "review" to review(s.body) + mapOf("tokens" to s.tokens, "description" to s.about),
            "refs" to s.refs, "agents" to (here?.agents ?: s.agents), "when" to (here?.`when` ?: s.`when`),
            "enabled" to (here?.enabled ?: true), "installed" to null, "update" to null, "fetch_error" to null,
            "checks" to listOf("it ships with keel's image: keel's own words, in every project", "a skill only adds words to an " +
                "agent's prompt: keel's rules and the phase still decide what the agent may do"),
        ))
    }

    /**
     * Fetch the verified SKILL.md, save it as the project's skill (marketplace: catalog, name, version) and put it on
     * [MarketSkillInstall.agents]. 409 the same version installed, or another version without replace; a fetch refusal
     * keeps the engine's status (409, 502).
     */
    fun install(pid: String, body: MarketSkillInstall): JsonNode {
        projects.require(pid)
        val name = Marketplace.checkPackName(body.name, "skill")
        val fetched = marketplace.fetchSkill(name, body.version)
        val version = fetched.path("version").asText()
        var saved = skills.installMarket(pid, name, version, fetched.path("text").asText(""), fetched.path("catalog").asText(), body.replace)
        val agents = body.agents?.filter { it.isNotBlank() }.orEmpty()
        if (agents.isNotEmpty()) saved = skills.update(pid, saved.id, (saved.agents + agents).distinct(), null, null, null)
        val out = mapper.createObjectNode()
        out.set<JsonNode>("skill", mapper.valueToTree(saved))
        out.set<JsonNode>("market", mapper.createObjectNode().put("catalog", fetched.path("catalog").asText()).put("name", name)
            .put("version", version).put("sha256", fetched.path("sha256").asText()))
        out.set<JsonNode>("review", fetched.path("review"))
        return out
    }

    companion object {
        /** The marketplace's skill categories (the engine's kinds.SKILLS); keel's own kinds map onto them. */
        val CATEGORIES = listOf("testing", "implementation", "review", "debugging", "knowledge", "authoring", "other")

        fun category(kind: String): String = when (kind) {
            in CATEGORIES -> kind
            "placement" -> "implementation"
            "flow" -> "other"
            else -> "other"
        }

        /** A skill's title: its first # heading, else its id in words. */
        fun title(id: String, body: String): String =
            body.lineSequence().firstOrNull { it.startsWith("# ") }?.removePrefix("# ")?.trim()?.ifBlank { null }
                ?: id.replace('-', ' ').replaceFirstChar { it.uppercase() }

        /**
         * keel's review of a SKILL.md: {tokens (its size / 4), sections (its ## headings outside code fences, at most 40),
         * description (its front matter's)}. Twin of the engine's marketplace kinds.skill_review.
         */
        fun review(text: String): Map<String, Any> {
            val (fm, body) = FrontMatter.split(text)
            val sections = mutableListOf<String>()
            var fenced = false
            for (line in body.split("\n")) {
                if (line.trimStart().startsWith("```")) fenced = !fenced
                else if (!fenced && line.startsWith("## ") && sections.size < 40) sections += line.substring(3).trim()
            }
            return mapOf("tokens" to text.toByteArray().size / 4, "sections" to sections,
                "description" to (fm["description"] as? String)?.trim().orEmpty())
        }
    }
}
