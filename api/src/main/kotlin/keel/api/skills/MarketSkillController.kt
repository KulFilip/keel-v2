package keel.api.skills

import com.fasterxml.jackson.databind.JsonNode
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/** The marketplace's skills (keel 0.18.6). Install is write for MCP (McpLevels.kt); remove (DELETE a skill) is admin. */
@RestController
@RequestMapping("/api")
class MarketSkillController(private val market: MarketSkills) {
    @GetMapping("/marketplace/skills")
    fun search(@RequestParam(required = false) q: String?, @RequestParam(required = false) category: String?,
               @RequestParam(required = false) project: String?): JsonNode = market.search(q, category, project)

    @GetMapping("/marketplace/skills/{name}")
    fun detail(@PathVariable name: String, @RequestParam(required = false) project: String?): JsonNode = market.detail(name, project)

    @PostMapping("/projects/{pid}/skills/market/install")
    fun install(@PathVariable pid: String, @RequestBody body: MarketSkillInstall): JsonNode = market.install(pid, body)
}
