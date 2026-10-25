package dev.keel.jetbrains.core

import com.intellij.ide.projectView.ProjectView
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.WindowManager
import com.intellij.ui.EditorNotifications
import dev.keel.jetbrains.api.ChangeRange
import dev.keel.jetbrains.api.ChangedFile
import dev.keel.jetbrains.api.PrFileStatus
import dev.keel.jetbrains.api.ReviewThread
import dev.keel.jetbrains.api.ThreadState2
import dev.keel.jetbrains.api.prChangeRanges
import dev.keel.jetbrains.api.prFileStatusOf
import dev.keel.jetbrains.api.threadStateOf
import dev.keel.jetbrains.settings.KeelSettings
import dev.keel.jetbrains.ui.KeelReviewWidget
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Review mode: one pull request reviewed in the normal editors. It turns on when a PR is chosen (or checked out) and
 * ends on Exit review mode or when another PR is chosen. It knows the PR's changed files, each file's changed blocks
 * (keel's review diff; a local `git diff origin/<base>...HEAD` when keel's fails and the branch is checked out), and
 * which files were viewed. The editor marks, the project view and the status bar read it.
 */
@Service(Service.Level.PROJECT)
class ReviewMode(private val project: Project, private val scope: CoroutineScope) : Disposable {
    @Volatile var prKey: String? = null; private set
    @Volatile var files: List<ChangedFile> = emptyList(); private set
    val ranges = ConcurrentHashMap<String, List<ChangeRange>>()
    val viewed: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private var loader: Job? = null
    private var shownSig = ""

    /** Threads to show when the review view is not loaded (tests). */
    @Volatile var threadsOverride: List<ReviewThread>? = null

    val active: Boolean get() = prKey != null
    val number: Int? get() = prKey?.removePrefix("pr:")?.toIntOrNull()
    private val session get() = ReviewSession.of(project)

    init {
        session.onChange(this) { onSession() }
    }

    fun onChange(parent: Disposable, l: () -> Unit) {
        listeners += l
        Disposer.register(parent) { listeners -= l }
    }

    /** Review mode for this PR (from the Review tab or Check out). */
    fun enter(key: String) {
        if (prKey == key) return
        clear()
        prKey = key
        dev.keel.jetbrains.editor.ReviewModeMarks.of(project) // the editor marks listen from now on
        changed()
        onSession()
    }

    fun exit() {
        if (prKey == null) return
        clear()
        session.close()
        changed()
    }

    private fun clear() {
        loader?.cancel()
        prKey = null
        files = emptyList()
        ranges.clear()
        viewed.clear()
        threadsOverride = null
    }

    private fun onSession() {
        val v = session.view
        if (prKey == null || v == null || v.key != prKey) return changed()
        files = v.files
        load()
        changed()
    }

    /** Each changed file's blocks, one file after the other, in the background. */
    private fun load() {
        if (loader?.isActive == true) return
        val key = prKey ?: return
        val pid = KeelProjectService.of(project).pid ?: return
        val v = session.view ?: return
        val todo = files.filter { !it.binary && prFileStatusOf(it.status) != PrFileStatus.DELETED && !ranges.containsKey(it.path) }.take(150)
        if (todo.isEmpty()) return
        loader = scope.launch {
            val onBranch = LocalGit.run(project, "rev-parse", "--abbrev-ref", "HEAD")?.trim() == v.branch && v.branch.isNotBlank()
            for (f in todo) {
                if (prKey != key) return@launch
                val fromKeel = runCatching { KeelConnection.get().ensure().diff(pid, key, f.path) }.getOrNull()
                val diff = when {
                    fromKeel != null && !fromKeel.truncated && fromKeel.diff.isNotBlank() -> fromKeel.diff
                    onBranch -> LocalGit.run(project, "diff", "origin/${v.base}...HEAD", "--", f.path) ?: fromKeel?.diff.orEmpty()
                    else -> fromKeel?.diff.orEmpty()
                }
                ranges[f.path] = prChangeRanges(diff)
                edt { changed() }
            }
        }
    }

    /** The blocks again (after Check out, the local git diff can stand in for keel's). */
    fun reload() {
        loader?.cancel()
        ranges.clear()
        load()
        changed()
    }

    fun statusOf(path: String): PrFileStatus? = files.firstOrNull { it.path == path }?.let { prFileStatusOf(it.status) }

    /** The PR path of a file of this project: relative to the project folder, else the changed path it ends with. */
    fun relPath(file: VirtualFile): String? {
        if (!active || file.isDirectory) return null
        val base = project.basePath
        val rel = if (base != null && file.path.startsWith("$base/")) file.path.removePrefix("$base/") else null
        if (rel != null && files.any { it.path == rel }) return rel
        return files.firstOrNull { file.path.endsWith("/" + it.path) }?.path
    }

    fun threads(): List<ReviewThread> = threadsOverride ?: session.view?.threads.orEmpty()

    fun threadsOf(path: String): List<ReviewThread> = threads().filter { it.path == path }

    fun waitingOf(path: String): Int = threadsOf(path).count { threadStateOf(it, session.view?.me) == ThreadState2.WAITING }

    fun waiting(): Int = threads().count { threadStateOf(it, session.view?.me) == ThreadState2.WAITING }

    fun markViewed(path: String) {
        if (KeelSettings.get().state.markViewed && viewed.add(path)) changed()
    }

    /** For tests: review mode on [key] with these files and blocks, without keel. */
    fun setForTest(key: String, changed: List<ChangedFile>, blocks: Map<String, List<ChangeRange>>, threads: List<ReviewThread> = emptyList()) {
        clear()
        prKey = key
        files = changed
        ranges.putAll(blocks)
        threadsOverride = threads
        dev.keel.jetbrains.editor.ReviewModeMarks.of(project)
        changed()
    }

    private fun changed() {
        listeners.forEach { it() }
        // the project view and the editor banners only when what they show changed (not on every judge poll)
        val sig = "$prKey|${files.joinToString { it.path + it.status }}|${files.joinToString { waitingOf(it.path).toString() + threadsOf(it.path).size }}|${viewed.size}"
        if (sig != shownSig) {
            shownSig = sig
            ProjectView.getInstance(project).refresh()
            EditorNotifications.getInstance(project).updateAllNotifications()
        }
        WindowManager.getInstance().getStatusBar(project)?.updateWidget(KeelReviewWidget.ID)
    }

    private fun edt(block: () -> Unit) = ApplicationManager.getApplication().invokeLater({ if (!project.isDisposed) block() }, ModalityState.any())

    override fun dispose() {
        loader?.cancel()
    }

    companion object {
        fun of(project: Project): ReviewMode = project.service()
    }
}
