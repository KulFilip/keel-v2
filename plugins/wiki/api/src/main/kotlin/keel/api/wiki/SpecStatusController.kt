package keel.api.wiki

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/** The Wiki's spec status: every spec of the project with the flow that built it (the menu's pills and the spec page). */
@RestController
@RequestMapping("/api/projects/{pid}/specs")
class SpecStatusController(private val specs: SpecStatusService) {

    @GetMapping("/status")
    fun status(@PathVariable pid: String): List<SpecStatus> = specs.status(pid)
}
