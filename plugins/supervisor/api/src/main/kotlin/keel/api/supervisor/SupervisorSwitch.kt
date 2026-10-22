package keel.api.supervisor

import com.fasterxml.jackson.databind.JsonNode
import keel.api.engine.EngineClient
import keel.api.plugins.PluginService
import keel.api.plugins.PluginSwitched
import keel.api.projects.ProjectService
import keel.api.settings.SettingKey
import keel.api.settings.SettingsChanged
import keel.api.settings.SettingsSection
import keel.api.settings.SettingsService
import keel.api.settings.SimpleSettingsSection
import org.slf4j.LoggerFactory
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Component
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/**
 * The Supervisor's on/off switches. keel's settings hold them (`plugins.supervisor.on`): General is the keel-wide
 * switch, off until the person turns it on; a project may set its own (else it follows General). The plugin's own
 * switch per project (Control › Plugins) comes on top: off there, it is off. A flow may also have its own switch
 * (POST /api/projects/{pid}/flows/{tid}/supervisor {on}).
 *
 * The engine part acts on them while flows run, so every change is sent to it at once (POST /supervisor/switch), and
 * all of them when the api starts. Off keel-wide, the engine part listens to nothing and calls no model.
 */
@Component
class SupervisorSwitch(
    private val settings: SettingsService,
    private val plugins: PluginService,
    private val projects: ProjectService,
    private val engine: EngineClient,
) {
    private val log = LoggerFactory.getLogger(SupervisorSwitch::class.java)

    fun keelOn(): Boolean = settings.plugin(NAME).general()[KEY] == true

    /** The project's own switch: true, false, or null (it follows General). */
    fun own(pid: String): Boolean? = settings.plugin(NAME).overrides(pid)[KEY] as? Boolean

    fun projectOn(pid: String): Boolean = own(pid) ?: keelOn()

    fun pluginOn(pid: String): Boolean = plugins.on(pid, NAME)

    fun view(pid: String): Map<String, Any?> = mapOf(
        "keel" to keelOn(), "own" to own(pid), "project" to projectOn(pid), "plugin" to pluginOn(pid),
        "on" to (keelOn() && pluginOn(pid) && projectOn(pid)),
    )

    fun setKeel(on: Boolean) {
        settings.updateGeneral(mapOf(SETTING to on))
    }

    /** null: the project follows General again. */
    fun setProject(pid: String, on: Boolean?) {
        settings.updateProject(pid, mapOf(SETTING to on))
    }

    /** Sends the switches to the engine: the keel-wide one and one project's, or every project's (pid null). */
    fun push(pid: String?) {
        val ids = if (pid == null) projects.rows().map { it.id } else listOf(pid)
        val body = mapOf("keel" to keelOn(),
            "projects" to ids.associateWith { mapOf("on" to projectOn(it), "plugin" to pluginOn(it)) })
        runCatching { engine.post("/supervisor/switch", body) }
            .onFailure { log.warn("could not send the Supervisor's switches to the engine: {}", it.message) }
    }

    @EventListener
    fun settingsChanged(e: SettingsChanged) {
        if (e.keys.any { it.startsWith("plugins.$NAME.") }) push(e.projectId)
    }

    @EventListener
    fun pluginSwitched(e: PluginSwitched) {
        if (e.plugin == NAME) push(e.projectId.takeIf { it != "*" })
    }

    @EventListener(ApplicationReadyEvent::class)
    fun ready() = push(null)

    companion object {
        const val NAME = "supervisor"
        const val KEY = "on"
        const val SETTING = "plugins.supervisor.on"
    }
}

/** Its key in keel's settings: off until the person turns it on. */
@Configuration
class SupervisorSettings {
    @Bean
    fun supervisorSettingsSection(): SettingsSection = SimpleSettingsSection("supervisor", "Supervisor",
        listOf(SettingKey(SupervisorSwitch.SETTING, "bool", false)), 90)
}

/**
 *     GET|POST /api/supervisor/switch                    {on}: the keel-wide switch
 *     GET|POST /api/projects/{pid}/supervisor/switch     {on: true | false | null}: the project's (null = follow General)
 */
@RestController
@RequestMapping("/api")
class SupervisorSwitchController(private val switch: SupervisorSwitch, private val projects: ProjectService,
                                 private val engine: EngineClient) {
    @GetMapping("/supervisor/switch")
    fun keel(): Map<String, Any?> = mapOf("on" to switch.keelOn(),
        "engine" to runCatching<JsonNode> { engine.get("/supervisor/switch") }.getOrNull())

    @PostMapping("/supervisor/switch")
    fun setKeel(@RequestBody body: Map<String, Any?>): Map<String, Any?> {
        switch.setKeel(body["on"] == true)
        return keel()
    }

    @GetMapping("/projects/{pid}/supervisor/switch")
    fun project(@PathVariable pid: String): Map<String, Any?> {
        projects.require(pid)
        return switch.view(pid)
    }

    @PostMapping("/projects/{pid}/supervisor/switch")
    fun setProject(@PathVariable pid: String, @RequestBody body: Map<String, Any?>): Map<String, Any?> {
        projects.require(pid)
        switch.setProject(pid, body["on"] as? Boolean)
        return switch.view(pid)
    }
}
