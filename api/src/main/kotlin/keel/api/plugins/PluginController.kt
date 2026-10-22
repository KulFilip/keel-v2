package keel.api.plugins

import com.fasterxml.jackson.databind.JsonNode
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api")
class PluginController(private val plugins: PluginService) {
    @GetMapping("/plugins")
    fun catalog(): JsonNode = plugins.catalog()

    @GetMapping("/projects/{pid}/plugins")
    fun list(@PathVariable pid: String): List<Map<String, Any?>> = plugins.forProject(pid)

    /** Connections › GitHub: is a token set (the value never leaves keel). */
    @GetMapping("/github")
    fun github(): Map<String, Any?> = plugins.github()

    /** keel2 mcp --write: an acting tool asks the person in the Inbox; it reads the answer with GET /plugins/asks/{id}. */
    @PostMapping("/projects/{pid}/plugins/ask")
    fun ask(@PathVariable pid: String, @RequestBody body: PluginAskBody): JsonNode = plugins.ask(pid, body)

    @GetMapping("/plugins/asks/{qid}")
    fun asked(@PathVariable qid: String): JsonNode = plugins.asked(qid)

    @PutMapping("/projects/{pid}/plugins/{name}")
    fun set(@PathVariable pid: String, @PathVariable name: String, @RequestBody body: PluginSwitch): List<Map<String, Any?>> =
        plugins.set(pid, name, body)
}
