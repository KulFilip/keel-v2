package dev.keel.jetbrains.actions

import com.intellij.codeInsight.intention.IntentionAction
import com.intellij.codeInsight.intention.LowPriorityAction
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.PsiFile
import dev.keel.jetbrains.api.requestFromSelection
import dev.keel.jetbrains.core.KeelProjectService
import dev.keel.jetbrains.ui.KeelToolWindow
import dev.keel.jetbrains.ui.StartFlowDialog

/** The selection of an editor as keel wants it: the file's project path, its lines and the code. */
data class Selection(val path: String, val start: Int, val end: Int, val code: String) {
    val where: String get() = if (start == end) "$path:$start" else "$path:$start-$end"

    companion object {
        fun of(project: Project, editor: Editor, file: VirtualFile?): Selection? {
            val sm = editor.selectionModel
            val doc = editor.document
            val (s, e) = if (sm.hasSelection()) sm.selectionStart to sm.selectionEnd else {
                val line = editor.caretModel.logicalPosition.line
                if (line >= doc.lineCount) return null
                doc.getLineStartOffset(line) to doc.getLineEndOffset(line)
            }
            val code = doc.getText(com.intellij.openapi.util.TextRange(s, e))
            val base = project.basePath
            val path = file?.path?.let { p -> if (base != null) p.removePrefix("$base/") else p } ?: "this file"
            val endLine = doc.getLineNumber((e - 1).coerceAtLeast(s)) + 1
            return Selection(path, doc.getLineNumber(s) + 1, endLine, code)
        }
    }
}

/** Tools › keel: Start a Flow… and the tool window's button. */
class StartFlowAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        StartFlowDialog.open(e.project ?: return, null)
    }
}

/** Editor menu: keel: Start a Flow from Selection — the request starts with the selected code. */
class StartFlowFromSelectionAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && e.getData(CommonDataKeys.EDITOR) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val sel = Selection.of(project, editor, e.getData(CommonDataKeys.VIRTUAL_FILE)) ?: return
        StartFlowDialog.open(project, StartFlowDialog.Prefill(requestFromSelection(sel.path, sel.start, sel.end, sel.code), "the selection in ${sel.path.substringAfterLast('/')}"))
    }
}

/** Ask KeelBot about the selection (Ctrl+Alt+K by default; rebind it in Keymap › Plugins › keel). */
class AskKeelBotAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR)
        val sel = editor?.let { Selection.of(project, it, e.getData(CommonDataKeys.VIRTUAL_FILE)) }
        KeelToolWindow.askKeelBot(project, sel?.let { askText(it) }.orEmpty())
    }

    companion object {
        fun askText(sel: Selection) = "@${sel.where}\n```\n${sel.code.trimEnd()}\n```\n"
    }
}

/** Opens the keel tool window (Flows), e.g. from Find Action. */
class OpenKeelAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        KeelProjectService.of(project).refresh()
        KeelToolWindow.show(project, KeelToolWindow.FLOWS)
    }
}

/** Alt+Enter on a selection: Ask KeelBot. */
class AskKeelBotIntention : IntentionAction, LowPriorityAction {
    override fun getText() = "Ask KeelBot"
    override fun getFamilyName() = "keel"
    override fun startInWriteAction() = false
    override fun isAvailable(project: Project, editor: Editor?, file: PsiFile?) = editor?.selectionModel?.hasSelection() == true

    override fun invoke(project: Project, editor: Editor?, file: PsiFile?) {
        val sel = editor?.let { Selection.of(project, it, file?.virtualFile) } ?: return
        KeelToolWindow.askKeelBot(project, AskKeelBotAction.askText(sel))
    }
}

/** Alt+Enter on a selection: keel: Start a flow from selection. */
class StartFlowIntention : IntentionAction, LowPriorityAction {
    override fun getText() = "keel: Start a flow from selection"
    override fun getFamilyName() = "keel"
    override fun startInWriteAction() = false
    override fun isAvailable(project: Project, editor: Editor?, file: PsiFile?) = editor?.selectionModel?.hasSelection() == true

    override fun invoke(project: Project, editor: Editor?, file: PsiFile?) {
        val sel = editor?.let { Selection.of(project, it, file?.virtualFile) } ?: return
        StartFlowDialog.open(project, StartFlowDialog.Prefill(requestFromSelection(sel.path, sel.start, sel.end, sel.code), "the selection in ${sel.path.substringAfterLast('/')}"))
    }
}
