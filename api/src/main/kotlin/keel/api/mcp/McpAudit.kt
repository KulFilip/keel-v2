package keel.api.mcp

import com.fasterxml.jackson.databind.JsonNode
import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import keel.api.common.BadRequest
import keel.api.common.Time
import keel.api.engine.EngineClient
import keel.api.events.EngineEvent
import keel.api.events.EventService
import keel.api.projects.ProjectService
import keel.api.settings.SettingsService
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Component
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.filter.OncePerRequestFilter

/**
 * v0.16.0 every write keel's MCP server sends (`keel2 mcp --write | --admin`) says who acted: X-Keel-Via: mcp,
 * X-Keel-Client (the client's own name, a label) and X-Keel-Tool. After the request this records an `mcp.call` event
 * on the project (and thread), so its timeline shows "via MCP · <client>: <tool>". Reads are not recorded.
 */
@Component
class McpAudit(private val events: EventService, private val jdbc: JdbcTemplate) : OncePerRequestFilter() {

    override fun shouldNotFilter(request: HttpServletRequest): Boolean =
        request.method == "GET" || request.getHeader("X-Keel-Via") != "mcp" || !request.requestURI.startsWith("/api/")

    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        try {
            chain.doFilter(request, response)
        } finally {
            runCatching { record(request, response.status) }.onFailure { logger.warn("could not record an MCP call: ${it.message}") }
        }
    }

    private fun record(request: HttpServletRequest, status: Int) {
        val path = request.requestURI
        val tid = THREAD.find(path)?.groupValues?.get(1) ?: INBOX.find(path)?.groupValues?.get(1)
        val pid = PROJECT.find(path)?.groupValues?.get(1)
            ?: tid?.let { jdbc.query("SELECT project_id FROM threads WHERE id = ?", { rs, _ -> rs.getString(1) }, it).firstOrNull() }
            ?: return
        val client = request.getHeader("X-Keel-Client")?.take(80)?.ifBlank { null } ?: "an MCP client"
        val tool = request.getHeader("X-Keel-Tool")?.take(80)?.ifBlank { null } ?: "a tool"
        events.ingest(listOf(EngineEvent("mcp.call", tid ?: "mcp", pid, "mcp", Time.now(), null, mapOf(
            "via" to "mcp", "client" to client, "tool" to tool, "method" to request.method, "path" to path,
            "ok" to (status < 400), "status" to status,
        ))))
    }

    companion object {
        private val PROJECT = Regex("^/api/projects/([^/]+)")
        private val THREAD = Regex("^/api/threads/([^/]+)")
        private val INBOX = Regex("^/api/inbox/(?!tasks/)([^/]+)/act")
    }
}

data class RunAction(val args: Map<String, Any?>? = null)

/** v0.16.0 one engine action outside a flow (keel_run_action): the engine checks the action has a level. */
@RestController
class ActionController(private val projects: ProjectService, private val engine: EngineClient, private val settings: SettingsService) {

    @PostMapping("/api/projects/{pid}/actions/{name}")
    fun run(@PathVariable pid: String, @PathVariable name: String, @RequestBody(required = false) body: RunAction?): JsonNode {
        if (!Regex("^[a-z_:-]{2,40}$").matches(name)) throw BadRequest("No action called $name")
        val root = projects.root(pid)
        val s = settings.effective(pid)
        return engine.post("/projects/$pid/actions/$name", mapOf("root" to root.toString(), "args" to (body?.args ?: emptyMap<String, Any?>()),
            "settings" to mapOf("run_mode" to s.runMode)), long = true)
    }
}
