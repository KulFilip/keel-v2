package dev.keel.android.ui.question

import androidx.lifecycle.viewModelScope
import dev.keel.android.data.Checkpoint
import dev.keel.android.data.ClarifyQuestion
import dev.keel.android.data.GateAction
import dev.keel.android.data.GateForm
import dev.keel.android.data.KeelException
import dev.keel.android.data.KeelSession
import dev.keel.android.data.LiveHub
import dev.keel.android.data.ThreadState
import dev.keel.android.data.Workflow
import dev.keel.android.ui.common.KeelViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class FlowUi(
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val error: Throwable? = null,
    val thread: ThreadState? = null,
    val workflow: Workflow? = null,
    val history: List<Checkpoint> = emptyList(),
    val form: GateForm? = null,
    val sending: Boolean = false,
    val sendError: Throwable? = null,
    /** what was sent ("Approved. The flow goes on.") */
    val sent: String? = null,
    val stopping: Boolean = false,
)

/**
 * One flow and the question it waits at: the Question screen (a gate, answered here) and the Flow screen (criteria,
 * failure, what happened, the "what now?" question). The answer goes to POST /api/inbox/{tid}/act with the question's
 * id, as the web's Inbox sends it; keel answers 409 when the flow asks something else by now.
 */
open class FlowViewModel(
    session: KeelSession,
    live: LiveHub?,
    private val projectId: String,
    private val threadId: String,
    private val withHistory: Boolean,
) : KeelViewModel(session, live) {
    private val _ui = MutableStateFlow(FlowUi())
    val ui: StateFlow<FlowUi> = _ui.asStateFlow()

    init {
        load()
        live?.let { follow(onChange = {}, onLive = { load(silent = true) }, liveFilter = { it.threadId.isEmpty() || it.threadId == threadId }) }
    }

    fun refresh() {
        _ui.update { it.copy(refreshing = true) }
        load(silent = true)
    }

    fun load(silent: Boolean = false) {
        if (!silent) _ui.update { it.copy(loading = it.thread == null) }
        viewModelScope.launch {
            try {
                val view = api.flowOf(projectId, threadId)
                val hist = if (withHistory) runCatching { api.history(threadId) }.getOrDefault(_ui.value.history) else emptyList()
                val t = view.thread
                _ui.update { s ->
                    val w = t?.waiting
                    // keep what the person picked and typed while the same question waits
                    val form = when {
                        w == null || t.status != "waiting" -> null
                        s.form != null && s.form.waiting.id == w.id && s.form.waiting.step == w.step -> s.form.copy(waiting = w)
                        else -> GateForm.of(t.threadId, w)
                    }
                    s.copy(loading = false, refreshing = false, error = null, thread = t, workflow = view.workflow, history = hist, form = form)
                }
            } catch (e: Exception) {
                _ui.update { it.copy(loading = false, refreshing = false, error = if (it.thread == null) e else it.error, sendError = if (it.thread != null && silent) e else it.sendError) }
            }
        }
    }

    fun pick(name: String) = _ui.update { it.copy(form = it.form?.pick(name), sendError = null) }
    fun setWhy(v: String) = _ui.update { it.copy(form = it.form?.setWhy(v)) }
    fun toggle(q: ClarifyQuestion, label: String) = _ui.update { it.copy(form = it.form?.toggle(q, label)) }
    fun type(q: ClarifyQuestion, text: String) = _ui.update { it.copy(form = it.form?.type(q, text)) }

    fun send() {
        val form = _ui.value.form ?: return
        if (_ui.value.sending) return
        val problem = form.problem()
        if (problem.isNotEmpty()) {
            _ui.update { it.copy(sendError = KeelException(400, problem)) }
            return
        }
        val label = form.sendLabel
        _ui.update { it.copy(sending = true, sendError = null) }
        viewModelScope.launch {
            try {
                when (val a = form.action()) {
                    is GateAction.Answer -> api.answer(a.threadId, a.body)
                    is GateAction.Stop -> api.stop(a.threadId)
                }
                _ui.update { it.copy(sending = false, sent = "$label: sent. The flow goes on.", form = null) }
                load(silent = true)
            } catch (e: KeelException) {
                val stale = e.status == 409
                _ui.update {
                    it.copy(
                        sending = false,
                        sendError = if (stale) KeelException(409, "This flow asks something else by now.", "The screen shows the new question; answer that one.") else e,
                    )
                }
                if (stale) load(silent = true)
            } catch (e: Exception) {
                _ui.update { it.copy(sending = false, sendError = e) }
            }
        }
    }

    fun stopFlow() {
        _ui.update { it.copy(stopping = true, sendError = null) }
        viewModelScope.launch {
            try {
                api.stop(threadId)
                _ui.update { it.copy(stopping = false, sent = "The flow is stopped. Its work so far stays.") }
                load(silent = true)
            } catch (e: Exception) {
                _ui.update { it.copy(stopping = false, sendError = e) }
            }
        }
    }

    /** A stopped or failed flow goes on from its last saved step (the web's Resume). */
    fun resume() {
        _ui.update { it.copy(stopping = true, sendError = null) }
        viewModelScope.launch {
            try {
                val newest = api.history(threadId).maxByOrNull { it.n }
                    ?: throw KeelException(400, "This flow has no saved step yet.", "Start it again from Flows.")
                api.rewind(threadId, newest.id)
                _ui.update { it.copy(stopping = false, sent = "Resumed after “${newest.step}”. The next step runs now.") }
                load(silent = true)
            } catch (e: Exception) {
                _ui.update { it.copy(stopping = false, sendError = e) }
            }
        }
    }

    fun clearSent() = _ui.update { it.copy(sent = null) }
    fun clearError() = _ui.update { it.copy(sendError = null) }
}

class QuestionViewModel(session: KeelSession, live: LiveHub?, projectId: String, threadId: String) :
    FlowViewModel(session, live, projectId, threadId, withHistory = false)
