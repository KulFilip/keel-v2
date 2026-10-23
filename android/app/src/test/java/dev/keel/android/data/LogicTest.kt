package dev.keel.android.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class LogicTest {
    private val multi = ClarifyQuestion(
        "carriers", "Which carriers first?",
        options = listOf(QuestionOption("DHL", recommended = true), QuestionOption("PostNL", recommended = true), QuestionOption("UPS")),
        multiple = true,
    )
    private val single = ClarifyQuestion(
        "store", "Where to log?",
        options = listOf(QuestionOption("app log", recommended = true), QuestionOption("audit table"), QuestionOption("other", why = "required")),
    )

    @Test
    fun `answers follow the web's rules`() {
        // untouched: a multiple question sends its recommended options, a single one is left out
        assertEquals(JsonObject(mapOf("carriers" to JsonArray(listOf(JsonPrimitive("DHL"), JsonPrimitive("PostNL"))))), answersOf(listOf(multi, single), emptyMap(), emptyMap()))
        // typed words win over a clicked option; on a multiple question they are added
        val a = answersOf(listOf(multi, single), mapOf("carriers" to listOf("UPS"), "store" to listOf("audit table")), mapOf("carriers" to "GLS", "store" to "a file"))
        assertEquals(JsonArray(listOf(JsonPrimitive("UPS"), JsonPrimitive("GLS"))), a["carriers"])
        assertEquals(JsonPrimitive("a file"), a["store"])
        // an option that takes a reason sends "<label>: <reason>"
        assertEquals(JsonPrimitive("other: syslog"), answersOf(listOf(single), mapOf("store" to listOf("other")), mapOf("store" to "syslog"))["store"])
    }

    @Test
    fun `reads KeelBot's question block and keeps the rest of the answer`() {
        val text = "Here is why.\n\n```keel-questions\n{\"questions\":[{\"question\":\"How?\",\"options\":[\"A\",{\"label\":\"B\",\"description\":\"bee\"}]}]}\n```\nAfter."
        val (rest, qs) = splitKeelQuestions(text)
        assertEquals(1, qs.size)
        assertEquals("q1", qs[0].id)
        assertEquals(listOf("A", "B"), qs[0].options.map { it.label })
        assertTrue("the first option is recommended when none is", qs[0].options[0].recommended)
        assertTrue(rest.startsWith("Here is why.") && rest.endsWith("After.") && !rest.contains("keel-questions"))
        assertEquals("Answers to your questions:\n1. How?\n   → B", answersMessage(qs, JsonObject(mapOf("q1" to JsonPrimitive("B")))))
    }

    @Test
    fun `maps phases to the four steps`() {
        assertEquals(0, stepOf("spec"))
        assertEquals(1, stepOf("red"))
        assertEquals(2, stepOf("green"))
        assertEquals(2, stepOf("review-fix"))
        assertEquals(3, stepOf("ac-gate"))
        assertEquals(4, stepOf("green", "done"))
    }

    @Test
    fun `cuts the diff lines around a comment`() {
        val diff = "diff --git a/x b/x\n@@ -10,3 +10,4 @@\n a\n-b\n+c\n+d\n e\n"
        val s = diffSnippet(diff, line = 12, startLine = 11)
        assertEquals(listOf(DiffLine(11, '+', "c"), DiffLine(12, '+', "d")), s)
        // no start line: the few lines before it, the removed one too
        assertEquals(listOf(DiffLine(10, ' ', "a"), DiffLine(null, '-', "b"), DiffLine(11, '+', "c"), DiffLine(12, '+', "d")), diffSnippet(diff, line = 12))
        assertEquals(emptyList<DiffLine>(), diffSnippet(diff, line = 99))
    }

    @Test
    fun `says how long ago and sums up tool calls`() {
        val now = Instant.parse("2026-10-23T12:00:00Z")
        assertEquals("12 min", ago("2026-10-23T11:48:00Z", now))
        assertEquals("2 h", ago("2026-10-23T10:00:00Z", now))
        assertEquals("", ago(null, now))
        assertEquals("Ran 2 commands · read 1 file", toolSummary(listOf(JobStep(kind = "tool"), JobStep(kind = "tool"), JobStep(kind = "read"), JobStep(kind = "text"))))
        assertEquals("SK", initials("sara.k"))
    }
}
