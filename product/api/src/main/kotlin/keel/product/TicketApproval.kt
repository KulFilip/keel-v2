package keel.product

import keel.api.approvals.Approval
import keel.api.approvals.ApprovalHandler
import keel.api.approvals.ApprovalService
import keel.api.common.Conflict
import org.slf4j.LoggerFactory
import org.springframework.context.annotation.Lazy
import org.springframework.stereotype.Component

data class AskSendBody(val stories: List<String> = emptyList(), val by: String? = null, val why: String? = null)

/**
 * A send to Jira that an agent asks for (KeelBot, an MCP client): it waits in the Inbox as an approval with the preview
 * in its text, and keel sends only when the product manager approves. The web page's own Send needs no approval: the
 * product manager clicks it after the preview.
 */
@Component
class TicketApproval(
    private val store: ProductStore,
    private val repo: ProductRepo,
    private val sender: TicketSender,
    @Lazy private val approvals: ApprovalService,
) : ApprovalHandler {
    companion object {
        const val KIND = "product-jira-send"
    }

    private val log = LoggerFactory.getLogger(javaClass)

    override val kind = KIND

    fun ask(i: Initiative, b: AskSendBody): Approval {
        val p = sender.preview(i, b.stories)
        if (p.creates == 0) throw Conflict("Nothing of ${i.id} is left to send to Jira")
        val lines = p.rows.filter { it.action == "create" }.take(40).joinToString("\n") { "- ${it.level} ${it.title} → ${it.project ?: "?"} (${it.type ?: "?"})" }
        val detail = buildString {
            b.why?.takeIf { it.isNotBlank() }?.let { append(it.trim()).append("\n\n") }
            append(lines)
            if (p.problems.isNotEmpty()) append("\n\nProblems:\n").append(p.problems.joinToString("\n") { "- $it" })
        }
        return approvals.create(KIND, repo.projectId(), "Send ${p.creates} tickets of ${i.id} to Jira", detail,
            mapOf("initiative" to i.id, "stories" to b.stories), requestedBy = b.by?.trim()?.ifEmpty { null } ?: "an agent")
    }

    override fun decided(approval: Approval, decision: String, why: String) {
        if (decision != "approve") return
        val id = approval.payload?.path("initiative")?.asText().orEmpty()
        val i = store.initiative(id) ?: return
        val stories = approval.payload?.path("stories")?.mapNotNull { it.asText().takeIf { s -> s.isNotBlank() } }.orEmpty()
        runCatching { sender.send(i, stories) }
            .onSuccess { r -> store.event(i.id, InitiativeService.YOU, "approved", "Approved the send to Jira (${r.jira.size} tickets)" + why.takeIf { it.isNotBlank() }?.let { ": $it" }.orEmpty()) }
            .onFailure { ex ->
                log.warn("keel Product could not send {} to Jira: {}", i.id, ex.message)
                store.event(i.id, InitiativeService.KEEL, "jira", "The approved send to Jira failed: ${ex.message}")
            }
    }
}
