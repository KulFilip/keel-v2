package dev.keel.android.ui.chat

import androidx.lifecycle.viewModelScope
import dev.keel.android.data.ClarifyQuestion
import dev.keel.android.data.HelperChange
import dev.keel.android.data.HelperSession
import dev.keel.android.data.JobStep
import dev.keel.android.data.KeelSession
import dev.keel.android.data.LiveHub
import dev.keel.android.data.answersMessage
import dev.keel.android.data.answersOf
import dev.keel.android.ui.common.KeelViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class ChatUi(
    val loading: Boolean = true,
    val error: Throwable? = null,
    val chats: List<HelperSession> = emptyList(),
    val session: HelperSession? = null,
    /** the mode of a chat not started yet */
    val mode: String = "ask",
    val draft: String = "",
    val sending: Boolean = false,
    val runningCall: String? = null,
    val steps: Map<String, List<JobStep>> = emptyMap(),
    val changes: List<HelperChange> = emptyList(),
    /** answers given to KeelBot's question cards (by message n): picked options */
    val qPicked: Map<String, List<String>> = emptyMap(),
    val answered: Set<Int> = emptySet(),
    val actionError: Throwable? = null,
    val note: String? = null,
    val showList: Boolean = false,
) {
    val currentMode get() = session?.mode ?: mode
    val busy get() = sending || session?.status == "running" || session?.busy == true
}

/** KeelBot (the keelbot plugin's api): a project's chats, a message and its answer, the modes, keel-questions cards. */
class ChatViewModel(session: KeelSession, live: LiveHub?) : KeelViewModel(session, live) {
    private val _ui = MutableStateFlow(ChatUi())
    val ui: StateFlow<ChatUi> = _ui.asStateFlow()
    val liveText: StateFlow<Map<String, String>> = live?.liveText ?: MutableStateFlow(emptyMap())
    private var poll: Job? = null

    init {
        follow(onChange = { start() }, onLive = { reloadSession() }, liveFilter = { it.type.startsWith("helper.") })
    }

    /** The newest chat of the project (or an empty new one). */
    fun start() {
        val pid = pid ?: return
        _ui.update { ChatUi(loading = true) }
        viewModelScope.launch {
            try {
                val chats = api.chats(pid).sortedByDescending { it.updatedAt }
                val first = chats.firstOrNull()?.let { api.chat(pid, it.id) }
                _ui.update { it.copy(loading = false, error = null, chats = chats, session = first) }
                first?.let { afterLoad(it) }
            } catch (e: Exception) {
                _ui.update { it.copy(loading = false, error = e) }
            }
        }
    }

    fun open(sid: String) {
        val pid = pid ?: return
        _ui.update { it.copy(showList = false, loading = true) }
        viewModelScope.launch {
            try {
                val s = api.chat(pid, sid)
                _ui.update { it.copy(loading = false, session = s, steps = emptyMap(), changes = emptyList(), answered = emptySet(), qPicked = emptyMap()) }
                afterLoad(s)
            } catch (e: Exception) {
                _ui.update { it.copy(loading = false, actionError = e) }
            }
        }
    }

    fun newChat() = _ui.update { it.copy(session = null, mode = it.currentMode, steps = emptyMap(), changes = emptyList(), answered = emptySet(), showList = false, draft = "") }

    fun showList(v: Boolean) {
        _ui.update { it.copy(showList = v) }
        if (v) pid?.let { pid -> viewModelScope.launch { runCatching { api.chats(pid) }.onSuccess { l -> _ui.update { it.copy(chats = l.sortedByDescending { c -> c.updatedAt }) } } } }
    }

    fun setDraft(v: String) = _ui.update { it.copy(draft = v) }

    fun setMode(mode: String) {
        val pid = pid ?: return
        val s = _ui.value.session
        if (s == null) {
            _ui.update { it.copy(mode = mode) }
            return
        }
        viewModelScope.launch {
            try {
                val next = api.setChatMode(pid, s.id, mode)
                _ui.update { it.copy(session = next.copy(messages = next.messages ?: s.messages)) }
            } catch (e: Exception) {
                _ui.update { it.copy(actionError = e) }
            }
        }
    }

