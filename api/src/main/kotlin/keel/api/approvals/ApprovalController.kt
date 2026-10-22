package keel.api.approvals

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/approvals")
class ApprovalController(private val approvals: ApprovalService) {
    /** status: waiting (oldest first) | approved | denied | expired | closed; none: every status, newest first. */
    @GetMapping
    fun list(@RequestParam(required = false) status: String?, @RequestParam(required = false) project: String?): List<Approval> =
        approvals.list(status, project)

    @PostMapping("/{id}/decide")
    fun decide(@PathVariable id: String, @RequestBody body: ApprovalDecide): Approval = approvals.decide(id, body.decision, body.why)
}
