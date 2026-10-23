package dev.keel.android.ui.common

import androidx.lifecycle.viewModelScope
import dev.keel.android.data.KeelSession
import dev.keel.android.data.LiveHub
import dev.keel.android.data.Project
import dev.keel.android.notify.Notifier
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class HomeUi(
    val keelName: String = "",
    val projects: List<Project> = emptyList(),
    val project: String? = null,
    val inboxCount: Int = 0,
    val reviewCount: Int = 0,
    val error: Throwable? = null,
)

/**
 * The frame around the four tabs: the active keel's projects (and which one the tabs show), the badges on the bottom
 * bar, and the "A question waits for you" notification while the app is open.
 */
class HomeViewModel(session: KeelSession, live: LiveHub?, private val notifier: Notifier?) : KeelViewModel(session, live) {
    private val _ui = MutableStateFlow(HomeUi())
    val ui: StateFlow<HomeUi> = _ui.asStateFlow()

    init {
        follow(onChange = { load() }, onLive = { counts() })
    }

    fun load() {
        val keel = session.keel ?: return
        _ui.update { it.copy(keelName = keel.name, project = keel.project) }
        viewModelScope.launch {
            // the token still good? a 403 "This device was removed" sends the app back to the Pair screen (KeelSession)
            try {
                api.me()
            } catch (e: dev.keel.android.data.KeelException) {
                if (e.deviceRemoved) return@launch
            }
            try {
                val list = api.projects()
                _ui.update { it.copy(projects = list, error = null) }
                // the tabs need a project: keep the chosen one while it exists, else the first (the one with work first)
                if (list.isNotEmpty() && list.none { it.id == keel.project }) {
                    val pick = list.maxByOrNull { it.waiting * 10 + it.running } ?: list.first()
                    session.setProject(pick.id)
                    _ui.update { it.copy(project = pick.id) }
                }
            } catch (e: Exception) {
                _ui.update { it.copy(error = e) }
            }
            counts()
        }
    }

    fun counts() {
        val keel = session.keel ?: return
        viewModelScope.launch {
            try {
                val n = if (keel.demo || notifier == null) api.inboxCount().count else Notifier.check(api, session.store, notifier)
                _ui.update { it.copy(inboxCount = n) }
            } catch (_: Exception) {
            }
            val pid = session.keel?.project ?: return@launch
            try {
                val prs = api.prs(pid, "review")
                _ui.update { it.copy(reviewCount = prs.prs.size) }
            } catch (_: Exception) {
                _ui.update { it.copy(reviewCount = 0) } // the review plugin is off or GitHub is not connected
            }
        }
    }

    fun pickProject(id: String) {
        session.setProject(id)
        _ui.update { it.copy(project = id) }
    }
}
