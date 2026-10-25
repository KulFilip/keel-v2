package dev.keel.jetbrains.api

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Request
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.TimeUnit

/**
 * keel's live stream while the IDE is open: one SSE connection (GET /api/events, the web's own stream) for the active
 * keel and project. Screens listen to [changes] and reload; KeelBot's answer as it is written comes in [liveText].
 * When the stream is down, a tick every [pollSeconds] stands in for it (polling fallback), and it reconnects with backoff.
 */
class LiveHub(private val scope: CoroutineScope, private val pollSeconds: Long = 20) {
    private val _changes = MutableSharedFlow<EngineEvent>(extraBufferCapacity = 64)
    val changes: SharedFlow<EngineEvent> = _changes.asSharedFlow()

    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    private val _liveText = MutableStateFlow<Map<String, String>>(emptyMap())
    val liveText: StateFlow<Map<String, String>> = _liveText.asStateFlow()

    private var job: Job? = null
    private var source: EventSource? = null
    private var key: String? = null

    /** Follow this keel and project (null api: stop). Calling it again with the same pair does nothing. */
    fun follow(api: KeelApi?, pid: String?, demo: Boolean) {
        val k = api?.let { "${it.base}|$pid|$demo" }
        if (k == key && job?.isActive == true) return
        stop()
        key = k
        if (api == null) return
        job = scope.launch {
            var attempt = 0
            // the polling fallback: a tick whenever the stream is not up
            launch {
                while (isActive) {
                    delay(pollSeconds * 1000)
                    if (!_connected.value) _changes.tryEmit(EngineEvent(type = "poll"))
                }
            }
            if (demo) return@launch
            while (isActive) {
                val closed = kotlinx.coroutines.CompletableDeferred<Unit>()
                source = open(api, pid) { closed.complete(Unit) }
                closed.await()
                _connected.value = false
                attempt++
                delay(minOf(30_000L, 1_000L * (1 shl minOf(attempt, 5))))
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        source?.cancel()
        source = null
        key = null
        _connected.value = false
    }

    private fun open(api: KeelApi, pid: String?, onClosed: () -> Unit): EventSource {
        val client = api.http.newBuilder().readTimeout(0, TimeUnit.SECONDS).build()
        val req = Request.Builder().url(api.eventsUrl(pid))
            .header("Accept", "text/event-stream")
            .header("X-Keel-Via", "jetbrains")
            .apply { api.authHeader()?.let { header("Authorization", it) } }
            .build()
        return EventSources.createFactory(client).newEventSource(req, object : EventSourceListener() {
            override fun onOpen(eventSource: EventSource, response: Response) {
                _connected.value = true
                _changes.tryEmit(EngineEvent(type = "connected"))
            }

            override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
                val ev = runCatching { KeelJson.decodeFromString(EngineEvent.serializer(), data) }.getOrNull()
                    ?: EngineEvent(type = type ?: "message")
                val name = type ?: ev.type
                val callId = ev.callId
                if ((ev.type == "helper.delta" || ev.type == "agent.delta") && callId != null) {
                    val text = (ev.data as? JsonObject)?.get("text")?.jsonPrimitive?.content.orEmpty()
                    _liveText.value = _liveText.value + (callId to text)
                    return
                }
                if (ev.type == "helper.finished" && callId != null) _liveText.value = _liveText.value - callId
                if (ev.type.endsWith(".step") || ev.type.endsWith("thinking.delta")) return // frequent, nothing to reload
                _changes.tryEmit(if (ev.type.isEmpty()) ev.copy(type = name) else ev)
            }

            override fun onClosed(eventSource: EventSource) = onClosed()
            override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
                onClosed()
            }
        })
    }
}
