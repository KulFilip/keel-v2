package dev.keel.android.ui.flows

import androidx.lifecycle.viewModelScope
import dev.keel.android.data.BudgetNow
import dev.keel.android.data.KeelSession
import dev.keel.android.data.LiveHub
import dev.keel.android.data.RunRow
import dev.keel.android.data.StartFlowBody
import dev.keel.android.data.Workflow
import dev.keel.android.ui.common.KeelViewModel
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class FlowFilter { ALL, WAITS, RUNNING, DONE }

data class StartSheet(
    val workflows: List<Workflow> = emptyList(),
    val workflowId: String? = null,
    val title: String = "",
    val request: String = "",
    val loading: Boolean = true,
    val busy: Boolean = false,
    val error: Throwable? = null,
)

data class FlowsUi(
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val error: Throwable? = null,
    val runs: List<RunRow> = emptyList(),
    val budget: BudgetNow? = null,
    val filter: FlowFilter = FlowFilter.ALL,
    val start: StartSheet? = null,
    val started: String? = null,
) {
    fun matches(r: RunRow, f: FlowFilter) = when (f) {
        FlowFilter.ALL -> true
        FlowFilter.WAITS -> r.status == "waiting"
        FlowFilter.RUNNING -> r.status == "running"
        FlowFilter.DONE -> r.status == "done"
    }
    val shown get() = runs.filter { matches(it, filter) }
    fun count(f: FlowFilter) = runs.count { matches(it, f) }
}

/** The project's flows (GET /api/projects/{pid}/runs: running, waiting and finished ones) and "Start a flow". */
class FlowsViewModel(session: KeelSession, live: LiveHub?) : KeelViewModel(session, live) {
    private val _ui = MutableStateFlow(FlowsUi())
    val ui: StateFlow<FlowsUi> = _ui.asStateFlow()

    init {
        follow(onChange = { load(first = true) }, onLive = { load() })
    }

    fun refresh() {
        _ui.update { it.copy(refreshing = true) }
        load()
    }

    fun load(first: Boolean = false) {
        val pid = pid ?: run { _ui.update { it.copy(loading = session.keel != null) }; return }
        if (first) _ui.update { it.copy(loading = true, runs = emptyList()) }
        viewModelScope.launch {
            val budget = async { runCatching { api.budgetNow(pid) }.getOrNull() }
            try {
                val runs = api.runs(pid)
                _ui.update { it.copy(loading = false, refreshing = false, error = null, runs = runs, budget = budget.await()) }
            } catch (e: Exception) {
                _ui.update { it.copy(loading = false, refreshing = false, error = e) }
            }
        }
    }

    fun setFilter(f: FlowFilter) = _ui.update { it.copy(filter = f) }

    fun openStart() {
        val pid = pid ?: return
        _ui.update { it.copy(start = StartSheet()) }
        viewModelScope.launch {
            try {
                val wfs = api.workflows(pid)
                _ui.update { s -> s.copy(start = s.start?.copy(loading = false, workflows = wfs, workflowId = (wfs.firstOrNull { it.id == "feature" } ?: wfs.firstOrNull())?.id)) }
            } catch (e: Exception) {
                _ui.update { s -> s.copy(start = s.start?.copy(loading = false, error = e)) }
            }
        }
    }

    fun closeStart() = _ui.update { it.copy(start = null) }
    fun editStart(f: (StartSheet) -> StartSheet) = _ui.update { s -> s.copy(start = s.start?.let(f)) }

    fun start() {
        val pid = pid ?: return
        val s = _ui.value.start ?: return
        val wid = s.workflowId ?: return
        if (s.title.isBlank()) {
            editStart { it.copy(error = dev.keel.android.data.KeelException(400, "Give the flow a title.", "Say in a few words what to build or fix.")) }
            return
        }
        editStart { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                val t = api.startFlow(pid, StartFlowBody(workflowId = wid, title = s.title.trim(), request = s.request.trim().ifEmpty { null }))
                _ui.update { it.copy(start = null, started = t.threadId) }
                load()
            } catch (e: Exception) {
                editStart { it.copy(busy = false, error = e) }
            }
        }
    }

    fun consumedStarted() = _ui.update { it.copy(started = null) }
}