    fun send(text: String = _ui.value.draft) {
        val pid = pid ?: return
        val body = text.trim()
        if (body.isEmpty() || _ui.value.sending) return
        _ui.update { it.copy(sending = true, actionError = null) }
        viewModelScope.launch {
            try {
                val s = _ui.value.session ?: api.newChat(pid, _ui.value.mode)
                val started = api.send(pid, s.id, body)
                _ui.update { it.copy(draft = if (text === it.draft || text == it.draft) "" else it.draft, runningCall = started.callId.ifEmpty { null }) }
                val now = api.chat(pid, s.id)
                _ui.update { it.copy(sending = false, session = now) }
                afterLoad(now)
            } catch (e: Exception) {
                _ui.update { it.copy(sending = false, actionError = e) }
            }
        }
    }

    /** The answers to a ```keel-questions``` card go back as the next message (the web's answersMessage). */
    fun answer(messageN: Int, questions: List<ClarifyQuestion>, picked: Map<String, List<String>>) {
        _ui.update { it.copy(answered = it.answered + messageN) }
        send(answersMessage(questions, answersOf(questions, picked, emptyMap())))
    }

    fun pickAnswer(q: ClarifyQuestion, label: String) = _ui.update {
        val now = it.qPicked[q.id].orEmpty()
        it.copy(qPicked = it.qPicked + (q.id to if (q.multiple) (if (label in now) now - label else now + label) else listOf(label)))
    }

    fun stop() {
        val pid = pid ?: return
        val s = _ui.value.session ?: return
        viewModelScope.launch { runCatching { api.stopChat(pid, s.id) }; reloadSession() }
    }

    fun reloadSession() {
        val pid = pid ?: return
        val s = _ui.value.session ?: return
        viewModelScope.launch {
            runCatching { api.chat(pid, s.id) }.onSuccess { now ->
                _ui.update { it.copy(session = now) }
                afterLoad(now)
            }
        }
    }

    /** After a load: poll while KeelBot answers; the newest answer's tool log; the files it changed (Fix, Edit). */
    private fun afterLoad(s: HelperSession) {
        val pid = pid ?: return
        val running = s.status == "running" || s.busy == true
        if (running && poll?.isActive != true) {
            poll = viewModelScope.launch {
                repeat(400) {
                    delay(1_500)
                    val now = runCatching { api.chat(pid, s.id) }.getOrNull() ?: return@repeat
                    _ui.update { it.copy(session = now) }
                    if (now.status != "running" && now.busy != true) {
                        _ui.update { it.copy(runningCall = null) }
                        afterLoad(now)
                        return@launch
                    }
                }
            }
        }
        val last = s.messages.orEmpty().lastOrNull { it.role == "helper" && it.callId != null }
        if (last != null && last.callId !in _ui.value.steps) loadSteps(last.callId!!)
        if (s.mode == "fix" || s.mode == "edit") {
            viewModelScope.launch { runCatching { api.changes(pid, s.id) }.onSuccess { c -> _ui.update { it.copy(changes = c) } } }
        }
    }

    fun loadSteps(callId: String) {
        viewModelScope.launch {
            runCatching { api.jobSteps(callId) }.onSuccess { st -> _ui.update { it.copy(steps = it.steps + (callId to st.steps)) } }
        }
    }

    fun keep() {
        val pid = pid ?: return
        val s = _ui.value.session ?: return
        viewModelScope.launch {
            try {
                val d = api.keep(pid, s.id)
                _ui.update { it.copy(note = if (d.ok) "Kept: keel committed ${d.sha?.take(7) ?: "the change"}." else (d.error ?: "Not kept."), changes = if (d.ok) emptyList() else it.changes) }
            } catch (e: Exception) {
                _ui.update { it.copy(actionError = e) }
            }
        }
    }

    fun undo(path: String? = null) {
        val pid = pid ?: return
        val s = _ui.value.session ?: return
        viewModelScope.launch {
            try {
                val left = api.undo(pid, s.id, path)
                _ui.update { it.copy(changes = left, note = if (path == null) "Undone: every change of this chat." else "Undone: $path") }
            } catch (e: Exception) {
                _ui.update { it.copy(actionError = e) }
            }
        }
    }

    fun clearNote() = _ui.update { it.copy(note = null, actionError = null) }
}
