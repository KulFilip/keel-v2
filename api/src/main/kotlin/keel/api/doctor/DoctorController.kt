package keel.api.doctor

import com.fasterxml.jackson.databind.JsonNode
import keel.api.engine.EngineClient
import keel.api.events.EventHub
import keel.api.projects.ProjectService
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

data class ExcludeBody(val path: String = "")

@RestController
@RequestMapping("/api")
class DoctorController(private val doctor: WorkspaceDoctor, private val hub: EventHub, private val engine: EngineClient,
                       private val projects: ProjectService) {

    /** 0.18.57 the commands in .keel/config.yml that cannot run as written (a compose service, script or target that is
     *  gone), each with the file and line: {stale: [{key, command, problem, file, line, missing_in}], lines}. */
    @GetMapping("/projects/{pid}/doctor/config")
    fun config(@PathVariable pid: String): JsonNode =
        engine.get("/config-check?root={root}", mapOf("root" to projects.root(pid).toString()))

    /** Looks at the uncommitted files and proposes commit / stash / ignore / keep per group. Changes nothing. */
    @PostMapping("/projects/{pid}/doctor/workspace")
    fun diagnose(@PathVariable pid: String): Diagnosis = doctor.diagnose(pid)

    /** Runs the plan the user approved (plain git; nothing is deleted). */
    @PostMapping("/projects/{pid}/doctor/workspace/apply")
    fun apply(@PathVariable pid: String, @RequestBody body: ApplyBody): Applied =
        doctor.apply(pid, body).also { hub.publish(pid, "project.changed", mapOf("id" to pid)) }

    /** 0.18.57 "Ignore this path" at a refused start: one untracked path into .git/info/exclude (this computer only). */
    @PostMapping("/projects/{pid}/doctor/workspace/exclude")
    fun exclude(@PathVariable pid: String, @RequestBody body: ExcludeBody): Applied =
        doctor.exclude(pid, body.path).also { hub.publish(pid, "project.changed", mapOf("id" to pid)) }
}
