package keel.api.mcp

import com.fasterxml.jackson.databind.JsonNode
import keel.api.common.BadRequest
import keel.api.engine.EngineClient
import keel.api.projects.ProjectService
import keel.api.settings.SettingsService
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RestController

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
