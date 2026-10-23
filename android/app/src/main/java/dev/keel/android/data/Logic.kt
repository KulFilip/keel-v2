package dev.keel.android.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

// Pure helpers the screens share (no Android here, so the unit tests run on the JVM). Several are ports of the web's
// own (web/src/questions.ts) so a phone answer is the same answer the dashboard sends.

/** The four steps the mockup's bars show. */
val STEP_NAMES = listOf("Spec", "Test", "Code", "Review")

/** Which of the four steps a phase belongs to; 4 = all done. */
fun stepOf(phase: String?, status: String? = null): Int {
    if (status == "done") return 4
    val p = phase.orEmpty().lowercase()
    return when {
        p.isEmpty() || p == "none" -> 0
        p in setOf("setup", "preflight", "workspace", "triage", "spec", "spec-ok", "contract", "bug-report", "small-change", "trivial") -> 0
        p.startsWith("spec") || p.startsWith("triage") -> 0
        p in setOf("red", "bug-repro") || p.startsWith("red") -> 1
        p in setOf("green", "ac", "refactor", "integration", "lint-fix", "coverage-fix", "bug-investigate", "bug-fix") -> 2
        p.startsWith("green") || p.endsWith("-fix") -> 2
        else -> 3 // gate, ac-gate, review, e2e, smoke, ship, pr...
    }
}

/** A waiting question's choices as rows: keel's choice_info when it sent one, else the raw names (a reject needs a reason). */
fun choiceRows(choices: List<String>?, info: List<ChoiceInfo>?): List<ChoiceInfo> {
    if (!info.isNullOrEmpty()) return info
    return choices.orEmpty().mapIndexed { n, name ->
        ChoiceInfo(name = name, label = name.replaceFirstChar { it.uppercase() }, description = "", why = if (name == "reject") "required" else "none", default = n == 0)
    }
}

/** Why the answer cannot be sent yet ("" = it can). */
fun choiceProblem(c: ChoiceInfo?, why: String): String = when {
    c == null -> "Choose one first."
    c.why == "required" && why.isBlank() -> "Write why first: “${c.label}” needs a reason."
    else -> ""
}

fun defaultPick(q: ClarifyQuestion): List<String> = if (q.multiple) q.options.filter { it.recommended }.map { it.label } else emptyList()

/** The picked option of a single question when it takes a reason: the typed words are then that option's reason. */
fun reasonOption(q: ClarifyQuestion, picked: List<String>?): String? {
    if (q.multiple || picked.isNullOrEmpty()) return null
    val o = q.options.firstOrNull { it.label == picked.first() } ?: return null
    return if (o.why == "required" || o.why == "optional") o.label else null
}

/**
 * The answers to send (web questions.ts answersOf): a typed answer wins over a clicked option (an option that takes a
 * reason sends "<label>: <words>"); a `multiple` question sends its ticks plus the typed words, an untouched one its
 * recommended options; an unanswered single question is left out (keel then uses the recommended one).
 */
fun answersOf(questions: List<ClarifyQuestion>, picked: Map<String, List<String>>, typed: Map<String, String>): JsonObject {
    val out = LinkedHashMap<String, JsonElement>()
    for (q in questions) {
        val t = typed[q.id].orEmpty().trim()
        val p = picked[q.id]
        if (q.multiple) {
            val ticked = p ?: defaultPick(q)
            val list = ticked + listOfNotNull(t.ifEmpty { null })
            if (list.isNotEmpty()) out[q.id] = JsonArray(list.map { JsonPrimitive(it) })
        } else if (t.isNotEmpty()) {
            val r = reasonOption(q, p)
            out[q.id] = JsonPrimitive(if (r != null) "$r: $t" else t)
        } else if (!p.isNullOrEmpty()) {
            out[q.id] = JsonPrimitive(p.first())
        }
    }
    return JsonObject(out)
}

const val ANSWERS_PREFIX = "Answers to your questions:"

