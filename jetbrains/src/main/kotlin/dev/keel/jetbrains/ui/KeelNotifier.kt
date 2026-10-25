package dev.keel.jetbrains.ui

import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import dev.keel.jetbrains.api.InboxItem
import dev.keel.jetbrains.core.KeelProjectService

/** keel's balloons: a flow waits for you, KeelBot asks to run a command, something keel did. */
object KeelNotifier {
    private const val GROUP = "keel"

    fun question(project: Project, item: InboxItem) {
        if (item.kind == "permission" && item.permission != null) return permission(project, item)
        val flow = item.flow.ifBlank { "A flow" }
        val n = group().createNotification("\"$flow\" waits for you: ${item.title.ifBlank { "a question" }}", NotificationType.INFORMATION)
        n.addAction(act("Answer") { KeelToolWindow.openFlow(project, item.threadId, focusGate = true) })
        n.addAction(act("Open") { KeelToolWindow.openFlow(project, item.threadId, focusGate = false, openSpec = true) })
        n.addAction(act("Later") { })
        n.notify(project)
    }

    private fun permission(project: Project, item: InboxItem) {
        val p = item.permission ?: return
        val n = group().createNotification("KeelBot wants to run a command", "<code>${KeelUi.esc(p.command)}</code>", NotificationType.WARNING)
        fun decide(label: String, decision: String) = act(label) {
            KeelProjectService.of(project).io({ it.decideApproval(p.id, decision) }) { r ->
                r.exceptionOrNull()?.let { error(project, "Could not answer", KeelProjectService.say(it)) }
                KeelProjectService.of(project).refresh()
            }
        }
        n.addAction(decide("Allow once", "once"))
        n.addAction(decide("Always", "always"))
        n.addAction(decide("Deny", "deny"))
        n.notify(project)
    }

    fun info(project: Project?, title: String, text: String = "") =
        group().createNotification(title, text, NotificationType.INFORMATION).notify(project)

    fun error(project: Project?, title: String, text: String) =
        group().createNotification(title, KeelUi.esc(text), NotificationType.ERROR).notify(project)

    private fun group() = NotificationGroupManager.getInstance().getNotificationGroup(GROUP)

    private fun act(text: String, run: () -> Unit): NotificationAction =
        object : NotificationAction(text) {
            override fun actionPerformed(e: com.intellij.openapi.actionSystem.AnActionEvent, notification: Notification) {
                notification.expire()
                run()
            }
        }
}
