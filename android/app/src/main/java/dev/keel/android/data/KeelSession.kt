package dev.keel.android.data

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.OkHttpClient
import java.util.UUID

/**
 * The keel the app talks to now (one of the saved ones) and its api client. Pairing adds a keel; a 403 "This device was
 * removed" forgets it and tells the app to show the Pair screen ([removed]).
 */
class KeelSession(
    val store: KeelStore,
    private val deviceName: String,
    private val http: OkHttpClient = KeelApi.defaultClient(),
    /** the demo's client answers every call with fake data (debug builds only) */
    private val demoClient: () -> OkHttpClient = { http },
) {
    data class Active(val keel: SavedKeel, val api: KeelApi)

    private val _active = MutableStateFlow<Active?>(null)
    val active: StateFlow<Active?> = _active.asStateFlow()

    private val _removed = MutableSharedFlow<String>(replay = 1, extraBufferCapacity = 1)
    /** The name of a keel that removed this phone (the Pair screen says so). */
    val removed: SharedFlow<String> = _removed.asSharedFlow()

    init {
        rebuild()
    }

    val api: KeelApi? get() = _active.value?.api
    val keel: SavedKeel? get() = _active.value?.keel

    private fun rebuild() {
        val id = store.activeId.value
        val k = store.keels.value.firstOrNull { it.id == id }
        _active.value = k?.let { Active(it, apiFor(it)) }
    }

    fun apiFor(k: SavedKeel): KeelApi = KeelApi(
        baseUrl = k.url,
        token = { store.token(k.id) },
        http = if (k.demo) demoClient() else http,
        onRemoved = { forgetRemoved(k) },
    )

    /** Pair with a keel: the one-time code from its QR code (Settings › Devices). Throws [KeelException] with keel's words. */
    suspend fun pair(url: String, code: String, name: String? = null): SavedKeel {
        val client = KeelApi(url, token = { null }, http = http)
        val res = client.pair(code, deviceName)
        val base = client.base.toString().trimEnd('/')
        val existing = store.keels.value.firstOrNull { it.url == base }
        val keel = SavedKeel(
            id = existing?.id ?: UUID.randomUUID().toString(),
            name = res.keel.name.ifBlank { name ?: base },
            url = base,
            deviceId = res.device.id,
            version = res.keel.version,
            project = existing?.project,
        )
        store.save(keel, res.token)
        select(keel.id)
        return keel
    }

    fun startDemo(): SavedKeel {
        val keel = SavedKeel(id = "demo", name = "demo keel", url = "http://demo.keel.invalid", deviceId = "demo", version = "demo", demo = true)
        store.save(keel, "demo-token")
        select(keel.id)
        return keel
    }

    fun select(id: String?) {
        store.setActive(id)
        rebuild()
    }

    fun forget(id: String) {
        store.remove(id)
        rebuild()
    }

    fun setProject(pid: String?) {
        val k = keel ?: return
        store.setProject(k.id, pid)
        rebuild()
    }

    private fun forgetRemoved(k: SavedKeel) {
        store.remove(k.id)
        store.setActive(null)
        rebuild()
        _removed.tryEmit(k.name)
    }

    fun clearRemoved() {
        _removed.resetReplayCache()
    }
}
