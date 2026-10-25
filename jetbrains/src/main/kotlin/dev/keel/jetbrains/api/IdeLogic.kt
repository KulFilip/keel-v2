package dev.keel.jetbrains.api

/** Pure helpers of the IDE screens (kept out of the Swing code so the unit tests read them). */

/** A review thread's place in the thread filter chips. */
enum class ThreadState2(val label: String) { WAITING("Waiting for you"), OPEN("Open"), RESOLVED("Resolved") }

/** Waiting for you: open, and the last word is someone else's. Open: open, and you spoke last. */
fun threadStateOf(t: ReviewThread, me: String?): ThreadState2 = when {
    t.resolved -> ThreadState2.RESOLVED
    me != null && t.comments.lastOrNull()?.author.equals(me, ignoreCase = true) -> ThreadState2.OPEN
    else -> ThreadState2.WAITING
}

fun firstLine(text: String, max: Int = 60): String {
    val l = text.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()
    return if (l.length > max) l.take(max - 1).trimEnd() + "…" else l
}

/** A `path:line` in an answer of KeelBot (orders.py:39, src/Prefs.kt:4). */
data class FileRef(val path: String, val line: Int, val start: Int, val end: Int)

private val FILE_REF = Regex("""(?<![\w/.-])((?:[\w.-]+/)*[\w-]+\.[A-Za-z][\w]{0,7}):(\d{1,6})(?:[-–](\d{1,6}))?""")

fun fileRefs(text: String): List<FileRef> = FILE_REF.findAll(text).map {
    FileRef(it.groupValues[1], it.groupValues[2].toInt(), it.range.first, it.range.last + 1)
}.toList()

/** The CI line of a PR: "CI 2/2 ✓", "CI 1/2 ✗", "" when there are no checks. */
fun ciSummary(checks: List<CheckRun>): String {
    if (checks.isEmpty()) return ""
    val ok = checks.count { it.state.lowercase() in setOf("success", "passed", "neutral", "skipped") }
    val bad = checks.count { it.state.lowercase() in setOf("failure", "failed", "error", "cancelled", "timed_out") }
    val mark = when {
        bad > 0 -> "✗"
        ok == checks.size -> "✓"
        else -> "…"
    }
    return "CI $ok/${checks.size} $mark"
}

/** The workflow the Start a flow dialog suggests for a request. */
fun suggestWorkflow(request: String, ids: List<String>): String? {
    val t = request.lowercase()
    val want = when {
        Regex("""\b(bug|fix|broken|crash|wrong|error|fails?)\b""").containsMatchIn(t) -> "fix"
        Regex("""\b(rename|typo|tiny|one line|bump)\b""").containsMatchIn(t) -> "quick"
        else -> "feature"
    }
    return ids.firstOrNull { it == want } ?: ids.firstOrNull()
}

/** What the built-in workflows do, the dialog's second line (keel's own workflows have no description field). */
val WORKFLOW_BLURBS = mapOf(
    "feature" to "Something new: spec, tests first, code, review",
    "small" to "A small feature, test-first, no long ship part",
    "fix" to "A bug: first a test that shows it",
    "bug" to "A bug: first a test that shows it",
    "quick" to "A tiny change: one agent, the tests, one look",
    "review" to "Review your branch; changes nothing",
)

/** The request text the dialog starts with, from an editor selection. */
fun requestFromSelection(path: String, startLine: Int, endLine: Int, code: String): String {
    val todo = Regex("""(?:TODO|FIXME)[:\s]+(.+)""").find(code)?.groupValues?.get(1)?.trim()
    val where = if (startLine == endLine) "$path:$startLine" else "$path:$startLine-$endLine"
    return buildString {
        if (todo != null) append(todo.replaceFirstChar { it.uppercase() }).append("\n\n")
        append("Code: ").append(where).append('\n')
        append("```\n").append(code.trimEnd()).append("\n```\n")
    }
}

/** A title from the first words of a request. */
fun titleFrom(request: String, max: Int = 60): String {
    val l = request.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() && !it.startsWith("```") && !it.startsWith("Code:") }.orEmpty()
    return firstLine(l.trimEnd('.'), max)
}

/** "a–b" changed-line ranges of a `git diff -U0` (new side), for KeelBot's "changed lines" marks. */
fun changedRanges(diff: String): List<IntRange> = Regex("""^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@""", RegexOption.MULTILINE)
    .findAll(diff).mapNotNull {
        val start = it.groupValues[1].toInt()
        val count = it.groupValues[2].ifEmpty { "1" }.toInt()
        if (count == 0) null else start until start + count
    }.toList()

/** The device name keel shows in Settings › Devices. */
fun deviceName(ide: String, host: String): String = "$ide on ${host.removeSuffix(".local").ifBlank { "this computer" }}"

/** A token cap as typed: "300k" → 300000, "1.5m" → 1500000, "" → 0, junk → -1. */
fun parseTokens(s: String): Int {
    val t = s.trim().lowercase().replace(",", "").replace("_", "")
    if (t.isEmpty()) return 0
    val mult = when {
        t.endsWith("k") -> 1_000.0
        t.endsWith("m") -> 1_000_000.0
        else -> 1.0
    }
    val n = t.trimEnd('k', 'm').toDoubleOrNull() ?: return -1
    if (n < 0) return -1
    return (n * mult).toInt()
}
