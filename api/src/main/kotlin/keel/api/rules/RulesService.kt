package keel.api.rules

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import keel.api.common.BadRequest
import keel.api.common.Json
import keel.api.common.NotFound
import keel.api.engine.EngineClient
import keel.api.projects.ProjectService
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * v0.16.2 keel's rules for one project (the Rules page, "Rules now" on the Flow page, MCP keel_rules).
 *
 * The rules are files in the project — `.keel/config.yml` (guards, mcp, rules, boundaries) and `.keel/rules/<id>.yaml`
 * (rule packs) — so the engine's guard reads them on every tool call. The engine owns reading and writing them
 * (runtime/rules_view.py); this service gives it the project's folder and adds what only the api has: the events
 * (recent tool calls for a pack's dry-run, the refusals of a thread).
 */
@Service
class RulesService(
    private val jdbc: JdbcTemplate,
    private val engine: EngineClient,
    private val projects: ProjectService,
    private val mapper: ObjectMapper,
) {
    private fun q(s: String) = URLEncoder.encode(s, StandardCharsets.UTF_8)
    private fun root(pid: String) = projects.root(pid).toString()

    private fun packId(id: String): String {
        if (!Regex("^[a-z0-9][a-z0-9-]{0,63}$").matches(id)) throw BadRequest("Not a rule pack id: $id", "Lower-case letters, digits and dashes.")
        return id
    }

    fun view(pid: String): JsonNode = engine.get("/rules?root=${q(root(pid))}")

    fun setConfig(pid: String, patch: Map<String, Any?>): JsonNode =
        engine.post("/rules/config", mapOf("root" to root(pid), "patch" to patch))

    fun library(): JsonNode = engine.get("/rules/library")

    fun install(pid: String, id: String): JsonNode {
        val yaml = engine.get("/rules/library/${packId(id)}").get("yaml")?.asText() ?: throw NotFound("No rule pack $id in keel's library.")
        return engine.post("/rules/packs", mapOf("root" to root(pid), "yaml" to yaml))
    }

    fun save(pid: String, yaml: String, replace: String?): JsonNode {
        if (yaml.length > MAX_BYTES) throw BadRequest("A rule pack is at most ${MAX_BYTES / 1024} KB.")
        return engine.post("/rules/packs", mapOf("root" to root(pid), "yaml" to yaml, "replace" to replace?.let { packId(it) }))
    }

    fun remove(pid: String, id: String): JsonNode = engine.delete("/rules/packs/${packId(id)}?root=${q(root(pid))}")

    fun export(pid: String, id: String): String =
        engine.get("/rules/packs/${packId(id)}?root=${q(root(pid))}").get("yaml")?.asText() ?: ""

    /** Validate a pack and run it against the project's recent tool calls (what it would have refused). */
    fun check(pid: String, yaml: String): JsonNode {
        projects.require(pid)
        return engine.post("/rules/check", mapOf("yaml" to yaml, "calls" to recentCalls(pid)))
    }

    /** The project's last tool calls, newest first: agent steps (tool, write, edit, read) and refused calls. */
    fun recentCalls(pid: String, limit: Int = 500): List<Map<String, Any?>> {
        val started = HashMap<String, Map<String, Any?>>()
        jdbc.query(
            "SELECT call_id, data_json FROM events WHERE project_id = ? AND type = 'agent.started' ORDER BY id DESC LIMIT 2000",
            { rs, _ -> rs.getString(1) to Json.readMap(rs.getString(2)) }, pid,
        ).forEach { (id, d) -> if (id != null) started[id] = d }
        return jdbc.query(
            "SELECT thread_id, type, call_id, at, data_json FROM events WHERE project_id = ? AND type IN ('agent.step', 'guard.refused') " +
                "ORDER BY id DESC LIMIT ?",
            { rs, _ ->
                val d = Json.readMap(rs.getString(5))
                val s = started[rs.getString(3) ?: ""] ?: emptyMap()
                val kind = if (rs.getString(2) == "guard.refused") "refused" else d["kind"]?.toString()
                mapOf(
                    "thread" to rs.getString(1), "at" to rs.getString(4), "kind" to kind,
                    "tool" to d["tool"], "server" to d["server"], "path" to d["path"], "command" to d["command"],
                    "text" to (d["text"] as? String)?.take(2000),
                    "phase" to (d["phase"] ?: s["phase"]), "agent" to (d["agent"] ?: s["agent"]),
                ).filterValues { it != null }
            }, pid, limit,
        ).filter { it["kind"] in CALL_KINDS }
    }

    /** "Rules now": the engine's view of the thread's phase plus its refusals from the events, grouped by reason. */
    fun now(tid: String): JsonNode {
        val pid = jdbc.query("SELECT project_id FROM threads WHERE id = ?", { rs, _ -> rs.getString(1) }, tid).firstOrNull()
            ?: throw NotFound("No flow $tid")
        val out = engine.get("/threads/${q(tid)}/rules-now") as ObjectNode
        val rows = jdbc.query(
            "SELECT at, step, data_json FROM events WHERE thread_id = ? AND type = 'guard.refused' ORDER BY id",
            { rs, _ -> Triple(rs.getString(1), rs.getString(2), Json.readMap(rs.getString(3))) }, tid,
        )
        val groups = LinkedHashMap<String, MutableMap<String, Any?>>()
        for ((at, step, d) in rows) {
            val reason = d["reason"]?.toString() ?: ""
            val key = groupKey(reason, d["path"]?.toString())
            val g = groups.getOrPut(key) {
                mutableMapOf("reason" to key, "rule" to ruleOf(reason), "count" to 0, "phase" to d["phase"], "examples" to mutableListOf<String>(),
                    "source" to (if (d["tool"] == "diff-guard") "after the step" else "before the action"))
            }
            g["count"] = (g["count"] as Int) + 1
            g["last_at"] = at
            g["step"] = step
            val ex = (d["command"] ?: d["path"])?.toString()?.take(200)
            @Suppress("UNCHECKED_CAST")
            val list = g["examples"] as MutableList<String>
            if (ex != null && ex.isNotBlank() && ex !in list && list.size < 3) list.add(ex)
        }
        out.set<JsonNode>("fired", mapper.valueToTree(groups.values.sortedByDescending { it["last_at"]?.toString() ?: "" }))
        out.put("project_id", pid)
        return out
    }

    companion object {
        const val MAX_BYTES = 64 * 1024
        val CALL_KINDS = setOf("tool", "write", "edit", "read", "refused")
        private val RULE = Regex("\\(rule ([a-z0-9-]+/[a-z0-9-]+)\\)")

        fun ruleOf(reason: String): String? = RULE.find(reason)?.groupValues?.get(1)

        /** One group per rule: a pack rule by its id, any other refusal by its reason without the file it named. */
        fun groupKey(reason: String, path: String?): String {
            var r = reason.trim()
            if (!path.isNullOrBlank()) {
                r = r.removePrefix("Shell write to ").removePrefix("$path: ").removePrefix("$path ").replace(path, "…")
            }
            return r.replaceFirstChar { it.uppercase() }.take(300)
        }
    }
}