/** The answers as the next chat message to KeelBot (web questions.ts answersMessage). */
fun answersMessage(questions: List<ClarifyQuestion>, answers: JsonObject): String =
    (listOf(ANSWERS_PREFIX) + questions.mapIndexed { i, q ->
        val said = when (val a = answers[q.id]) {
            is JsonArray -> a.joinToString("; ") { (it as? JsonPrimitive)?.contentOrNull.orEmpty() }
            is JsonPrimitive -> a.contentOrNull.orEmpty()
            else -> ""
        }
        "${i + 1}. ${q.question}\n   → ${said.ifEmpty { "(not answered: use the recommended one)" }}"
    }).joinToString("\n")

private val QUESTIONS_FENCE = Regex("""(?m)^\s*(`{3,}|~{3,})\s*keel-questions\s*$""")

/** KeelBot's answer split into its text and the questions of a ```keel-questions``` block (web parseQuestions). */
fun splitKeelQuestions(text: String): Pair<String, List<ClarifyQuestion>> {
    val m = QUESTIONS_FENCE.find(text) ?: return text to emptyList()
    val fence = m.groupValues[1]
    val start = m.range.last + 1
    val end = text.indexOf("\n" + fence, start).takeIf { it >= 0 } ?: return text to emptyList()
    val body = text.substring(start, end).trim()
    val rest = (text.substring(0, m.range.first) + text.substring(minOf(text.length, end + fence.length + 1))).trim()
    return rest to parseQuestions(body)
}

fun parseQuestions(raw: String): List<ClarifyQuestion> {
    val v = runCatching { KeelJson.parseToJsonElement(raw) }.getOrNull() ?: return emptyList()
    val list = when (v) {
        is JsonArray -> v
        is JsonObject -> (v["questions"] as? JsonArray) ?: return emptyList()
        else -> return emptyList()
    }
    val out = mutableListOf<ClarifyQuestion>()
    list.forEachIndexed { i, q ->
        if (out.size >= 4 || q !is JsonObject) return@forEachIndexed
        val question = q.str("question")
        val opts = (q["options"] as? JsonArray).orEmpty().take(4).mapNotNull { o ->
            when (o) {
                is JsonPrimitive -> o.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }?.let { QuestionOption(it) }
                is JsonObject -> o.str("label").takeIf { it.isNotEmpty() }?.let {
                    QuestionOption(it, o.str("description").ifEmpty { null }, (o["recommended"] as? JsonPrimitive)?.booleanOrNull == true)
                }
                else -> null
            }
        }.toMutableList()
        if (question.isEmpty() || opts.isEmpty()) return@forEachIndexed
        if (opts.none { it.recommended }) opts[0] = opts[0].copy(recommended = true)
        out += ClarifyQuestion(
            id = q.str("id").ifEmpty { "q${i + 1}" }, question = question, why = q.str("why").ifEmpty { null },
            options = opts, multiple = (q["multiple"] as? JsonPrimitive)?.booleanOrNull == true,
        )
    }
    return out
}

private fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.contentOrNull?.trim().orEmpty()
private fun JsonArray?.orEmpty(): List<JsonElement> = this ?: emptyList()

/** "12 min", "2 h", "1 d" since an ISO time; "" when it cannot be read. */
fun ago(iso: String?, now: Instant = Instant.now()): String {
    val t = parseTime(iso) ?: return ""
    val s = Duration.between(t, now).seconds.coerceAtLeast(0)
    return when {
        s < 60 -> "now"
        s < 3600 -> "${s / 60} min"
        s < 86_400 -> "${s / 3600} h"
        else -> "${s / 86_400} d"
    }
}

fun clock(iso: String?, zone: ZoneId = ZoneId.systemDefault()): String =
    parseTime(iso)?.atZone(zone)?.format(DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT)) ?: ""

fun parseTime(iso: String?): Instant? {
    if (iso.isNullOrBlank()) return null
    return runCatching { Instant.parse(iso) }.getOrNull()
        ?: runCatching { OffsetDateTime.parse(iso).toInstant() }.getOrNull()
        ?: runCatching { java.time.LocalDateTime.parse(iso).atZone(ZoneId.of("UTC")).toInstant() }.getOrNull()
}

fun usd(v: Double): String = "$" + String.format(Locale.ROOT, "%.2f", v)

