package keel.api.flow

import keel.api.events.EngineEventStored
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Component

/**
 * v0.7.x: a flow that a flow hands over to (change → feature) works where its parent worked: the same worktree. A flow
 * the engine gave a worktree of its own (a fix of a hunt finding, on its own fix/ branch from the base) records that one.
 */
@Component
class FlowWorktreeEvents(private val flows: FlowService) {
    @EventListener
    fun on(stored: EngineEventStored) {
        val e = stored.event
        // B8 an init that made no commit gives the folder back on the base branch
        if (e.type == "thread.done" || e.type == "thread.failed") { if (e.threadId.isNotBlank()) flows.releaseEmptyBranch(e.threadId); return }
        if (e.type != "thread.started") return
        val own = e.data["worktree"] as? Map<*, *>
        val name = own?.get("name")?.toString()
        val branch = own?.get("branch")?.toString()
        if (!name.isNullOrBlank() && !branch.isNullOrBlank() && e.threadId.isNotBlank()) {
            flows.recordWorktree(e.threadId, name, branch)
            return
        }
        val parent = (e.data["parent"] as? Map<*, *>)?.get("thread_id")?.toString() ?: return
        if (parent.isNotBlank() && e.threadId.isNotBlank()) flows.inheritWorktree(e.threadId, parent)
    }
}
