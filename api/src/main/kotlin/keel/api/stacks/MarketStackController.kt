package keel.api.stacks

import com.fasterxml.jackson.databind.JsonNode
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/** The marketplace's stacks (keel 0.18.9). Install is write for MCP (McpLevels.kt), like removing a stack. */
@RestController
@RequestMapping("/api")
class MarketStackController(private val market: MarketStacks, private val hub: keel.api.events.EventHub) {
    @GetMapping("/marketplace/stacks")
    fun search(@RequestParam(required = false) q: String?, @RequestParam(required = false) category: String?,
               @RequestParam(required = false) project: String?): JsonNode = market.search(q, category, project)

    @GetMapping("/marketplace/stacks/{name}")
    fun detail(@PathVariable name: String, @RequestParam(required = false) project: String?): JsonNode = market.detail(name, project)

    @PostMapping("/projects/{pid}/stacks/market/install")
    fun install(@PathVariable pid: String, @RequestBody body: MarketStackInstall): JsonNode = market.install(pid, body).also {
        // keel 0.18.28 the dashboards load the project's stack languages again
        runCatching { hub.publish(pid, "project.changed", mapOf("id" to pid, "stacks" to true)) }
    }
}