fun ktokens(n: Long): String = when {
    n >= 1_000_000 -> String.format(Locale.ROOT, "%.1fM", n / 1_000_000.0)
    n >= 1_000 -> "${(n + 500) / 1000}k"
    else -> n.toString()
}

/** One line of a diff snippet: its new-file line number (or null for a removed line), the mark and the text. */
data class DiffLine(val number: Int?, val mark: Char, val text: String)

/** The lines of a unified diff around a review comment's line (new side), at most [max] lines ending at `line`. */
fun diffSnippet(diff: String, line: Int?, startLine: Int? = null, max: Int = 4): List<DiffLine> {
    if (line == null || diff.isBlank()) return emptyList()
    val out = mutableListOf<DiffLine>()
    var newLine = 0
    val hunk = Regex("""^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@""")
    for (raw in diff.lines()) {
        val h = hunk.find(raw)
        if (h != null) { newLine = h.groupValues[1].toInt(); continue }
        if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ") || raw.startsWith("index ")) continue
        if (newLine == 0) continue
        when {
            raw.startsWith("+") -> { out += DiffLine(newLine, '+', raw.drop(1)); newLine++ }
            raw.startsWith("-") -> out += DiffLine(null, '-', raw.drop(1))
            raw.startsWith("\\") -> Unit
            else -> { out += DiffLine(newLine, ' ', raw.drop(1)); newLine++ }
        }
    }
    val from = (startLine ?: (line - max + 1)).coerceAtMost(line)
    val idxEnd = out.indexOfLast { it.number == line }
    if (idxEnd < 0) return emptyList()
    val idxStart = out.indexOfFirst { (it.number ?: Int.MIN_VALUE) >= from }.takeIf { it in 0..idxEnd } ?: idxEnd
    return out.subList(maxOf(idxStart, idxEnd - 7), idxEnd + 1).toList()
}

/** "Ran 2 commands · read 3 files" from an answer's steps; "" when it used no tool. */
fun toolSummary(steps: List<JobStep>): String {
    val cmds = steps.count { it.kind == "tool" }
    val reads = steps.count { it.kind == "read" }
    val edits = steps.count { it.kind == "edit" || it.kind == "write" }
    val parts = buildList {
        if (cmds > 0) add("Ran $cmds command${if (cmds == 1) "" else "s"}")
        if (reads > 0) add("read $reads file${if (reads == 1) "" else "s"}")
        if (edits > 0) add("changed $edits file${if (edits == 1) "" else "s"}")
    }
    return parts.joinToString(" · ").replaceFirstChar { it.uppercase() }
}

/** The tool log's lines ("$ cmd", "read path"). */
fun toolLines(steps: List<JobStep>): String = steps.mapNotNull { s ->
    when (s.kind) {
        "tool" -> "$ " + s.text.lineSequence().firstOrNull().orEmpty() + if (s.ok == false) "  (failed)" else ""
        "read" -> "read ${s.path ?: s.text.lineSequence().firstOrNull().orEmpty()}"
        "edit", "write" -> "${s.kind} ${s.path.orEmpty()}"
        else -> null
    }
}.joinToString("\n")

/** keel's verdict words for the check card. */
fun verdictLabel(v: String): String = when (v) {
    "reviewer_right" -> "REVIEWER IS RIGHT"
    "author_right" -> "AUTHOR IS RIGHT"
    "partly" -> "PARTLY"
    else -> "UNCLEAR"
}

/** Initials for an avatar: "sara.k" → "SK", "you" → "YO". */
fun initials(name: String): String {
    val parts = name.split('.', '-', '_', ' ').filter { it.isNotBlank() }
    return when {
        parts.size >= 2 -> "${parts[0][0]}${parts[1][0]}".uppercase()
        name.length >= 2 -> name.take(2).uppercase()
        else -> name.uppercase()
    }
}

/** A JSON object for a gate answer's payload. */
fun payloadOf(vararg pairs: Pair<String, JsonElement>): JsonObject = JsonObject(pairs.toMap())

fun JsonElement.objOrNull(): JsonObject? = runCatching { jsonObject }.getOrNull()
fun JsonElement.arrOrNull(): JsonArray? = runCatching { jsonArray }.getOrNull()
