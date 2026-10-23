package dev.keel.android.ui.common

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.keel.android.data.KeelApi
import dev.keel.android.data.KeelException
import dev.keel.android.data.KeelSession
import dev.keel.android.data.LiveHub
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onEach

/** What the screens share: the active keel's api and project, and a reload when keel's live stream says so. */
abstract class KeelViewModel(protected val session: KeelSession, protected val live: LiveHub?) : ViewModel() {
    protected val api: KeelApi get() = session.api ?: throw KeelException(0, "No keel is paired.", "Pair this phone with keel first.")
    protected val pid: String? get() = session.keel?.project

    /** Call from init: [onChange] runs now and whenever the keel or the project changes; [onLive] on live events. */
    @OptIn(FlowPreview::class)
    protected fun follow(onChange: () -> Unit, onLive: (() -> Unit)? = null, liveFilter: (dev.keel.android.data.EngineEvent) -> Boolean = { true }) {
        session.active.map { it?.keel?.id to it?.keel?.project }.distinctUntilChanged()
            .onEach { onChange() }
            .launchIn(viewModelScope)
        if (onLive != null) live?.changes?.filter(liveFilter)?.debounce(400)?.onEach { onLive() }?.launchIn(viewModelScope)
    }

    /** Only later values (skip the current one). */
    protected fun <T> Flow<T>.later() = drop(1)
}
