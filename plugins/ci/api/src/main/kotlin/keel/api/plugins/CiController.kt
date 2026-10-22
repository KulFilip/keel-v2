package keel.api.plugins

import com.fasterxml.jackson.databind.JsonNode
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/projects/{pid}/ci")
class CiController(private val ci: CiService) {
    @GetMapping("/runs")
    fun runs(@PathVariable pid: String, @RequestParam(required = false) branch: String?): JsonNode = ci.runs(pid, branch)

    @GetMapping("/runs/{id}")
    fun run(@PathVariable pid: String, @PathVariable id: Long): JsonNode = ci.run(pid, id)

    @PostMapping("/runs/{id}/rerun")
    fun rerun(@PathVariable pid: String, @PathVariable id: Long): JsonNode = ci.rerun(pid, id)

    /** Start the ci-fix flow for a failed run (default: the newest failed run of the project folder's branch). */
    @PostMapping("/fix")
    fun fix(@PathVariable pid: String, @RequestBody(required = false) body: CiFixBody?): JsonNode = ci.fix(pid, body?.run)

    /** Look now instead of waiting for the watcher (what it would tell). */
    @PostMapping("/check")
    fun check(@PathVariable pid: String): Map<String, List<Long>> = mapOf("told" to ci.check(pid))
}
