package dev.keel.android.ui.prs

import androidx.lifecycle.viewModelScope
import dev.keel.android.data.KeelSession
import dev.keel.android.data.LiveHub
import dev.keel.android.data.PrList
import dev.keel.android.ui.common.KeelViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class PrsUi(
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val error: Throwable? = null,
    /** review | mine | all (the review plugin's filters) */
    val filter: String = "review",
    val list: PrList? = null,
)

/** The review plugin's pull requests (GET /api/projects/{pid}/review/prs?filter=). */
class PrsViewModel(session: KeelSession, live: LiveHub?) : KeelViewModel(session, live) {
    private val _ui = MutableStateFlow(PrsUi())
    val ui: StateFlow<PrsUi> = _ui.asStateFlow()
    private var job: Job? = null

    init {
        follow(onChange = { load(first = true) })
    }

    fun setFilter(f: String) {
        _ui.update { it.copy(filter = f, list = null) }
        load(first = true)
    }

    fun refresh() {
        _ui.update { it.copy(refreshing = true) }
        load()
    }

    fun load(first: Boolean = false) {
        val pid = pid ?: return
        if (first) _ui.update { it.copy(loading = true) }
        val filter = _ui.value.filter
        job?.cancel()
        job = viewModelScope.launch {
            try {
                val list = api.prs(pid, filter)
                _ui.update { it.copy(loading = false, refreshing = false, error = null, list = list) }
            } catch (e: Exception) {
                _ui.update { it.copy(loading = false, refreshing = false, error = e) }
            }
        }
    }
}
