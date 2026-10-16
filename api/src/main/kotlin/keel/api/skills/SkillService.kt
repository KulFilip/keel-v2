package keel.api.skills

import keel.api.agents.FrontMatter
import keel.api.common.BadRequest
import keel.api.common.Conflict
import keel.api.common.Json
import keel.api.common.KeelProperties
import keel.api.common.NotFound
import keel.api.common.Slug
import keel.api.common.Time
import keel.api.projects.ProjectService
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import java.nio.file.Files
import java.nio.file.Path

data class SkillRef(val path: String, val tokens: Int)

/** Where a skill installed from the marketplace came from (keel 0.18.6); [edited]: its text was changed here since. */
data class SkillMarket(val catalog: String, val name: String, val version: String, val edited: Boolean = false)

data class Skill(
    val id: String,
    val kind: String,
    val source: String,
    val stack: String,
    val version: String,
    val tokens: Int,
    val agents: List<String>,
    val `when`: String,
    val enabled: Boolean,
    val about: String = "",
    val market: SkillMarket? = null,
)

data class SkillDetail(
    val id: String,
    val kind: String,
    val source: String,
    val stack: String,
    val version: String,
    val tokens: Int,
    val agents: List<String>,
    val `when`: String,
    val enabled: Boolean,
    val about: String,
    val body: String,
    val refs: List<SkillRef>,
    val market: SkillMarket? = null,
)

data class SkillAssign(val agents: List<String>? = null, val `when`: String? = null, val enabled: Boolean? = null)

private data class SkillDef(
    val id: String, val kind: String, val source: String, val stack: String, val version: String,
    val about: String, val body: String, val bytes: Long, val refs: List<SkillRef>,
    val agents: List<String>, val `when`: String, val projectId: String? = null, val market: SkillMarket? = null,
)

