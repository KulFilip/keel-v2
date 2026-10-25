package dev.keel.jetbrains.ide

import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import dev.keel.jetbrains.api.ActFilter
import dev.keel.jetbrains.api.ActivityTest
import dev.keel.jetbrains.settings.KeelSettings
import dev.keel.jetbrains.ui.FlowActivity

/** The Flows tab's activity feed in a headless IDE, fed a fake event stream (no keel). */
class FlowActivityIdeTest : BasePlatformTestCase() {
    override fun setUp() {
        super.setUp()
        KeelSettings.get().state.url = "http://127.0.0.1:9"
        KeelSettings.get().state.mode = KeelSettings.MODE_PAIRED
    }

    fun `test the feed appends lines from the live stream`() {
        val d = Disposer.newDisposable()
        try {
            val feed = FlowActivity(project, "p1", "t1", d, loadBacklog = false)
            val stream = listOf(
                ActivityTest.ev("step.started", null, "2026-10-25T10:00:00Z", "name" to "Code"),
                ActivityTest.ev("agent.started", "c1", "2026-10-25T10:00:01Z", "agent" to "implementer", "model" to "sonnet 5.5", "effort" to "high"),
                ActivityTest.step(1, "read", "path" to "src/Prefs.kt"),
                ActivityTest.step(2, "edit", "path" to "src/Prefs.kt", "diff" to "+a\n-b\n"),
                ActivityTest.step(3, "tool", "tool" to "Bash", "text" to "./gradlew test", "output" to "14 tests completed, 1 failed"),
                ActivityTest.step(3, "tool", "tool" to "Bash", "text" to "./gradlew test", "output" to "14 tests completed, 1 failed"), // the same step twice
                ActivityTest.step(4, "thinking", "text" to "hmm"), // not a line
                ActivityTest.ev("agent.usage", "c1", "2026-10-25T10:00:09Z", "tokens_in" to 1000),
                ActivityTest.ev("agent.step", "other-call", "2026-10-25T10:00:10Z", "n" to 1, "kind" to "read", "path" to "x").copy(threadId = "another-flow"),
            )
            stream.forEach { feed.accept(it) }
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            assertEquals(5, feed.lineCount()) // step, agent, read, edit, test
            assertEquals(1, feed.live.running.size)
            assertTrue(feed.text().lines().any { it.contains("implementer") && it.contains("Edit src/Prefs.kt") && it.contains("+1 −1") })
            feed.setFilter(ActFilter.TESTS)
            assertEquals(1, feed.shownCount())
            feed.setFilter(ActFilter.EDITS)
            assertEquals(1, feed.shownCount())
            feed.accept(ActivityTest.ev("agent.finished", "c1", "2026-10-25T10:01:00Z", "agent" to "implementer", "status" to "done"))
            assertTrue(feed.live.running.isEmpty())
            assertEquals(6, feed.lineCount())
        } finally {
            Disposer.dispose(d)
        }
    }
}
