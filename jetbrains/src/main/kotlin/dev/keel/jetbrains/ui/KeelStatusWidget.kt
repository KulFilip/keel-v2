package dev.keel.jetbrains.ui

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import dev.keel.jetbrains.core.KeelProjectService
import java.awt.event.MouseEvent

/** "keel · 2 questions" in the status bar; a click opens the keel tool window where the questions are. */
class KeelStatusWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {
    private var bar: StatusBar? = null

    override fun ID(): String = ID

    override fun install(statusBar: StatusBar) {
        bar = statusBar
    }

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun getText(): String {
        val s = KeelProjectService.of(project)
        if (!s.connected) return if (s.error != null) "keel · offline" else "keel"
        val n = s.questions.size
        return when (n) {
            0 -> "keel"
            1 -> "keel · 1 question"
            else -> "keel · $n questions"
        }
    }

    override fun getTooltipText(): String {
        val s = KeelProjectService.of(project)
        return when {
            !s.connected -> KeelProjectService.say(s.error).ifBlank { "keel: connecting" }
            s.keelProject == null -> "keel: this project is not one of keel's (Settings › Tools › keel)"
            else -> "keel: ${s.keelProject?.name} · ${s.questions.size} waiting"
        }
    }

    override fun getAlignment(): Float = 0f

    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer {
        val s = KeelProjectService.of(project)
        val q = s.questions.firstOrNull()
        if (q != null && q.kind != "permission") KeelToolWindow.openFlow(project, q.threadId, focusGate = true) else KeelToolWindow.show(project, KeelToolWindow.FLOWS)
    }

    override fun dispose() {
        bar = null
    }

    companion object {
        const val ID = "keel.status"
    }
}

class KeelStatusWidgetFactory : StatusBarWidgetFactory {
    override fun getId(): String = KeelStatusWidget.ID
    override fun getDisplayName(): String = "keel"
    override fun isAvailable(project: Project): Boolean = true
    override fun createWidget(project: Project): StatusBarWidget = KeelStatusWidget(project)
    override fun disposeWidget(widget: StatusBarWidget) = widget.dispose()
    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true
}
