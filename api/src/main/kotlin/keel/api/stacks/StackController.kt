package keel.api.stacks

import com.fasterxml.jackson.databind.JsonNode
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/** Stacks (Build › Stacks). keel 0.18.9: check and suggest are reads; save, remove and off are write for MCP (McpLevels). */
@RestController
class StackController(private val stacks: StackService, private val hub: keel.api.events.EventHub) {
    /** keel 0.18.28 a stack changed: the dashboards load its languages again (and the project's view) without a reload. */
    private fun <T> changed(pid: String, out: T): T = out.also {
        runCatching { hub.publish(pid, "project.changed", mapOf("id" to pid, "stacks" to true)) }
    }

    @GetMapping("/api/projects/{pid}/stacks")
    fun list(@PathVariable pid: String): List<Stack> = stacks.list(pid)

    /** keel 0.18.28 the highlight.js languages of the project's stacks: {languages: [{name, ext, stacks}]}. */
    @GetMapping("/api/projects/{pid}/languages")
    fun languages(@PathVariable pid: String): Map<String, Any?> = stacks.languages(pid)

    @GetMapping("/api/projects/{pid}/stacks/suggest")
    fun suggest(@PathVariable pid: String, @RequestParam(required = false) lane: String?): JsonNode = stacks.suggest(pid, lane)

    @GetMapping("/api/projects/{pid}/stacks/{name}")
    fun one(@PathVariable pid: String, @PathVariable name: String): JsonNode = stacks.detail(pid, name)

    /** Check a stack (its YAML or the form's answers); saves nothing. */
    @PostMapping("/api/projects/{pid}/stacks/check")
    fun check(@PathVariable pid: String, @RequestBody body: StackText): JsonNode = stacks.check(pid, body)

    @PostMapping("/api/projects/{pid}/stacks/save")
    fun save(@PathVariable pid: String, @RequestBody body: StackText): JsonNode = changed(pid, stacks.save(pid, body))

    @DeleteMapping("/api/projects/{pid}/stacks/{name}")
    fun remove(@PathVariable pid: String, @PathVariable name: String): JsonNode = changed(pid, stacks.remove(pid, name))

    @PutMapping("/api/projects/{pid}/stacks/{name}/off")
    fun off(@PathVariable pid: String, @PathVariable name: String, @RequestBody body: StackOff): JsonNode = changed(pid, stacks.setOff(pid, name, body.off))

    @PostMapping("/api/projects/{pid}/stacks")
    fun create(@PathVariable pid: String, @RequestBody body: NewStack): Stack = changed(pid, stacks.create(pid, body.name.trim(), body.from))

    @PostMapping("/api/projects/{pid}/stacks/{name}/install")
    fun install(@PathVariable pid: String, @PathVariable name: String): Stack = changed(pid, stacks.install(pid, name))
}
