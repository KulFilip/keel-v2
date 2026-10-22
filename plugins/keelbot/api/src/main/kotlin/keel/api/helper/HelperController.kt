package keel.api.helper

import com.fasterxml.jackson.databind.JsonNode
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/projects/{pid}/helper")
class HelperController(private val helper: HelperService) {
    @GetMapping("/sessions")
    fun list(@PathVariable pid: String): JsonNode = helper.list(pid)

    @PostMapping("/sessions")
    fun create(@PathVariable pid: String, @RequestBody(required = false) body: HelperCreate?): JsonNode = helper.create(pid, body ?: HelperCreate())

    @GetMapping("/sessions/{sid}")
    fun get(@PathVariable pid: String, @PathVariable sid: String): JsonNode = helper.get(pid, sid)

    @PatchMapping("/sessions/{sid}")
    fun patch(@PathVariable pid: String, @PathVariable sid: String, @RequestBody body: HelperPatch): JsonNode = helper.patch(pid, sid, body)

    @DeleteMapping("/sessions/{sid}")
    fun delete(@PathVariable pid: String, @PathVariable sid: String): JsonNode = helper.delete(pid, sid)

    @GetMapping("/folders")
    fun folders(@PathVariable pid: String): JsonNode = helper.folders(pid)

    @PostMapping("/folders")
    fun createFolder(@PathVariable pid: String, @RequestBody body: HelperFolderBody): JsonNode = helper.createFolder(pid, body)

    @PatchMapping("/folders/{fid}")
    fun renameFolder(@PathVariable pid: String, @PathVariable fid: String, @RequestBody body: HelperFolderBody): JsonNode =
        helper.renameFolder(pid, fid, body)

    @DeleteMapping("/folders/{fid}")
    fun deleteFolder(@PathVariable pid: String, @PathVariable fid: String): JsonNode = helper.deleteFolder(pid, fid)

    @PostMapping("/sessions/{sid}/turn")
    fun turn(@PathVariable pid: String, @PathVariable sid: String, @RequestBody body: HelperTurn): JsonNode = helper.turn(pid, sid, body)

    @PostMapping("/sessions/{sid}/stop")
    fun stop(@PathVariable pid: String, @PathVariable sid: String): JsonNode = helper.stop(pid, sid)

    @PostMapping("/sessions/{sid}/compact")
    fun compact(@PathVariable pid: String, @PathVariable sid: String): JsonNode = helper.compact(pid, sid)

    @PostMapping("/sessions/{sid}/export")
    fun export(@PathVariable pid: String, @PathVariable sid: String): JsonNode = helper.export(pid, sid)

    @PostMapping("/sessions/{sid}/undo-turn")
    fun undoTurn(@PathVariable pid: String, @PathVariable sid: String): JsonNode = helper.undoTurn(pid, sid)

    @PostMapping("/sessions/{sid}/redo-turn")
    fun redoTurn(@PathVariable pid: String, @PathVariable sid: String): JsonNode = helper.redoTurn(pid, sid)

    @PostMapping("/sessions/{sid}/run")
    fun run(@PathVariable pid: String, @PathVariable sid: String, @RequestBody body: HelperRun): JsonNode = helper.run(pid, sid, body)

    @GetMapping("/commands")
    fun commands(@PathVariable pid: String): JsonNode = helper.commands(pid)

    @GetMapping("/prompts")
    fun prompts(@PathVariable pid: String, @RequestParam(defaultValue = "50") limit: Int): JsonNode = helper.prompts(pid, limit)

    @GetMapping("/sessions/{sid}/changes")
    fun changes(@PathVariable pid: String, @PathVariable sid: String, @RequestParam(required = false) turn: Int?): JsonNode =
        helper.changes(pid, sid, turn)

    @PostMapping("/sessions/{sid}/undo")
    fun undo(@PathVariable pid: String, @PathVariable sid: String, @RequestBody(required = false) body: HelperUndo?): JsonNode =
        helper.undo(pid, sid, body ?: HelperUndo())

    @PostMapping("/sessions/{sid}/done")
    fun done(@PathVariable pid: String, @PathVariable sid: String, @RequestBody(required = false) body: HelperDoneBody?): JsonNode =
        helper.done(pid, sid, body ?: HelperDoneBody())

    @GetMapping("/sessions/{sid}/handover")
    fun handover(@PathVariable pid: String, @PathVariable sid: String): JsonNode = helper.handover(pid, sid)

    @PostMapping("/sessions/{sid}/task")
    fun toTask(@PathVariable pid: String, @PathVariable sid: String, @RequestBody(required = false) body: HelperTaskBody?): Any =
        helper.toTask(pid, sid, body ?: HelperTaskBody())

    @PostMapping("/sessions/{sid}/flow")
    fun toFlow(@PathVariable pid: String, @PathVariable sid: String, @RequestBody(required = false) body: HelperFlowBody?): JsonNode =
        helper.toFlow(pid, sid, body ?: HelperFlowBody())

    @GetMapping("/permissions")
    fun permissions(@PathVariable pid: String): JsonNode = helper.permissions(pid)

    @PostMapping("/permissions/{qid}")
    fun answer(@PathVariable pid: String, @PathVariable qid: String, @RequestBody body: HelperAnswer): JsonNode = helper.answer(pid, qid, body)
}
