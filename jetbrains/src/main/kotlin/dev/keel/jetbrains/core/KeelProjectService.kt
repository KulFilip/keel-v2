package dev.keel.jetbrains.core

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.WindowManager
import dev.keel.jetbrains.api.EngineEvent
import dev.keel.jetbrains.api.InboxItem
import dev.keel.jetbrains.api.KeelApi
import dev.keel.jetbrains.api.KeelException
import dev.keel.jetbrains.api.LiveHub
import dev.keel.jetbrains.api.ProjectMapper
import dev.keel.jetbrains.settings.KeelProjectSettings
import dev.keel.jetbrains.settings.KeelSettings
import dev.keel.jetbrains.ui.KeelNotifier
import dev.keel.jetbrains.ui.KeelStatusWidget
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.concurrent.CopyOnWriteArrayList
import dev.keel.jetbrains.api.Project as KeelProject

/**
 * keel for one IDE project: which keel project it is, the questions waiting (the inbox), and keel's live stream.
 * Screens listen with [onChange] (state) and [onEvent] (each engine event) and call keel through [io].
 */
@Service(Service.Level.PROJECT)
class KeelProjectService(val project: Project, val scope: CoroutineScope) : Disposable {
    @Volatile var projects: List<KeelProject> = emptyList(); private set
    @Volatile var match: ProjectMapper.Match? = null; private set
    @Volatile var inbox: List<InboxItem> = emptyList(); private set
    @Volatile var error: KeelException? = null; private set
    @Volatile var connected = false; private set

    val pid: String? get() = match?.project?.id
    val keelProject: KeelProject? get() = match?.project

    /** Questions of this project (all projects' when this one is not mapped). */
    val questions: List<InboxItem> get() = pid?.let { p -> inbox.filter { it.projectId == p } } ?: inbox

    val live = LiveHub(scope)
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val eventListeners = CopyOnWriteArrayList<(EngineEvent) -> Unit>()
    private val told = HashSet<String>()
    private var started = false
    private var pending: Job? = null

    fun start() {
        if (started) return
        started = true
        scope.launch {
            live.changes.collect { ev ->
                if (ev.type == "poll" || ev.type == "connected" || ev.type.startsWith("inbox") || ev.type.startsWith("flow") ||
                    ev.type.startsWith("gate") || ev.type.startsWith("thread") || ev.type.startsWith("approval") || ev.type.startsWith("notify")
                ) {
                    refreshSoon()
                }
                edt { eventListeners.forEach { it(ev) } }
            }
        }
        // keel down or not signed in: try again now and then (the live stream's own poll stops with it)
        scope.launch {
            while (true) {
                delay(30_000)
                if (!connected) refresh()
            }
        }
        refresh()
    }

    fun reconnect() {
        live.stop()
        refresh()
    }

    private fun refreshSoon() {
        pending?.cancel()
        pending = scope.launch {
            delay(400)
            refresh()
        }
    }

    /** Projects, the mapping and the inbox again; then everyone who listens. */
    fun refresh() {
        scope.launch {
            try {
                val api = KeelConnection.get().ensure()
                val list = api.projects()
                val m = ProjectMapper.match(project.basePath, list, KeelProjectSettings.of(project).state.projectId)
                val box = api.inbox()
                projects = list
                match = m
                inbox = box.items
                error = null
                connected = true
                live.follow(api, m?.project?.id, demo = false)
                tellNew()
            } catch (e: KeelException) {
                error = e
                connected = false
                if (e.status == 401 || e.status == 403) live.stop() else live.follow(null, null, false)
            } catch (e: Exception) {
                error = KeelException(0, e.message ?: "keel failed.")
                connected = false
            }
            edt { changed() }
        }
    }

    private fun tellNew() {
        if (!KeelSettings.get().state.notify) return
        val mine = pid ?: return
        val now = questions.filter { it.projectId == mine }
        val fresh = now.filter { told.add(keyOf(it)) }
        if (fresh.isNotEmpty() && told.size > fresh.size + 200) told.retainAll(now.map(::keyOf).toSet())
        if (fresh.isEmpty()) return
        edt { fresh.take(3).forEach { KeelNotifier.question(project, it) } }
    }

    private fun keyOf(i: InboxItem) = "${i.projectId}|${i.threadId}|${i.id ?: i.permission?.id ?: i.title}"

    fun pick(projectId: String?) {
        KeelProjectSettings.of(project).state.projectId = projectId
        refresh()
    }

    fun onChange(parent: Disposable, l: () -> Unit) {
        listeners += l
        Disposer.register(parent) { listeners -= l }
    }

    fun onEvent(parent: Disposable, l: (EngineEvent) -> Unit) {
        eventListeners += l
        Disposer.register(parent) { eventListeners -= l }
    }

    private fun changed() {
        listeners.forEach { it() }
        WindowManager.getInstance().getStatusBar(project)?.updateWidget(KeelStatusWidget.ID)
    }

    /**
     * Calls keel off the EDT and hands the result back on it (in any modality, so dialogs see it too). An error that
     * says the sign-in is gone also refreshes the connection state.
     */
    fun <T> io(work: suspend (KeelApi) -> T, done: (Result<T>) -> Unit) {
        scope.launch {
            val r = try {
                Result.success(work(KeelConnection.get().ensure()))
            } catch (e: KeelException) {
                if (e.deviceRemoved) refresh()
                Result.failure(e)
            } catch (e: Exception) {
                Result.failure(e)
            }
            edt { if (!project.isDisposed) done(r) }
        }
    }

    private fun edt(block: () -> Unit) = ApplicationManager.getApplication().invokeLater(block, ModalityState.any())

    override fun dispose() {
        live.stop()
    }

    companion object {
        fun of(project: Project): KeelProjectService = project.service()

        /** The words for an error, with keel's hint. */
        fun say(e: Throwable?): String = when (e) {
            null -> ""
            is KeelException -> listOfNotNull(e.message, e.hint).joinToString(" ")
            else -> e.message ?: e.javaClass.simpleName
        }
    }
}
