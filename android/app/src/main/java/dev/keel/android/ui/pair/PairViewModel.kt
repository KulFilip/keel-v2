package dev.keel.android.ui.pair

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.keel.android.data.KeelApi
import dev.keel.android.data.KeelException
import dev.keel.android.data.KeelSession
import dev.keel.android.data.PairLink
import dev.keel.android.data.PairLinks
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class PairUi(
    val url: String = "",
    val code: String = "",
    val keelName: String? = null,
    val busy: Boolean = false,
    val error: String? = null,
    val hint: String? = null,
    val paired: Boolean = false,
    val removedFrom: String? = null,
)

/** The Pair screen: a scanned QR code / keel://pair link, or the address and code typed in. */
class PairViewModel(private val session: KeelSession) : ViewModel() {
    private val _ui = MutableStateFlow(PairUi())
    val ui: StateFlow<PairUi> = _ui.asStateFlow()

    init {
        viewModelScope.launch {
            session.removed.collect { name -> _ui.update { it.copy(removedFrom = name) } }
        }
    }

    fun setUrl(v: String) = _ui.update { it.copy(url = v, error = null, hint = null) }
    fun setCode(v: String) = _ui.update { it.copy(code = v.trim(), error = null, hint = null) }

    /** A scanned or opened link: fill the form and pair right away. Returns false for a code that is not keel's. */
    fun fromLink(raw: String): Boolean {
        val link: PairLink = PairLinks.parse(raw) ?: run {
            _ui.update { it.copy(error = "This is not a keel pairing code.", hint = "Scan the QR code that keel shows under Settings › Devices › Pair a phone.") }
            return false
        }
        _ui.update { it.copy(url = link.url, code = link.code, keelName = link.name, error = null, hint = null) }
        pair()
        return true
    }

    fun pair() {
        val s = _ui.value
        if (s.busy) return
        if (KeelApi.normalizeBase(s.url) == null) {
            _ui.update { it.copy(error = "Type keel's address.", hint = "For example http://192.168.1.20:8080 (keel2 start --wifi prints it).") }
            return
        }
        if (s.code.isBlank()) {
            _ui.update { it.copy(error = "Type the pairing code.", hint = "keel shows it next to the QR code; it works once and only for a few minutes.") }
            return
        }
        _ui.update { it.copy(busy = true, error = null, hint = null) }
        viewModelScope.launch {
            try {
                session.pair(s.url, s.code, s.keelName)
                session.clearRemoved()
                _ui.update { it.copy(busy = false, paired = true, removedFrom = null) }
            } catch (e: KeelException) {
                _ui.update { it.copy(busy = false, error = e.message, hint = e.hint ?: if (e.status == 404) "This keel has no phone pairing yet: update keel." else null) }
            } catch (e: Exception) {
                _ui.update { it.copy(busy = false, error = e.message ?: "Pairing failed.") }
            }
        }
    }

    fun demo() {
        session.startDemo()
        session.clearRemoved()
        _ui.update { it.copy(paired = true) }
    }

    fun select(id: String) {
        session.select(id)
        session.clearRemoved()
        _ui.update { it.copy(paired = true) }
    }

    fun consumed() = _ui.update { it.copy(paired = false) }
}
