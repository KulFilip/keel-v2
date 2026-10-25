package dev.keel.jetbrains.editor

import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.ex.EditorEx
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.HighlighterTargetArea
import com.intellij.openapi.editor.markup.LineMarkerRenderer
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.fileEditor.TextEditor
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.util.ui.JBUI
import dev.keel.jetbrains.api.HelperChange
import dev.keel.jetbrains.api.changedRanges
import dev.keel.jetbrains.core.KeelProjectService
import dev.keel.jetbrains.core.LocalGit
import dev.keel.jetbrains.ui.KeelNotifier
import dev.keel.jetbrains.ui.KeelUi
import java.awt.Graphics
import java.awt.Rectangle

/**
 * KeelBot's changes in the editor: a purple bar in the gutter on the lines it changed and, above them, "KeelBot changed
 * lines a–b · Keep / Undo / Diff". The lines come from `git diff -U0 HEAD` of each file KeelBot reports as changed.
 */
@Service(Service.Level.PROJECT)
class KeelBotMarks(private val project: Project) : Disposable {
    private var sessionId: String? = null
    private var changes: List<HelperChange> = emptyList()
    private val marks = HashMap<EditorEx, Disposable>()

    init {
        project.messageBus.connect(this).subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, object : FileEditorManagerListener {
            override fun fileOpened(source: FileEditorManager, file: VirtualFile) = markFile(file)
        })
    }

    /** KeelBot's chat [sid] now has these changed files. */
    fun update(sid: String?, now: List<HelperChange>) {
        sessionId = sid
        changes = now
        marks.values.toList().forEach { Disposer.dispose(it) }
        marks.clear()
        FileEditorManager.getInstance(project).openFiles.forEach { markFile(it) }
    }

    private fun relPath(file: VirtualFile): String? {
        val base = project.basePath ?: return null
        return file.path.removePrefix("$base/").takeIf { it != file.path }
    }

    private fun markFile(file: VirtualFile) {
        val rel = relPath(file) ?: return
        if (changes.none { it.path.removePrefix("./") == rel }) return
        ApplicationManager.getApplication().executeOnPooledThread {
            val ranges = changedRanges(LocalGit.diffU0(project, rel))
            ApplicationManager.getApplication().invokeLater({
                FileEditorManager.getInstance(project).getEditors(file).filterIsInstance<TextEditor>().mapNotNull { it.editor as? EditorEx }
                    .forEach { mark(it, rel, file, ranges) }
            }, ModalityState.any())
        }
    }

    private fun mark(editor: EditorEx, rel: String, file: VirtualFile, ranges: List<IntRange>) {
        if (editor.isDisposed || ranges.isEmpty()) return
        marks.remove(editor)?.let { Disposer.dispose(it) }
        val life = Disposer.newDisposable("keel KeelBot marks")
        com.intellij.openapi.editor.ex.util.EditorUtil.disposeWithEditor(editor, life)
        Disposer.register(life) { marks.remove(editor) }
        marks[editor] = life
        val inlays = ComponentInlays(editor, life)
        val doc = editor.document
        val highlighters = mutableListOf<RangeHighlighter>()
        ranges.forEach { r ->
            val first = (r.first - 1).coerceIn(0, (doc.lineCount - 1).coerceAtLeast(0))
            val last = (r.last - 1).coerceIn(first, (doc.lineCount - 1).coerceAtLeast(0))
            val h = editor.markupModel.addRangeHighlighter(doc.getLineStartOffset(first), doc.getLineEndOffset(last), HighlighterLayer.LAST, null, HighlighterTargetArea.LINES_IN_RANGE)
            h.lineMarkerRenderer = LineMarkerRenderer { _, g: Graphics, rr: Rectangle ->
                g.color = KeelUi.ACCENT
                g.fillRect(rr.x, rr.y, JBUI.scale(3), rr.height)
            }
            highlighters += h
            val label = if (r.first == r.last) "line ${r.first}" else "lines ${r.first}–${r.last}"
            val bar = KeelUi.row(
                KeelUi.chip("k"),
                KeelUi.muted("KeelBot changed $label"),
                KeelUi.link("Keep") { keep() },
                KeelUi.link("Undo") { undo(rel) },
                KeelUi.link("Diff") { diff(rel, file) },
                gap = 8,
            ).apply { isOpaque = false }
            inlays.add(doc.getLineStartOffset(first), bar, above = true)
        }
        Disposer.register(life) { highlighters.forEach { if (it.isValid) editor.markupModel.removeHighlighter(it) } }
    }

    private fun keep() {
        val sid = sessionId ?: return
        val svc = KeelProjectService.of(project)
        val pid = svc.pid ?: return
        svc.io({ it.keep(pid, sid) }) { r ->
            r.onSuccess { d ->
                if (d.ok) {
                    KeelNotifier.info(project, "KeelBot's changes are committed", listOfNotNull(d.sha?.take(8), d.message).joinToString(" "))
                    update(sid, emptyList())
                } else {
                    KeelNotifier.error(project, "The checks did not pass", d.error ?: "keel kept the changes uncommitted.")
                }
            }.onFailure { KeelNotifier.error(project, "Could not keep the changes", KeelProjectService.say(it)) }
        }
    }

    fun undo(rel: String?) {
        val sid = sessionId ?: return
        val svc = KeelProjectService.of(project)
        val pid = svc.pid ?: return
        svc.io({ it.undo(pid, sid, rel) }) { r ->
            r.onSuccess {
                LocalFileSystem.getInstance().refresh(true)
                update(sid, it)
            }.onFailure { KeelNotifier.error(project, "Could not undo", KeelProjectService.say(it)) }
        }
    }

    /** The file as the last commit has it next to the file now. */
    fun diff(rel: String, file: VirtualFile? = null) {
        val vf = file ?: project.basePath?.let { LocalFileSystem.getInstance().refreshAndFindFileByPath("$it/$rel") }
        ApplicationManager.getApplication().executeOnPooledThread {
            val head = LocalGit.headText(project, rel)
            ApplicationManager.getApplication().invokeLater({
                val f = DiffContentFactory.getInstance()
                val type = vf?.fileType
                val left = f.create(project, head, type)
                val right = if (vf != null) f.create(project, vf) else f.createEmpty()
                DiffManager.getInstance().showDiff(project, SimpleDiffRequest("KeelBot: $rel", left, right, "Last commit", "Now"))
            }, ModalityState.any())
        }
    }

    override fun dispose() {
        marks.values.toList().forEach { Disposer.dispose(it) }
        marks.clear()
    }

    companion object {
        fun of(project: Project): KeelBotMarks = project.service()
    }
}
