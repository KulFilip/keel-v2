package keel.api.diagrams

import com.fasterxml.jackson.databind.JsonNode
import keel.api.engine.EngineClient
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RestController

/**
 * keel's ASCII diagrams: one renderer, the engine's keel_engine/diagrams.py (docs/plans/keel-tui.md). The body is
 * `{kind, data, width?, max_lines?, zoom?}` (kind: workflow, flow, map-system, map-modules, map-er, graph); the answer
 * `{kind, text, lines}`. keel TUI draws with it; keel2 mcp's diagram tools import the renderer directly. Drawing changes
 * nothing, so an MCP client at the read level may call it (McpLevelGuard READ_POSTS).
 */
@RestController
class DiagramController(private val engine: EngineClient) {

    @PostMapping("/api/diagrams/ascii")
    fun ascii(@RequestBody body: JsonNode): JsonNode = engine.post("/diagrams/ascii", body)
}
