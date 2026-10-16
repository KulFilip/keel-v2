package keel.api.mcp

import com.fasterxml.jackson.databind.ObjectMapper
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import keel.api.common.BadRequest
import keel.api.common.ErrorBody
import keel.api.common.Forbidden
import keel.api.common.KeelProperties
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.filter.OncePerRequestFilter
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * v0.16.1 MCP level tokens: three random tokens (read, write, admin), made at start and kept only in memory. keel's MCP
 * server gets the one for its level from POST /api/mcp/token, which needs the internal token (KEEL_INTERNAL_TOKEN: keel2
 * and the engine have it, agents never do), and sends it as X-Keel-Mcp-Token; [McpLevelGuard] checks it.
 */
@Component
class McpTokens {
    private val tokens: Map<String, String> = LEVELS.associateWith { newToken() }

    fun tokenFor(level: String): String = tokens[level] ?: throw BadRequest("No MCP level called \"$level\"", "One of: ${LEVELS.joinToString(", ")}")

    /** The level a token proves (null: not one of ours). Every token is compared, in constant time. */
    fun levelOf(token: String?): String? {
        if (token.isNullOrEmpty()) return null
        var found: String? = null
        for ((level, t) in tokens) if (same(token, t)) found = level
        return found
    }

    companion object {
        val LEVELS = listOf("read", "write", "admin")
        fun rank(level: String): Int = LEVELS.indexOf(level)
        fun same(a: String, b: String): Boolean = MessageDigest.isEqual(a.toByteArray(), b.toByteArray())
        private val random = SecureRandom()
        private fun newToken(): String = ByteArray(32).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }
    }
}

data class McpTokenRequest(val level: String = "")

@RestController
class McpTokenController(private val tokens: McpTokens, private val props: KeelProperties) {

    /** The token of one MCP level, only for a caller with the internal token (keel2 mcp, the engine). */
    @PostMapping("/api/mcp/token")
    fun token(@RequestHeader("X-Keel-Token", required = false) internal: String?, @RequestBody body: McpTokenRequest): Map<String, String> {
        val expected = props.internalToken
        if (expected.isEmpty() || internal == null || !McpTokens.same(internal, expected)) {
            throw Forbidden("Wrong or missing X-Keel-Token", "Only keel2 mcp and keel's engine can get an MCP level token.")
        }
        return mapOf("level" to body.level, "token" to tokens.tokenFor(body.level))
    }
}

/**
 * v0.16.1 the api refuses an MCP call above the level its token proves. It only looks at requests that say they come
 * from MCP (X-Keel-Via: mcp, or an X-Keel-Mcp-Token header) and at the MCP-only route POST /api/projects/{pid}/actions/{name};
 * the web app sends neither header, so it works as before. Without a valid token a request is at the read level.
 * GET is fine at read; other methods need write; [admin] routes need admin; an action needs the level the engine gives
 * it ([READ_ACTIONS], [ADMIN_ACTIONS], others write). It runs inside [McpAudit], so a refused call is still recorded.
 */
@Component
@Order(Ordered.LOWEST_PRECEDENCE)
class McpLevelGuard(private val tokens: McpTokens, private val mapper: ObjectMapper) : OncePerRequestFilter() {

