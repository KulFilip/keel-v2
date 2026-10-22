package keel.api.jobs

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/projects/{pid}/flows/{tid}")
class StepRunController(private val runs: StepRunService) {

    /** Each step's calls added up: tries, working time, tokens, cost, the model and effort that ran, the result line. */
    @GetMapping("/step-runs")
    fun stepRuns(@PathVariable pid: String, @PathVariable tid: String): List<StepRun> = runs.of(pid, tid)
}
