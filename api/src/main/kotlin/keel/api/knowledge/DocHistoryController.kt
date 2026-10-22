package keel.api.knowledge

import keel.api.common.BadRequest
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api")
class DocHistoryController(private val docs: DocHistoryService) {

    @GetMapping("/projects/{pid}/docs/history")
    fun files(@PathVariable pid: String): List<DocFile> = docs.files(pid)

    @GetMapping("/projects/{pid}/docs/history/versions")
    fun versions(@PathVariable pid: String, @RequestParam path: String): List<DocVersion> = docs.versions(pid, path)

    @GetMapping("/projects/{pid}/docs/history/versions/{id}")
    fun version(@PathVariable pid: String, @PathVariable id: String): DocVersion = docs.version(pid, id)

    @GetMapping("/projects/{pid}/docs/history/diff")
    fun diff(@PathVariable pid: String, @RequestParam path: String, @RequestParam from: String, @RequestParam to: String): DocDiff =
        docs.diff(pid, path, from, to)

    @PostMapping("/projects/{pid}/docs/history/restore")
    fun restore(@PathVariable pid: String, @RequestBody body: RestoreBody): DocVersion {
        if (body.versionId.isBlank()) throw BadRequest("version_id is missing")
        return docs.restore(pid, body.versionId)
    }

    @GetMapping("/threads/{tid}/applied")
    fun applied(@PathVariable tid: String): FlowApplied = docs.flow(tid)
}
