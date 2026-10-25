package dev.keel.jetbrains.ui

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.ContentFactory
import dev.keel.jetbrains.core.KeelProjectService

/** The keel tool window: Review, Flows and KeelBot tabs. */
class KeelToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        KeelProjectService.of(project).start()
        val cf = ContentFactory.getInstance()
        val review = ReviewPanel(project, toolWindow.disposable)
        val flows = FlowsPanel(project, toolWindow.disposable)
        val bot = KeelBotPanel(project, toolWindow.disposable)
        listOf(KeelToolWindow.REVIEW to review, KeelToolWindow.FLOWS to flows, KeelToolWindow.KEELBOT to bot).forEach { (name, panel) ->
            val c = cf.createContent(panel, name, false)
            c.isCloseable = false
            c.preferredFocusableComponent = panel
            toolWindow.contentManager.addContent(c)
        }
    }

    override fun shouldBeAvailable(project: Project): Boolean = true
}

object KeelToolWindow {
    const val ID = "keel"
    const val REVIEW = "Review"
    const val FLOWS = "Flows"
    const val KEELBOT = "KeelBot"

    /** Shows the tool window on a tab and hands its panel over once it is there. */
    fun show(project: Project, tab: String, then: (Any) -> Unit = {}) {
        val tw = ToolWindowManager.getInstance(project).getToolWindow(ID) ?: return
        tw.show {
            val cm = tw.contentManager
            val c = cm.contents.firstOrNull { it.displayName == tab } ?: return@show
            cm.setSelectedContent(c, true)
            then(c.component)
        }
    }

    fun openFlow(project: Project, threadId: String, focusGate: Boolean, openSpec: Boolean = false) =
        show(project, FLOWS) { (it as? FlowsPanel)?.open(threadId, focusGate, openSpec) }

    fun askKeelBot(project: Project, text: String, send: Boolean = false) =
        show(project, KEELBOT) { (it as? KeelBotPanel)?.prefill(text, send) }
}
