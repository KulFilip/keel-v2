package dev.keel.jetbrains.api

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GateFormTest {
    private val named = Waiting(
        step = "spec-gate", kind = "gate", title = "Approve the spec?", id = "q1", options = listOf("approve", "reject"),
        choices = listOf("approve", "change"),
        choiceInfo = listOf(ChoiceInfo("approve", "Approve", "go on", "none", true), ChoiceInfo("change", "Change it", "rewrite", "required")),
    )

    @Test
    fun `named choices answer approve with the choice and the question id`() {
        val f = GateForm.of("t1", named)
        assertEquals("approve", f.picked)
        val a = f.action() as GateAction.Answer
        assertEquals(InboxAnswer("approve", id = "q1", payload = JsonObject(mapOf("choice" to JsonPrimitive("approve")))), a.body)
    }

    @Test
    fun `a choice that needs a reason waits for it`() {
        val f = GateForm.of("t1", named).pick("change")
        assertEquals("Why? (needed)", f.reasonLabel)
        assertTrue(f.problem().startsWith("Write why first"))
        val ok = f.setWhy("AC-3: audit table")
        assertEquals("", ok.problem())
        assertEquals("AC-3: audit table", (ok.action() as GateAction.Answer).body.why)
    }

    @Test
    fun `a plain gate offers approve, send back and stop`() {
        val w = Waiting(step = "ac-gate", kind = "gate", title = "AC-1 done?", id = "q2", options = listOf("approve", "reject"), labels = Labels("Looks good", null))
        val f = GateForm.of("t2", w)
        assertEquals(listOf(GateForm.APPROVE, GateForm.REJECT, GateForm.STOP), f.rows.map { it.name })
        assertEquals("Looks good", f.sendLabel)
        val back = f.pick(GateForm.REJECT).setWhy("the test is too weak")
        val a = back.action() as GateAction.Answer
        assertEquals("reject", a.body.decision)
        assertNull(a.body.payload)
        assertEquals(GateAction.Stop("t2"), f.pick(GateForm.STOP).action())
    }

    @Test
    fun `a clarify step sends its answers`() {
        val q = ClarifyQuestion("c", "Which?", options = listOf(QuestionOption("A", recommended = true), QuestionOption("B")), multiple = true)
        val f = GateForm.of("t3", Waiting(kind = "clarify", title = "Which?", id = "q3", questions = listOf(q)))
        assertTrue(f.rows.isEmpty())
        val picked = f.toggle(q, "B")
        val body = (picked.action() as GateAction.Answer).body
        assertEquals("""{"answers":{"c":["A","B"]}}""", body.payload.toString())
        assertEquals("Send the answers", f.sendLabel)
    }
}
