package keel.api.tasks

import com.fasterxml.jackson.databind.ObjectMapper
import keel.api.inbox.InboxItem
import keel.api.inbox.InboxSource
import keel.api.inbox.InboxTask
import keel.api.inbox.InboxTaskAction
import org.springframework.core.annotation.Order
import org.springframework.stereotype.Component

/** v0.5.0: a task's items in the Inbox (table task_inbox): confirm PP testing, ship, or move the Jira ticket by hand; 0.18.52
 *  keel's flow proposals and the review comments of a KeelBot-owned ticket's PR (TaskAutomations). */
@Component
@Order(10)
class TaskInboxSource(private val tasks: TaskStore, private val mapper: ObjectMapper) : InboxSource {
    override val kind = "tasks"

    override fun items(pid: String?): List<InboxItem> =
        tasks.openItemsAll().filter { pid == null || it.projectId == pid }.mapNotNull { item(it) }

    override fun waiting(pid: String?): Int = if (pid == null) tasks.openItemsAll().size else tasks.openCount(pid)

    /** Answered with POST /api/inbox/tasks/{item_id}/act; an item whose task is gone is left out. */
    private fun item(it: TaskItem): InboxItem? {
        val t = tasks.find(it.taskId) ?: return null
        val d = it.data.orEmpty()
        val actions = when (it.kind) {
            "jira-manual" -> listOf(InboxTaskAction("done", "Done"))
            // 0.18.52 keel's proposal (TaskAutomations): Start / Use another flow / Not now
            TaskAutomations.PROPOSAL -> if (d["no_pr"] == true) listOf(InboxTaskAction("later", "Not now"))
                else listOf(InboxTaskAction("start", "Start"), InboxTaskAction("other", "Use another flow"), InboxTaskAction("later", "Not now"))
            // 0.18.52 a review comment on a KeelBot-owned ticket's PR
            TaskAutomations.REVIEW_ITEM -> listOfNotNull(
                InboxTaskAction("reply", "Use keel's reply").takeIf { _ -> d["reply"]?.toString()?.isNotBlank() == true },
                InboxTaskAction("address", "Address it (small flow)"),
                InboxTaskAction("handle", "I'll handle it"),
            )
            else -> listOf(
                InboxTaskAction("confirm", if (it.stage == "prod") "Shipped, confirm" else "PP works, confirm"),
                InboxTaskAction("send_back", "Send back", needsNote = true),
            )
        }
        // clarify's shape for the card's question form: options as {label}
        val questions = (d["questions"] as? List<*>)?.takeIf { q -> q.isNotEmpty() }?.map { q ->
            (q as? Map<*, *>)?.let { m -> m + ("options" to (m["options"] as? List<*>).orEmpty().map { o -> if (o is Map<*, *>) o else mapOf("label" to o.toString()) }) }
        }?.let { q -> mapper.valueToTree<com.fasterxml.jackson.databind.JsonNode>(q) }
        return InboxItem(
            projectId = it.projectId, projectName = "", threadId = t.threadId ?: "", flow = t.title, workflowId = d["workflow_id"]?.toString() ?: t.workflowId,
            step = null, kind = it.kind, title = it.title, detail = it.detail, more = false, options = emptyList(), id = "task-item-${it.id}",
            since = it.createdAt, questions = questions,
            task = InboxTask(t.id, it.id, t.externalKey, t.externalUrl, t.title, t.status, it.stage, t.prUrl, actions),
            payload = if (it.data == null) null else mapper.valueToTree(it.data),
        )
    }
}