    override fun shouldNotFilter(request: HttpServletRequest): Boolean {
        val path = request.requestURI
        if (!path.startsWith("/api/") || path == "/api/mcp/token") return true
        return request.getHeader("X-Keel-Via") != "mcp" && request.getHeader(TOKEN_HEADER) == null && action(request) == null
    }

    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        val has = tokens.levelOf(request.getHeader(TOKEN_HEADER)) ?: "read"
        val need = need(request)
        if (McpTokens.rank(has) < McpTokens.rank(need)) {
            response.status = HttpServletResponse.SC_FORBIDDEN
            response.contentType = MediaType.APPLICATION_JSON_VALUE
            val flag = if (need == "admin") "--admin" else "--write"
            mapper.writeValue(response.outputStream, ErrorBody("This needs the MCP $need level: run keel2 mcp $flag",
                "This MCP server is at the $has level; a level comes with a token from keel, not from the client."))
            return
        }
        request.setAttribute(LEVEL_ATTR, has)
        chain.doFilter(request, response)
    }

    /** The level a request needs. */
    fun need(request: HttpServletRequest): String {
        val method = request.method
        if (method == "GET" || method == "HEAD" || method == "OPTIONS") return "read"
        action(request)?.let { name ->
            return when (name) { in READ_ACTIONS -> "read"; in ADMIN_ACTIONS -> "admin"; else -> "write" }
        }
        val path = request.requestURI.trimEnd('/')
        if (method == "POST" && DB_QUERY.matches(path)) return "read"     // a change needs write: DatabaseController checks the body
        // step 4: keel_plugin_request is a read-level tool (agents run keel2 mcp --read-only); it only opens an Inbox
        // request a person approves, and the marketplace rule "agents may ask" still decides (PluginRequests)
        if (method == "POST" && path == PLUGIN_REQUESTS) return "read"
        if (method == "POST" && READ_POSTS.any { it.matches(path) }) return "read"
        if (ADMIN.any { (m, re) -> m == method && re.matches(path) }) return "admin"
        return "write"
    }

    private fun action(request: HttpServletRequest): String? =
        if (request.method == "POST") ACTION.find(request.requestURI.trimEnd('/'))?.groupValues?.get(1) else null

    companion object {
        const val TOKEN_HEADER = "X-Keel-Mcp-Token"
        /** The level an MCP request proved (only set on MCP requests): "read", "write" or "admin". */
        const val LEVEL_ATTR = "keel.mcp.level"

        /**
         * The engine actions MCP may run at the read level. Twin of the "read" names in engine
         * runtime/action_docs.py ACTION_LEVELS: change both together (McpLevelsApiTest and engine test_mcp.py pin them).
         */
        val READ_ACTIONS = setOf("audit", "trace", "trace_strict", "arch", "arch_detect", "coverage_report", "lint_scope",
            "lint_report", "review_lenses")

        /** The engine actions that need the admin level. Twin of the "admin" names in engine action_docs.ACTION_LEVELS. */
        val ADMIN_ACTIONS = setOf("arch_set", "open_pr")

        private val ACTION = Regex("^/api/projects/[^/]+/actions/([^/]+)$")
        private val DB_QUERY = Regex("^/api/projects/[^/]+/db/query$")
        private const val PLUGIN_REQUESTS = "/api/plugins/requests"
        private val ADMIN = listOf(
            "POST" to Regex("^/api/threads/[^/]+/stop$"),
            "DELETE" to Regex("^/api/projects/[^/]+/flows/[^/]+$"),
            "POST" to Regex("^/api/projects$"),
            "POST" to Regex("^/api/projects/bulk$"),
            "DELETE" to Regex("^/api/projects/[^/]+$"),
            "PUT" to Regex("^/api/workflows/[^/]+$"),
            "DELETE" to Regex("^/api/workflows/[^/]+$"),
            // v0.17.2 keel's rules: a change decides what agents may do
            "PUT" to Regex("^/api/projects/[^/]+/rules/config$"),
            "POST" to Regex("^/api/projects/[^/]+/rules/library/[^/]+/install$"),
            "POST" to Regex("^/api/projects/[^/]+/rules/packs$"),
            "PUT" to Regex("^/api/projects/[^/]+/rules/packs/[^/]+$"),
            "DELETE" to Regex("^/api/projects/[^/]+/rules/packs/[^/]+$"),
            "POST" to Regex("^/api/projects/[^/]+/rule-packs/(install|uninstall)$"),
        )
        /** Reads that are POSTs (they change nothing): a rule pack's check and dry-run. */
        private val READ_POSTS = listOf(
            Regex("^/api/projects/[^/]+/rules/check$"),
            // keel's ASCII diagrams (keel TUI, keel2 mcp's diagram tools): drawing changes nothing
            Regex("^/api/diagrams/ascii$"),
        )
    }
}
