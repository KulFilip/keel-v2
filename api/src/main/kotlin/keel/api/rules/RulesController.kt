package keel.api.rules

import com.fasterxml.jackson.databind.JsonNode
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

data class RulePackBody(val yaml: String = "")

/** v0.16.2 the Rules page and "Rules now" (RulesService). Writes are admin for MCP clients (McpLevels.kt). */
@RestController
@RequestMapping("/api")
class RulesController(private val rules: RulesService) {

    @GetMapping("/projects/{pid}/rules")
    fun view(@PathVariable pid: String): JsonNode = rules.view(pid)

    /** Change guards / mcp / rules / boundaries in the project's .keel/config.yml. */
    @PutMapping("/projects/{pid}/rules/config")
    fun config(@PathVariable pid: String, @RequestBody patch: Map<String, Any?>): JsonNode = rules.setConfig(pid, patch)

    @GetMapping("/rules/library")
    fun library(): JsonNode = rules.library()

    @PostMapping("/projects/{pid}/rules/library/{id}/install")
    fun install(@PathVariable pid: String, @PathVariable id: String): JsonNode = rules.install(pid, id)

    /** A new pack (the form, the YAML view, or an import): .keel/rules/<id>.yaml. */
    @PostMapping("/projects/{pid}/rules/packs")
    fun add(@PathVariable pid: String, @RequestBody body: RulePackBody): JsonNode = rules.save(pid, body.yaml, null)

    @PutMapping("/projects/{pid}/rules/packs/{id}")
    fun edit(@PathVariable pid: String, @PathVariable id: String, @RequestBody body: RulePackBody): JsonNode =
        rules.save(pid, body.yaml, id)

    @DeleteMapping("/projects/{pid}/rules/packs/{id}")
    fun remove(@PathVariable pid: String, @PathVariable id: String): JsonNode = rules.remove(pid, id)

    @GetMapping("/projects/{pid}/rules/packs/{id}/export")
    fun export(@PathVariable pid: String, @PathVariable id: String): ResponseEntity<String> =
        ResponseEntity.ok()
            .contentType(MediaType.parseMediaType("text/yaml;charset=UTF-8"))
            .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=$id.rules.yaml")
            .body(rules.export(pid, id))

    /** Validate a pack and dry-run it on the project's recent tool calls. Saves nothing. */
    @PostMapping("/projects/{pid}/rules/check")
    fun check(@PathVariable pid: String, @RequestBody body: RulePackBody): JsonNode = rules.check(pid, body.yaml)

    @GetMapping("/threads/{tid}/rules-now")
    fun now(@PathVariable tid: String): JsonNode = rules.now(tid)
}
