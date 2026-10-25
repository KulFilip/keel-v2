package dev.keel.jetbrains.api

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Duration

/** Engine events and agent steps as activity lines (each kind), the "Now" state, and the feed filter. */
class ActivityTest {
    companion object {
        fun data(vararg kv: Pair<String, Any?>): JsonObject = JsonObject(
            kv.filter { it.second != null }.associate { (k, v) ->
                k to when (v) {
                    is Number -> JsonPrimitive(v)
                    is Boolean -> JsonPrimitive(v)
                    else -> JsonPrimitive(v.toString())
                } as JsonElement
            },
        )

        fun ev(type: String, call: String? = "c1", at: String = "2026-10-25T10:00:00Z", vararg kv: Pair<String, Any?>) =
            EngineEvent(type = type, threadId = "t1", projectId = "p1", step = "code", at = at, callId = call, data = data(*kv))

        fun step(n: Int, kind: String, vararg kv: Pair<String, Any?>) = ev("agent.step", "c1", "2026-10-25T10:00:0${n}Z", "n" to n, "kind" to kind, *kv)
    }

    @Test
    fun `a read and a search`() {
        val l = activityOf(step(1, "read", "path" to "src/Prefs.kt", "text" to "class Prefs"), { "implementer" })!!
        assertEquals(ActKind.READ, l.kind)
        assertEquals("Read src/Prefs.kt", l.title)
        assertEquals("src/Prefs.kt", l.path)
        assertEquals("implementer", l.agent)
        assertEquals("Search TODO", activityOf(step(2, "tool", "tool" to "Grep", "text" to "TODO"))!!.title)
    }

    @Test
    fun `an edit counts its lines, a write is new, a failed edit says so`() {
        val diff = "--- a/src/Prefs.kt\n+++ b/src/Prefs.kt\n@@ -1,2 +1,3 @@\n class Prefs {\n-  val x = 1\n+  val x = 2\n+  val y = 3\n"
        val e = activityOf(step(3, "edit", "path" to "src/Prefs.kt", "diff" to diff, "ok" to true))!!
        assertEquals(ActKind.EDIT, e.kind)
        assertEquals("Edit src/Prefs.kt", e.title)
        assertEquals(2 to 1, e.added to e.removed)
        assertEquals(diff, e.detail)
        assertEquals("Write src/New.kt", activityOf(step(4, "write", "path" to "src/New.kt", "diff" to "+a\n"))!!.title)
        val bad = activityOf(step(5, "edit", "path" to "src/Prefs.kt", "ok" to false, "output" to "no match"))!!
        assertEquals("Edit src/Prefs.kt failed", bad.title)
        assertEquals(false, bad.ok)
    }

    @Test
    fun `a command, its exit code and its output`() {
        val c = activityOf(step(6, "tool", "tool" to "Bash", "text" to "git status --short", "output" to " M src/Prefs.kt", "ok" to true))!!
        assertEquals(ActKind.COMMAND, c.kind)
        assertEquals("$ git status --short", c.title)
        assertEquals(" M src/Prefs.kt", c.detail)
        val ran = activityOf(ev("tool.ran", null, "2026-10-25T10:00:07Z", "tool" to "lint", "cmd" to "ktlint src", "code" to 1, "ok" to false, "output" to "Prefs.kt:3: bad"))!!
        assertEquals(ActKind.COMMAND, ran.kind)
        assertEquals(1, ran.exit)
        assertEquals("lint", ran.agent)
    }

    @Test
    fun `test runs show passed and failed counts`() {
        val t = activityOf(step(8, "tool", "tool" to "Bash", "text" to "uv run pytest", "output" to "....\n===== 14 passed, 2 failed in 1.2s ====="))!!
        assertEquals(ActKind.TEST, t.kind)
        assertEquals(14 to 2, t.passed to t.failed)
        assertEquals("Tests: 14 passed, 2 failed (uv run pytest)", t.title)
        assertEquals(12 to 0, testCounts("BUILD SUCCESSFUL\n12 tests completed"))
        assertEquals(11 to 1, testCounts("12 tests completed, 1 failed"))
        assertEquals(9 to 3, testCounts("Tests run: 12, Failures: 2, Errors: 1, Skipped: 0"))
        assertEquals(13 to 1, testCounts("Tests:       1 failed, 13 passed, 14 total"))
        assertEquals(5 to 0, testCounts("test result: ok. 5 passed; 0 failed; 0 ignored"))
        assertNull(testCounts("Compiling shop v0.1.0"))
        val ran = activityOf(ev("tool.ran", null, "2026-10-25T10:00:09Z", "tool" to "tests", "cmd" to "./gradlew test", "code" to 0, "output" to "41 tests completed"))!!
        assertEquals(ActKind.TEST, ran.kind)
        assertEquals(0, ran.exit)
    }

