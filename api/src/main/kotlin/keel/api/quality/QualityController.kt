package keel.api.quality

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/quality")
class QualityController(private val quality: QualityService) {
    @GetMapping
    fun view(): QualityView = quality.view()

    @PostMapping("/runs")
    fun start(@RequestBody body: StartQuality): QualityRun = quality.start(body)

    @GetMapping("/runs/{id}")
    fun run(@PathVariable id: String): QualityRun = quality.run(id)

    @PostMapping("/runs/{id}/stop")
    fun stop(@PathVariable id: String): QualityRun = quality.stop(id)

    @PutMapping("/schedule")
    fun schedule(@RequestBody body: QualitySchedule): QualitySchedule = quality.saveSchedule(body)
}
