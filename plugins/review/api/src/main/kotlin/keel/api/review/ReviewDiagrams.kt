package keel.api.review

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import keel.api.common.Conflict
import keel.api.engine.EngineClient
import keel.api.engine.EngineDown
import keel.api.projects.ProjectService
import org.slf4j.LoggerFactory
import org.springframework.context.ApplicationContext
import org.springframework.stereotype.Service
import java.util.Collections

/**
 * The overview's diagrams (the Database and System tabs): what a review changes in the database, before -> after, and
 * the parts of the system it touches. The engine reads them from git with no model (keel_plugin_review/diagrams); the
 * answer is kept per review and head commit, so a tab opens at once until the code moves on.
 *
 * "Before" may come from the Database plugin's live schema (read only) when the project has a connection and the change
 * touches database files; the engine falls back to the base branch's migrations when the live database already holds
 * the change. The Database plugin is optional: without it (or a connection) the base branch's migrations are used.
 */
@Service
class ReviewDiagramsService(
    private val reviews: ReviewService,
    private val projects: ProjectService,
    private val engine: EngineClient,
    private val mapper: ObjectMapper,
    private val context: ApplicationContext,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    companion object {
        const val KEEP = 64
        /** A changed path that may hold the database: only then is the live schema asked for. */
        val DB_PATH = Regex("(?i)(^|/)(migrations?|migrate|changelogs?|versions|flyway|liquibase|entity|entities|models?)(/|\\.py$)|\\.sql$|" +
            "(^|/)Version\\d+\\.php$|schema\\.(prisma|rb)$")
    }

    private val cache: MutableMap<String, JsonNode> = Collections.synchronizedMap(object : LinkedHashMap<String, JsonNode>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, JsonNode>?) = size > KEEP
    })

    fun diagrams(pid: String, key: String, refresh: Boolean = false): JsonNode {
        val r = reviews.refs(pid, key)
        val id = "$pid|$key|${r.base}|${r.head}"
        if (!refresh) cache[id]?.let { return it }
        val root = projects.root(pid)
        val files = ReviewGit.files(root, r.base, r.head)
        val live = if (files.any { DB_PATH.containsMatchIn(it.path) }) liveSchema(pid) else null
        val body = mapOf(
            "root" to root.toString(), "base" to r.base, "head" to r.head,
            "files" to files.map { mapOf("path" to it.path, "status" to it.status, "from" to it.from) },
            "live" to live?.second, "live_name" to live?.first,
        )
        val answer = try {
            engine.post("/plugins/review/${pid}/diagrams", body, long = true)
        } catch (e: EngineDown) {
            throw Conflict("The engine is not running, so keel cannot draw the diagrams", "Start keel's engine, then open the tab again.")
        }
        (answer as? ObjectNode)?.put("key", key)
        cache[id] = answer
        return answer
    }

    /**
     * The Database plugin's schema of the project's default connection (local, else test, else the first), read only,
     * or null: the plugin is not installed or off here, there is no connection, or the database does not answer. The
     * plugin is optional, so it is found by its bean's name, never compiled against.
     */
    internal fun liveSchema(pid: String): Pair<String?, JsonNode>? {
        val bean = runCatching { context.getBean("databaseService") }.getOrNull() ?: return null
        return try {
            val m = bean.javaClass.getMethod("schema", String::class.java, String::class.java, Boolean::class.javaPrimitiveType)
            val schema = m.invoke(bean, pid, null, false) as? JsonNode ?: return null
            if (schema["tables"]?.isArray != true) return null
            (schema["connection"]?.asText()?.takeIf { it.isNotBlank() }) to schema
        } catch (e: Exception) {
            log.debug("no live schema for {}: {}", pid, (e.cause ?: e).message)
            null
        }
    }
}
