package dev.keel.jetbrains.api

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import java.time.Duration
import java.time.Instant

/** A flow's live activity (the Flows tab): engine events and agent steps as one line each, and who runs now. */

enum class ActKind { READ, EDIT, COMMAND, TEST, GUARD, GATE, STEP, AGENT, TEXT, ERROR }

/** The Flows tab's feed filter. */
enum class ActFilter(val label: String) {
    ALL("All"), EDITS("Edits"), COMMANDS("Commands"), TESTS("Tests");

    fun matches(l: ActivityLine): Boolean = when (this) {
        ALL -> true
        EDITS -> l.kind == ActKind.EDIT
        COMMANDS -> l.kind == ActKind.COMMAND || l.kind == ActKind.TEST
        TESTS -> l.kind == ActKind.TEST
    }
}

/**
 * One line of the feed. [key] keeps a step seen twice (the backlog of /api/jobs/{call}/steps and the live agent.step)
 * once. [detail] is the folded part: a command's output, an edit's diff, a refusal's reason.
 */
data class ActivityLine(
    val key: String,
    val at: String,
    val agent: String?,
    val kind: ActKind,
    val title: String,
    val path: String? = null,
    val added: Int = 0,
    val removed: Int = 0,
    val detail: String? = null,
    val ok: Boolean? = null,
    val exit: Int? = null,
    val passed: Int? = null,
    val failed: Int? = null,
) {
    /** The line as text (Copy log). */
    fun plain(): String = buildString {
        append(clock(at).ifBlank { "--:--" }).append("  ")
        agent?.let { append(it).append("  ") }
        append(title)
        if (added > 0 || removed > 0) append("  +").append(added).append(" −").append(removed)
        exit?.let { append("  exit ").append(it) }
    }
}

private fun JsonObject.s(k: String): String? = (this[k] as? JsonPrimitive)?.contentOrNull?.ifBlank { null }
private fun JsonObject.i(k: String): Long? = (this[k] as? JsonPrimitive)?.longOrNull
private fun JsonObject.d(k: String): Double? = (this[k] as? JsonPrimitive)?.doubleOrNull
private fun JsonObject.b(k: String): Boolean? = (this[k] as? JsonPrimitive)?.booleanOrNull

/** +added −removed of a unified diff (file headers left out). */
fun diffStat(diff: String?): Pair<Int, Int> {
    if (diff.isNullOrEmpty()) return 0 to 0
    var a = 0
    var r = 0
    diff.lineSequence().forEach { l ->
        when {
            l.startsWith("+++") || l.startsWith("---") -> Unit
            l.startsWith("+") -> a++
            l.startsWith("-") -> r++
        }
    }
    return a to r
}

/** Passed / failed counts in a test run's output (pytest, jest, vitest, Gradle, Maven/JUnit, go test, cargo); null: none. */
fun testCounts(output: String?): Pair<Int, Int>? {
    if (output.isNullOrBlank()) return null
    val t = output
    Regex("""Tests run:\s*(\d+),\s*Failures:\s*(\d+)(?:,\s*Errors:\s*(\d+))?""").findAll(t).lastOrNull()?.let {
        val run = it.groupValues[1].toInt()
        val bad = it.groupValues[2].toInt() + (it.groupValues[3].toIntOrNull() ?: 0)
        return (run - bad).coerceAtLeast(0) to bad
    }
    Regex("""(\d+) tests? completed(?:, (\d+) failed)?""").findAll(t).lastOrNull()?.let {
        val run = it.groupValues[1].toInt()
        val bad = it.groupValues[2].toIntOrNull() ?: 0
        return (run - bad).coerceAtLeast(0) to bad
    }
    Regex("""test result: \w+\. (\d+) passed; (\d+) failed""").findAll(t).lastOrNull()?.let {
        return it.groupValues[1].toInt() to it.groupValues[2].toInt()
    }
    val passed = Regex("""(\d+) (?:passed|passing)\b""").findAll(t).lastOrNull()?.groupValues?.get(1)?.toInt()
    val failed = Regex("""(\d+) (?:failed|failing|errors?)\b""").findAll(t).lastOrNull()?.groupValues?.get(1)?.toInt()
    if (passed == null && failed == null) {
        val ok = Regex("""(?m)^(ok|PASS)\s+\S+""").findAll(t).count()
        val bad = Regex("""(?m)^(FAIL|--- FAIL)\b""").findAll(t).count()
        return if (ok + bad > 0 && Regex("""(?m)^(ok|FAIL)\s""").containsMatchIn(t)) ok to bad else null
    }
    return (passed ?: 0) to (failed ?: 0)
}

private val COMMAND_TOOLS = setOf("bash", "run_command", "shell", "exec_command", "command", "terminal")
private val READ_TOOLS = setOf("read", "read_file", "view", "cat", "grep", "glob", "search", "ls", "list_files", "find")