    @Test
    fun `guard refusals from the agent and from keel`() {
        val g = activityOf(step(9, "guard", "tool" to "write_file", "path" to ".env", "text" to "writing .env is not allowed in this phase"))!!
        assertEquals(ActKind.GUARD, g.kind)
        assertEquals("Refused: writing .env is not allowed in this phase", g.title)
        val r = activityOf(ev("guard.refused", null, "2026-10-25T10:01:00Z", "tool" to "diff-guard", "reason" to "the fix touched the tests"))!!
        assertEquals(ActKind.GUARD, r.kind)
        assertTrue(r.title.contains("the fix touched the tests"))
    }

    @Test
    fun `gates, steps, agents and the end of the flow`() {
        assertEquals("Gate opened: Approve the spec?", activityOf(ev("gate.waiting", null, "x", "title" to "Approve the spec?"))!!.title)
        val d = activityOf(ev("gate.decided", null, "y", "gate" to "spec", "decision" to "approve", "why" to "looks right"))!!
        assertEquals("Gate answered: spec → approve", d.title)
        assertEquals("looks right", d.detail)
        assertEquals("Step started: Write the tests (AC-1)", activityOf(ev("step.started", null, "z", "name" to "Write the tests", "ac" to "AC-1"))!!.title)
        assertEquals(ActKind.STEP, activityOf(ev("step.finished", null, "z2", "name" to "Write the tests"))!!.kind)
        assertEquals("Started (sonnet 5.5 · high)", activityOf(ev("agent.started", "c1", "a", "agent" to "tester", "model" to "sonnet 5.5", "effort" to "high"))!!.title)
        val f = activityOf(ev("agent.finished", "c1", "b", "agent" to "tester", "status" to "done", "tokens_in" to 9000, "tokens_out" to 800, "cost_usd" to 0.06))!!
        assertEquals(ActKind.AGENT, f.kind)
        assertTrue(f.title.startsWith("Done · ") && f.title.endsWith("$0.06"))
        assertEquals(ActKind.ERROR, activityOf(ev("agent.finished", "c1", "c", "agent" to "tester", "status" to "failed", "result" to "turn limit"))!!.kind)
        assertEquals(ActKind.ERROR, activityOf(ev("thread.failed", null, "d", "error" to "boom"))!!.kind)
        assertNull(activityOf(ev("agent.usage", "c1", "e", "tokens_in" to 5)))
        assertNull(activityOf(step(10, "thinking", "text" to "hmm")))
        assertNull(activityOf(step(11, "text", "text" to "I will now edit")))
    }

    @Test
    fun `the same step from the backlog and the live stream is one line`() {
        val live = activityOf(step(3, "read", "path" to "a.kt"))!!
        val backlog = activityOfStep(JobStep(n = 3, kind = "read", path = "a.kt"), "tester", "c1")!!
        assertEquals(live.key, backlog.key)
    }

    @Test
    fun `now - who runs, with usage and time, gone when finished`() {
        val f = FlowLive()
        f.apply(ev("step.started", null, "2026-10-25T10:00:00Z", "name" to "Code"))
        f.apply(ev("agent.started", "c1", "2026-10-25T10:00:00Z", "agent" to "implementer", "model" to "sonnet 5.5", "effort" to "high"))
        f.apply(ev("agent.usage", "c1", "2026-10-25T10:01:00Z", "tokens_in" to 18000, "tokens_out" to 200, "cost_usd" to 0.12))
        assertEquals("Code", f.step)
        val a = f.running.getValue("c1")
        assertEquals("implementer · sonnet 5.5 · high · 2:14 · 18k tokens · $0.12", a.line(a.since!!.plus(Duration.ofSeconds(134))))
        assertEquals("implementer", f.agentOf("c1"))
        f.apply(ev("agent.finished", "c1", "2026-10-25T10:03:00Z", "agent" to "implementer", "status" to "done"))
        assertTrue(f.running.isEmpty())
        assertEquals("implementer", f.agentOf("c1"))
        f.start(JobRow("c2", threadId = "t1", agent = "reviewer", model = "opus", status = "running", startedAt = "2026-10-25T10:04:00Z", tokensIn = 100))
        assertEquals("reviewer", f.running.getValue("c2").agent)
    }

    @Test
    fun `the feed filter`() {
        val edit = activityOf(step(1, "edit", "path" to "a.kt"))!!
        val cmd = activityOf(step(2, "tool", "tool" to "Bash", "text" to "ls"))!!
        val test = activityOf(step(3, "tool", "tool" to "Bash", "text" to "pytest", "output" to "3 passed"))!!
        assertTrue(ActFilter.EDITS.matches(edit) && !ActFilter.EDITS.matches(cmd))
        assertTrue(ActFilter.COMMANDS.matches(cmd) && ActFilter.COMMANDS.matches(test))
        assertTrue(ActFilter.TESTS.matches(test) && !ActFilter.TESTS.matches(cmd))
        assertFalse(ActFilter.TESTS.matches(edit))
        assertTrue(ActFilter.ALL.matches(edit))
    }
}
