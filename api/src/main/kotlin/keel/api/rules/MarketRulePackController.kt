package keel.api.rules

import com.fasterxml.jackson.databind.JsonNode
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

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