/** One agent step (a live agent.step's data, or a step of /api/jobs/{call}/steps) as a feed line; null: not shown. */
fun activityOfStep(s: JobStep, agent: String?, callId: String?, at: String = s.at): ActivityLine? {
    val key = "${callId ?: "?"}#${s.n}"
    val tool = s.tool.orEmpty()
    return when (s.kind) {
        "read" -> ActivityLine(key, at, agent, ActKind.READ, "Read ${s.path ?: firstLine(s.text)}", path = s.path)
        "write", "edit" -> {
            val (a, r) = diffStat(s.diff)
            val verb = if (s.kind == "write") "Write" else "Edit"
            val failed = s.ok == false
            ActivityLine(key, at, agent, ActKind.EDIT, "$verb ${s.path ?: ""}${if (failed) " failed" else ""}".trim(), path = s.path,
                added = a, removed = r, detail = s.diff ?: s.output, ok = s.ok)
        }
        "tool" -> {
            val lt = tool.lowercase()
            val counts = testCounts(s.output)
            when {
                counts != null -> ActivityLine(key, at, agent, ActKind.TEST, testTitle(counts, s.text), detail = s.output, ok = counts.second == 0,
                    passed = counts.first, failed = counts.second)
                lt in COMMAND_TOOLS -> ActivityLine(key, at, agent, ActKind.COMMAND, "$ ${firstLine(s.text, 120)}", detail = s.output, ok = s.ok)
                lt in READ_TOOLS || (s.path != null && lt.contains("read")) ->
                    ActivityLine(key, at, agent, ActKind.READ, "${if (lt == "grep" || lt == "glob" || lt == "search") "Search" else "Read"} ${s.path ?: firstLine(s.text, 100)}", path = s.path)
                else -> ActivityLine(key, at, agent, ActKind.COMMAND, "${s.server?.let { "$it:" } ?: ""}$tool ${firstLine(s.text, 100)}".trim(), detail = s.output, ok = s.ok)
            }
        }
        "guard" -> ActivityLine(key, at, agent, ActKind.GUARD, "Refused: ${firstLine(s.text, 120)}", path = s.path, detail = s.text, ok = false)
        "error" -> ActivityLine(key, at, agent, ActKind.ERROR, "Error: ${firstLine(s.text, 120)}", detail = s.text, ok = false)
        "answer", "result" -> s.text.takeIf { it.isNotBlank() }?.let { ActivityLine(key, at, agent, ActKind.TEXT, firstLine(it, 120), detail = it.takeIf { t -> t.length > 120 }) }
        else -> null // text, thinking: the agent's prose, not an action
    }
}

private fun testTitle(c: Pair<Int, Int>, cmd: String): String =
    "Tests: ${c.first} passed, ${c.second} failed" + firstLine(cmd, 80).takeIf { it.isNotBlank() }?.let { " ($it)" }.orEmpty()

