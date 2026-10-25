package keel.api.flow

import keel.api.engine.EngineClient
import keel.api.events.EngineEventStored
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Component
import java.util.concurrent.Executors

/**
 * A flow's saved state (threads.state_json: the run history's "ACs done 5 of 6", KeelBot, keel TUI) follows the engine
 * when the flow pauses or ends. Before, it was saved only when the api asked the engine (a resume, the Flow page): a
 * resume answers before the engine applies the answer, so the last criterion's "done" was never saved and the history
 * said 5/6 while the Flow page said 6/6. The engine is asked on one background worker, after the event is stored.
 * Off with keel.refresh-state-on-events=false (the API tests, whose stub engine answers one fixed state).
 */
@Component
class ThreadStateRefresh(
    private val engine: EngineClient,
    private val flows: FlowService,
    @Value("\${keel.refresh-state-on-events:true}") var enabled: Boolean,
) {
    private val log = LoggerFactory.getLogger(javaClass)
    private val worker = Executors.newSingleThreadExecutor { r -> Thread(r, "thread-state").apply { isDaemon = true } }

    @EventListener
    fun on(stored: EngineEventStored) {
        val e = stored.event
        if (!enabled || e.type !in TYPES || e.threadId.isBlank()) return
        worker.execute {
            runCatching { flows.save(e.threadId, engine.thread(e.threadId)) }
                .onFailure { log.debug("could not refresh the state of {}: {}", e.threadId, it.message) }
        }
    }

    companion object {
        /** A pause or an end: the state the history shows changed and the engine holds it still. */
        val TYPES = setOf("gate.waiting", "thread.done", "thread.failed", "budget.stop")
    }
}
