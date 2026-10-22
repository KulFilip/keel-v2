package keel.api.workflows

import com.fasterxml.jackson.databind.JsonNode
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/** The workflow marketplace's routes (docs/plugins/21-workflow-marketplace.md §9). */
@RestController
@RequestMapping("/api")
class MarketWorkflowController(private val market: MarketWorkflows) {
    @GetMapping("/marketplace/workflows")
    fun search(@RequestParam(required = false) q: String?, @RequestParam(required = false) category: String?,
               @RequestParam(required = false) project: String?): JsonNode = market.search(q, category, project)

    @GetMapping("/marketplace/workflows/{name}")
    fun detail(@PathVariable name: String, @RequestParam(required = false) project: String?): JsonNode = market.detail(name, project)

    @PostMapping("/projects/{pid}/workflows/market/install")
    fun install(@PathVariable pid: String, @RequestBody body: MarketInstallBody): MarketInstallResult = market.install(pid, body)

    @PostMapping("/projects/{pid}/workflows/market/{wid}/update")
    fun update(@PathVariable pid: String, @PathVariable wid: String, @RequestBody(required = false) body: MarketUpdateBody?): MarketUpdateResult =
        market.update(pid, wid, body ?: MarketUpdateBody())

    /** A zip: <name>-<version>.yaml, workflows/<name>.yml and PUBLISH.md. keel never signs: the person does. */
    @GetMapping("/workflows/{wid}/publish")
    fun publish(@PathVariable wid: String, @RequestParam(required = false) name: String?, @RequestParam(required = false) version: String?,
                @RequestParam(required = false) summary: String?, @RequestParam(required = false) category: String?,
                @RequestParam(required = false) publisher: String?): ResponseEntity<ByteArray> {
        val (file, bytes) = market.publish(wid, name, version, summary, category, publisher)
        return ResponseEntity.ok()
            .contentType(MediaType.parseMediaType("application/zip"))
            .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=$file")
            .body(bytes)
    }
}