/** An engine event as a feed line; [agentOf] names the agent of a call id; null: not a line (deltas, usage). */
fun activityOf(ev: EngineEvent, agentOf: (String?) -> String? = { null }): ActivityLine? {
    val d = ev.data as? JsonObject ?: JsonObject(emptyMap())
    val agent = d.s("agent") ?: agentOf(ev.callId)
    val key = "${ev.type}|${ev.callId ?: ev.step}|${ev.at}|${d.s("n") ?: ""}"
    return when (ev.type) {
        "agent.step" -> activityOfStep(
            JobStep(
                n = d.i("n")?.toInt() ?: 0, at = ev.at, kind = d.s("kind") ?: "text", text = d.s("text").orEmpty(), tool = d.s("tool"),
                path = d.s("path"), ok = d.b("ok"), diff = d.s("diff"), output = d.s("output"), ms = d.i("ms"), server = d.s("server"),
            ),
            agent, ev.callId, ev.at,
        )
        "tool.ran" -> {
            val out = d.s("output")
            val counts = testCounts(out)
            val cmd = d.s("cmd") ?: d.s("tool").orEmpty()
            val code = d.i("code")?.toInt()
            if (counts != null) {
                ActivityLine(key, ev.at, agent ?: d.s("tool"), ActKind.TEST, testTitle(counts, cmd), detail = out, ok = counts.second == 0, exit = code,
                    passed = counts.first, failed = counts.second)
            } else {
                ActivityLine(key, ev.at, agent ?: d.s("tool"), ActKind.COMMAND, "$ ${firstLine(cmd, 120)}", detail = out, ok = d.b("ok"), exit = code)
            }
        }
        "guard.refused" -> {
            val why = d.s("reason") ?: d.s("why") ?: d.s("message") ?: d.s("text") ?: d.s("tool") ?: "a guard"
            ActivityLine(key, ev.at, agent, ActKind.GUARD, "Refused: ${firstLine(why, 120)}", path = d.s("path"), detail = d.toString().takeIf { it.length > 2 }, ok = false)
        }
        "gate.waiting" -> ActivityLine(key, ev.at, null, ActKind.GATE, "Gate opened: ${d.s("title") ?: d.s("name") ?: ev.step ?: "a question"}")
        "gate.decided" -> {
            val what = listOfNotNull(d.s("choice") ?: d.s("decision"), d.s("by")?.let { "by $it" }).joinToString(" ")
            ActivityLine(key, ev.at, null, ActKind.GATE, "Gate answered: ${d.s("gate") ?: ev.step ?: ""} → $what".trim(), detail = d.s("why"))
        }
        "step.started" -> ActivityLine(key, ev.at, null, ActKind.STEP, "Step started: ${d.s("name") ?: ev.step ?: ""}${d.s("ac")?.let { " ($it)" } ?: ""}")
        "step.finished" -> ActivityLine(key, ev.at, null, ActKind.STEP, "Step done: ${d.s("name") ?: ev.step ?: ""}${d.s("status")?.takeIf { it != "done" }?.let { " · $it" } ?: ""}")
        "agent.started" -> ActivityLine(key, ev.at, agent, ActKind.AGENT,
            "Started" + listOfNotNull(d.s("model"), d.s("effort")).joinToString(" · ").takeIf { it.isNotBlank() }?.let { " ($it)" }.orEmpty())
        "agent.finished" -> {
            val tokens = (d.i("tokens_in") ?: 0) + (d.i("tokens_out") ?: 0)
            val status = d.s("status") ?: "done"
            ActivityLine(key, ev.at, agent, if (status == "failed") ActKind.ERROR else ActKind.AGENT,
                "${status.replaceFirstChar { it.uppercase() }} · ${ktokens(tokens)} tokens · ${usd(d.d("cost_usd") ?: 0.0)}",
                detail = d.s("result")?.takeIf { status == "failed" }, ok = status != "failed")
        }
        "thread.done" -> ActivityLine(key, ev.at, null, ActKind.STEP, "The flow is done")
        "thread.failed" -> ActivityLine(key, ev.at, null, ActKind.ERROR, "The flow failed: ${firstLine(d.s("error") ?: d.s("message") ?: "", 120)}", ok = false)
        else -> null
    }
}

/** An agent running now (the "Now" part): who, which model, since when, and its usage so far. */
data class RunningAgent(
    val callId: String,
    val agent: String,
    val model: String?,
    val effort: String?,
    val since: Instant?,
    val tokens: Long = 0,
    val costUsd: Double = 0.0,
) {
    fun line(now: Instant = Instant.now()): String = listOfNotNull(
        agent,
        model,
        effort,
        since?.let { elapsed(Duration.between(it, now)) },
        if (tokens > 0) "${ktokens(tokens)} tokens" else null,
        if (costUsd > 0) usd(costUsd) else null,
    ).joinToString(" · ")
}

fun elapsed(d: Duration): String {
    val s = d.seconds.coerceAtLeast(0)
    return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s % 3600 / 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}

/** The flow's "now": its current step and running agents, kept up to date from the events. */
class FlowLive {
    var step: String? = null
        private set
    val running = LinkedHashMap<String, RunningAgent>()

    fun agentOf(callId: String?): String? = callId?.let { running[it]?.agent ?: seen[it] }
    private val seen = HashMap<String, String>()

    /** A running call from the jobs list (a flow opened mid-run). */
    fun start(job: JobRow) {
        val agent = job.agent ?: return
        seen[job.id] = agent
        if (job.status == "running") {
            running[job.id] = RunningAgent(job.id, agent, job.model, job.effort, parseTime(job.startedAt), job.tokensIn + job.tokensOut, job.costUsd)
            job.step?.let { step = step ?: it }
        }
    }

    fun apply(ev: EngineEvent) {
        val d = ev.data as? JsonObject ?: JsonObject(emptyMap())
        val call = ev.callId
        when (ev.type) {
            "step.started" -> step = d.s("name") ?: ev.step
            "step.finished" -> if (step == (d.s("name") ?: ev.step)) step = null
            "agent.started" -> if (call != null) {
                val agent = d.s("agent") ?: "agent"
                seen[call] = agent
                running[call] = RunningAgent(call, agent, d.s("model"), d.s("effort"), parseTime(ev.at) ?: Instant.now())
            }
            "agent.usage" -> if (call != null) running[call]?.let {
                running[call] = it.copy(tokens = (d.i("tokens_in") ?: 0) + (d.i("tokens_out") ?: 0), costUsd = d.d("cost_usd") ?: it.costUsd)
            }
            "agent.finished" -> if (call != null) running.remove(call)
            "thread.done", "thread.failed" -> {
                running.clear()
                step = null
            }
        }
    }
}
