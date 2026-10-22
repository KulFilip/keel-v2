package keel.api.plugins

import com.fasterxml.jackson.databind.JsonNode
import jakarta.servlet.http.HttpServletRequest
import keel.api.common.Forbidden
import keel.api.mcp.McpLevelGuard
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/projects/{pid}/db")
class DatabaseController(private val db: DatabaseService) {
    @GetMapping("/connections")
    fun list(@PathVariable pid: String): List<DbConnection> = db.list(pid)

    @PostMapping("/connections")
    fun create(@PathVariable pid: String, @RequestBody body: DbConnectionBody): Map<String, Any?> = db.create(pid, body)

    @PutMapping("/connections/{name}")
    fun update(@PathVariable pid: String, @PathVariable name: String, @RequestBody body: DbConnectionBody): DbConnection = db.update(pid, name, body)

    @DeleteMapping("/connections/{name}")
    fun delete(@PathVariable pid: String, @PathVariable name: String): Map<String, Boolean> {
        db.delete(pid, name)
        return mapOf("ok" to true)
    }

    @PostMapping("/connections/{name}/test")
    fun test(@PathVariable pid: String, @PathVariable name: String): Map<String, Any?> = db.test(pid, name)

    @GetMapping("/suggest")
    fun suggest(@PathVariable pid: String): JsonNode = db.suggest(pid)

    @GetMapping("/schema")
    fun schema(@PathVariable pid: String, @RequestParam(required = false) connection: String?): JsonNode = db.schema(pid, connection)

    /** v0.16.1 an MCP call at the read level may read (keel_db_query), never change (McpLevelGuard lets the route through at read). */
    @PostMapping("/query")
    fun query(@PathVariable pid: String, @RequestBody body: DbQueryBody, request: HttpServletRequest): JsonNode {
        if (body.change && request.getAttribute(McpLevelGuard.LEVEL_ATTR) == "read") {
            throw Forbidden("This needs the MCP write level: run keel2 mcp --write", "A read-level MCP server can only read the database.")
        }
        return db.query(pid, body)
    }
}