/** Skills: keel's own (content/skills), each keel pack's (content/packs/NAME/skills), and the user's (stored in the db). */
@Service
class SkillService(
    private val jdbc: JdbcTemplate,
    private val projects: ProjectService,
    private val props: KeelProperties,
) {
    private fun scan(dir: Path, source: String): List<SkillDef> {
        if (!Files.isDirectory(dir)) return emptyList()
        return Files.list(dir).use { s -> s.filter { Files.isRegularFile(it.resolve("SKILL.md")) }.sorted().toList() }.map { d ->
            val file = d.resolve("SKILL.md")
            val text = Files.readString(file)
            val (fm, body) = FrontMatter.split(text)
            val id = fm["name"]?.toString() ?: d.fileName.toString()
            val refsDir = d.resolve("references")
            val refs = if (Files.isDirectory(refsDir)) {
                Files.walk(refsDir).use { w ->
                    w.filter { Files.isRegularFile(it) }.sorted().toList()
                        .map { SkillRef(d.relativize(it).toString(), (Files.size(it) / 4).toInt()) }
                }
            } else emptyList()
            val (agents, whenText) = defaultAssignment(id)
            SkillDef(id, kindOf(id), source, stackOf(id), VERSION, fm["description"]?.toString() ?: "", body, Files.size(file), refs, agents, whenText)
        }
    }

    private fun builtins(): List<SkillDef> = scan(props.contentDir.resolve("skills"), "keel") + packSkills()

    /** keel's own skills (content/skills, then each keel pack's): their id, source ("keel" or "keel pack"), what each is
     *  for, its kind and stack, and its SKILL.md text. The marketplace's Skills tab lists them under "From keel". */
    fun library(): List<SkillDetail> = builtins().map {
        SkillDetail(it.id, it.kind, it.source, it.stack, it.version, (it.bytes / 4).toInt(), it.agents, it.`when`, true, it.about, it.body, it.refs)
    }

    private fun packSkills(): List<SkillDef> {
        val packs = props.contentDir.resolve("packs")
        if (!Files.isDirectory(packs)) return emptyList()
        return Files.list(packs).use { s -> s.filter { Files.isDirectory(it) }.sorted().toList() }
            .flatMap { scan(it.resolve("skills"), "keel pack") }
    }

    private fun custom(pid: String?): List<SkillDef> {
        val sql = "SELECT id, project_id, name, kind, stack, body, market_catalog, market_name, market_version, market_sha256 FROM custom_skills" +
            (if (pid != null) " WHERE project_id = ?" else "")
        val args: Array<Any> = if (pid != null) arrayOf(pid) else emptyArray()
        return jdbc.query(sql, { rs, _ ->
            val body = rs.getString(6)
            val (fm, _) = FrontMatter.split(body)
            val market = rs.getString(8)?.let { SkillMarket(rs.getString(7) ?: "", it, rs.getString(9) ?: "", rs.getString(10) != sha256(body)) }
            SkillDef(
                rs.getString(1), rs.getString(4), if (market != null) "marketplace" else "yours", rs.getString(5), market?.version ?: "v1",
                fm["description"]?.toString() ?: "", body, body.toByteArray().size.toLong(), emptyList(), emptyList(), "on demand",
                rs.getString(2), market,
            )
        }, *args)
    }

    private fun assignment(pid: String, sid: String): SkillAssign? =
        jdbc.query("SELECT json FROM skill_assign WHERE project_id = ? AND skill_id = ?", { rs, _ -> rs.getString(1) }, pid, sid)
            .firstOrNull()?.let { runCatching { Json.read<SkillAssign>(it) }.getOrNull() }

    private fun view(d: SkillDef, pid: String?): Skill {
        val a = pid?.let { assignment(it, d.id) }
        return Skill(
            d.id, d.kind, d.source, d.stack, d.version, (d.bytes / 4).toInt(), a?.agents ?: d.agents,
            a?.`when` ?: d.`when`, a?.enabled ?: true, d.about, d.market,
        )
    }

    fun list(pid: String): List<Skill> {
        projects.require(pid)
        return (builtins() + custom(pid)).map { view(it, pid) }
    }

    private fun def(sid: String, pid: String? = null): SkillDef =
        (builtins() + custom(pid)).firstOrNull { it.id == sid } ?: throw NotFound("No skill called \"$sid\"")

    fun detail(sid: String, pid: String?): SkillDetail {
        val d = def(sid, pid)
        val v = view(d, pid ?: d.projectId)
        return SkillDetail(v.id, v.kind, v.source, v.stack, v.version, v.tokens, v.agents, v.`when`, v.enabled, v.about, d.body, d.refs, d.market)
    }

    fun create(pid: String, name: String, kind: String, stack: String, body: String): Skill {
        projects.require(pid)
        if (name.isBlank()) throw BadRequest("Give the skill a name")
        if (body.isBlank()) throw BadRequest("The skill has no text", "Write the SKILL.md body.")
        val id = freeId(Slug.of(name))
        jdbc.update(
            "INSERT INTO custom_skills(id, project_id, name, kind, stack, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            id, pid, name, kind.ifBlank { "knowledge" }, stack.ifBlank { "any" }, body, Time.now(),
        )
        return view(def(id, pid), pid)
    }

    /** A skill id no skill has yet (keel's, or any project's own): the name, else name-2, name-3 … */
    private fun freeId(base: String): String {
        val taken = (builtins() + custom(null)).map { it.id }.toSet()
        var id = base
        var n = 2
        while (id in taken) id = "$base-${n++}"
        return id
    }

    /** The project's skill that came from the marketplace under this name, if any. */
    fun fromMarket(pid: String, name: String): Skill? =
        custom(pid).firstOrNull { it.market?.name == name }?.let { view(it, pid) }

    /**
     * Saves a skill the marketplace verified (keel 0.18.6): a new row with its catalog, name, version and the sha256 of
     * the text, or, with [replace], the new version over the project's copy (its agents stay). 409 the same version
     * installed, or another version without [replace].
     */
    fun installMarket(pid: String, name: String, version: String, text: String, catalog: String, replace: Boolean): Skill {
        projects.require(pid)
        if (text.isBlank()) throw BadRequest("The skill has no text")
        val have = custom(pid).firstOrNull { it.market?.name == name }
        if (have != null) {
            val was = have.market!!.version
            if (was == version && !replace) {
                throw keel.api.common.ApiException(org.springframework.http.HttpStatus.CONFLICT, "$name $version is installed already.",
                    "There is nothing to install.", mapOf("installed" to mapOf("version" to was, "sid" to have.id)))
            }
            if (!replace) {
                throw keel.api.common.ApiException(org.springframework.http.HttpStatus.CONFLICT,
                    "$name $was is installed; installing $version replaces it (replace).",
                    if (have.market.edited) "Its text was changed here: replacing it loses those changes." else "Update it.",
                    mapOf("installed" to mapOf("version" to was, "sid" to have.id, "edited" to have.market.edited)))
            }
            jdbc.update("UPDATE custom_skills SET body = ?, market_catalog = ?, market_version = ?, market_sha256 = ? WHERE id = ?",
                text, catalog, version, sha256(text), have.id)
            return view(def(have.id, pid), pid)
        }
        val id = freeId(name)
        jdbc.update(
            "INSERT INTO custom_skills(id, project_id, name, kind, stack, body, created_at, market_catalog, market_name, market_version, market_sha256) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            id, pid, name, kindOf(name), stackOf(name), text, Time.now(), catalog, name, version, sha256(text),
        )
        return view(def(id, pid), pid)
    }

    /** Removes one of the project's own skills (written here, imported, or from the marketplace); keel's stay. */
    fun delete(pid: String, sid: String) {
        projects.require(pid)
        val d = def(sid, pid)
        if (d.projectId == null) throw Conflict("keel's own skills cannot be removed", "Turn it off for this project, or take it off its agents.")
        if (d.projectId != pid) throw NotFound("No skill called \"$sid\" in this project")
        jdbc.update("DELETE FROM custom_skills WHERE id = ? AND project_id = ?", sid, pid)
        jdbc.update("DELETE FROM skill_assign WHERE project_id = ? AND skill_id = ?", pid, sid)
    }

    fun update(pid: String, sid: String, agents: List<String>?, whenText: String?, body: String?, enabled: Boolean?): Skill {
        projects.require(pid)
        val d = def(sid, pid)
        if (body != null) {
            if (d.projectId == null) throw Conflict("keel skills cannot be edited here", "Make your own skill and assign it instead.")
            jdbc.update("UPDATE custom_skills SET body = ? WHERE id = ?", body, sid)
        }
        if (agents != null || whenText != null || enabled != null) {
            val prev = assignment(pid, sid) ?: SkillAssign()
            val next = SkillAssign(agents ?: prev.agents, whenText ?: prev.`when`, enabled ?: prev.enabled)
            jdbc.update(
                "INSERT INTO skill_assign(project_id, skill_id, json) VALUES (?, ?, ?) ON CONFLICT(project_id, skill_id) DO UPDATE SET json = excluded.json",
                pid, sid, Json.write(next),
            )
        }
        return view(def(sid, pid), pid)
    }

    /**
     * Imports a SKILL.md, from a URL (http/https, at most 256 KB) or pasted text. The front matter
     * gives the name and description; without a name, the URL's folder name is used.
     */
    fun importSkill(pid: String, url: String?, body: String?): Skill {
        projects.require(pid)
        val (text, fallbackName) = when {
            !body.isNullOrBlank() -> body to null
            !url.isNullOrBlank() -> fetch(url.trim()) to nameFromUrl(url.trim())
            else -> throw BadRequest("Send { url } or { body }", "A link to a SKILL.md, or its text.")
        }
        if (text.length > MAX_IMPORT) throw BadRequest("The skill is too large", "At most 256 KB.")
        val (fm, rest) = FrontMatter.split(text)
        val name = fm["name"]?.toString()?.trim()?.takeIf { it.isNotBlank() } ?: fallbackName
            ?: throw BadRequest("The SKILL.md has no name", "Add front matter: ---\nname: my-skill\ndescription: ...\n---")
        if (rest.isBlank()) throw BadRequest("The skill has no text after its front matter")
        val stack = stackOf(Slug.of(name))
        return create(pid, name, kindOf(Slug.of(name)), stack, text)
    }

    private fun nameFromUrl(url: String): String? = runCatching {
        val parts = java.net.URI(url).path.split('/').filter { it.isNotBlank() }
        val last = parts.lastOrNull()
        (if (last != null && last.equals("SKILL.md", ignoreCase = true)) parts.getOrNull(parts.size - 2) else last?.removeSuffix(".md"))
    }.getOrNull()?.takeIf { it.isNotBlank() }

    private fun fetch(url: String): String {
        val uri = try { java.net.URI(url) } catch (e: Exception) { throw BadRequest("That is not a valid URL") }
        if (uri.scheme?.lowercase() !in setOf("http", "https") || uri.host.isNullOrBlank()) {
            throw BadRequest("Only http and https links can be imported")
        }
        val client = java.net.http.HttpClient.newBuilder()
            .connectTimeout(java.time.Duration.ofSeconds(10))
            .followRedirects(java.net.http.HttpClient.Redirect.NORMAL).build()
        val req = java.net.http.HttpRequest.newBuilder(uri).timeout(java.time.Duration.ofSeconds(20)).GET().build()
        val res = try {
            client.send(req, java.net.http.HttpResponse.BodyHandlers.ofInputStream())
        } catch (e: Exception) {
            throw BadRequest("Could not download the skill", e.message?.take(200))
        }
        res.body().use { input ->
            if (res.statusCode() !in 200..299) throw BadRequest("The link answered ${res.statusCode()}", "Use the raw file link.")
            val bytes = input.readNBytes(MAX_IMPORT + 1)
            if (bytes.size > MAX_IMPORT) throw BadRequest("The skill is too large", "At most 256 KB.")
            return String(bytes, Charsets.UTF_8)
        }
    }

    /** SKILL.md bodies of the skills assigned to an agent, joined, for the engine to add to its prompt. */
    fun textFor(pid: String, skillIds: List<String>): String {
        val all = (builtins() + custom(pid)).associateBy { it.id }
        return skillIds.mapNotNull { all[it] }.joinToString("\n\n---\n\n") { it.body.trim() }
    }

    /** Skill ids assigned (and enabled) for each agent in a project. */
    fun assignedByAgent(pid: String): Map<String, List<String>> {
        val out = mutableMapOf<String, MutableList<String>>()
        for (s in list(pid)) if (s.enabled) for (a in s.agents) out.getOrPut(a) { mutableListOf() } += s.id
        return out
    }

    companion object {
        fun kindOf(id: String): String = when {
            id.endsWith("-testing") || id == "playwright" -> "testing"
            id.endsWith("-implementation") -> "implementation"
            id == "architecture" -> "placement"
            id == "debugging" || id == "diagnose" -> "debugging"
            id == "security" || id == "review" -> "review"
            id == "memory" -> "knowledge"
            id == "spec-clarify" || id == "spec-writing" -> "authoring"
            id in FLOW_SKILLS -> "flow"
            else -> "knowledge"
        }

        fun stackOf(id: String): String = when {
            id.startsWith("kotlin-spring") -> "kotlin-spring"
            id.startsWith("web-") -> "ts-react"
            id.startsWith("react-") -> "react-js"
            id.startsWith("symfony") -> "symfony"
            id.startsWith("django") -> "django"
            else -> "any"
        }

        const val MAX_IMPORT = 256 * 1024

        fun sha256(text: String): String = java.security.MessageDigest.getInstance("SHA-256").digest(text.toByteArray())
            .joinToString("") { "%02x".format(it) }

        /** keel's own skills ship with keel v2 (content/), so they carry its version line. */
        const val VERSION = "v2"

        val FLOW_SKILLS = setOf("feature", "fix", "change", "hunt", "hunt-next", "init", "ship", "cover", "status")

        fun defaultAssignment(id: String): Pair<List<String>, String> = when {
            id.endsWith("-testing") -> listOf("test-author") to "red"
            id.endsWith("-implementation") -> listOf("implementer") to "green"
            id == "architecture" -> listOf("implementer", "arch-surveyor") to "green, ship"
            id == "debugging" -> listOf("reproducer", "investigator") to "bug-repro, bug-investigate"
            id == "security" -> listOf("security-auditor", "dependency-triager") to "security"
            id == "spec-clarify" -> listOf("explorer") to "spec"
            id == "spec-writing" -> listOf("explorer") to "spec"
            id == "memory" -> listOf("librarian") to "memory"
            id == "playwright" -> listOf("e2e-author") to "e2e"
            id == "review" -> listOf("reviewer") to "ship"
            id in FLOW_SKILLS -> emptyList<String>() to "the $id flow"
            else -> emptyList<String>() to "on demand"
        }
    }
}
