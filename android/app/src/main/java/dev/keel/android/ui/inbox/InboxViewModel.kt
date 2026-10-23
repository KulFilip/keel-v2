package dev.keel.android.ui.inbox

import androidx.lifecycle.viewModelScope
import dev.keel.android.data.InboxItem
import dev.keel.android.data.KeelSession
import dev.keel.android.data.LiveHub
import dev.keel.android.data.PrSummary
import dev.keel.android.ui.common.KeelViewModel
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class InboxUi(
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val error: Throwable? = null,
    val items: List<InboxItem> = emptyList(),
    val reviews: List<PrSummary> = emptyList(),
    val today: Double? = null,
    val busy: String? = null,
    val actionError: Throwable? = null,
) {
    val questions get() = items.filter { it.kind != "permission" && it.kind != "task" }
    val permissions get() = items.filter { it.kind == "permission" }
    val count get() = items.size + reviews.size
}

/** "Waiting for you": every question across the keel's projects (GET /api/inbox), the PRs that ask for your review. */
class InboxViewModel(session: KeelSession, live: LiveHub?) : KeelViewModel(session, live) {
    private val _ui = MutableStateFlow(InboxUi())
    val ui: StateFlow<InboxUi> = _ui.asStateFlow()

    init {
        follow(onChange = { load(first = true) }, onLive = { load() })
    }

    fun refresh() {
        _ui.update { it.copy(refreshing = true) }
        load()
    }

    fun load(first: Boolean = false) {
        if (session.keel == null) return
        if (first) _ui.update { it.copy(loading = it.items.isEmpty()) }
        viewModelScope.launch {
            val pid = pid
            val reviews = async { runCatching { pid?.let { api.prs(it, "review").prs } ?: emptyList() }.getOrDefault(emptyList()) }
            val today = async { runCatching { pid?.let { api.budgetNow(it).today.costUsd } }.getOrNull() }
            try {
                val inbox = api.inbox()
                _ui.update { it.copy(loading = false, refreshing = false, error = null, items = inbox.items, reviews = reviews.await(), today = today.await()) }
            } catch (e: Exception) {
                _ui.update { it.copy(loading = false, refreshing = false, error = e) }
            }
        }
    }

    /** A command that waits for the person's OK: once | always | deny. */
    fun decide(item: InboxItem, decision: String) {
        val id = item.permission?.id ?: item.id ?: return
        _ui.update { it.copy(busy = id, actionError = null) }
        viewModelScope.launch {
            try {
                api.decideApproval(id, decision, if (decision == "deny") "The person said no from the phone." else "")
                _ui.update { s -> s.copy(busy = null, items = s.items.filterNot { it === item }) }
                load()
            } catch (e: Exception) {
                _ui.update { it.copy(busy = null, actionError = e) }
            }
        }
    }

    fun clearActionError() = _ui.update { it.copy(actionError = null) }
}
