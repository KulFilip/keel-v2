package keel.api.notifications

/**
 * The words of a notification: a title a person understands (never a step id) and at most three short lines, each one
 * fact with a mark. The full text stays in the notification's body (the Inbox and an opened notification show it).
 *
 * Nothing here cuts in the middle of a word: a long line ends at a word with "…", and too many lines become
 * "+N more".
 */
object NoticeText {
    const val ASK = "◆"
    const val OK = "✓"
    const val SKIP = "⤼"
    const val FAIL = "✗"
    const val RUN = "▸"
    private val MARKS = listOf(ASK, OK, SKIP, FAIL, RUN, "•")

    /** Gates of the spec phase that are menus, not the spec itself: their own name says more. */
    private val SPEC_MENUS = setOf("options", "sections", "task_type")

    /** The most lines a toast shows. */
    const val MAX_LINES = 3

    /** The longest line, in characters. */
    const val LINE = 80

    /** The mark of a notification type (review waits for you, failed, finished, budget, started). */
    fun markOf(type: String): String = when (type) {
        "review", "budget" -> ASK
        "failed" -> FAIL
        "finished" -> OK
        "started" -> RUN
        else -> ASK
    }

    /** [title] with the mark of [type] in front, unless it already starts with a mark; a snake_case id becomes words. */
    fun marked(type: String, title: String): String {
        val t = humanize(title.trim()).ifBlank { "keel" }
        return if (MARKS.any { t.startsWith(it) }) t else "${markOf(type)} $t"
    }

    /**
     * The title of a gate that waits for a person. [project] is the project's name; [flow], [step], [stepName],
     * [phase], [ac] come from the engine's gate.waiting event (older engines send only [fallback], the step's name).
     */
    fun gateTitle(project: String?, kind: String?, flow: String?, step: String?, stepName: String?, phase: String?,
                  ac: String?, fallback: String?): String {
        val p = project?.trim().orEmpty()
        fun ask(what: String) = if (p.isBlank()) "$ASK ${what.replaceFirstChar { it.uppercase() }}" else "$ASK $p: $what"
        val id = step.orEmpty()
        val name = humanize(stepName?.ifBlank { null } ?: fallback?.substringBefore(" · ")?.ifBlank { null } ?: id).trim()
        return when {
            kind == "clarify" -> ask("your answers are needed")
            kind == "budget" -> ask("a budget cap paused the flow")
            kind == "fix" -> ask("${name.ifBlank { "a step" }} was sent back again and again")
            flow == "init" && id == "hand_over" -> if (p.isBlank()) "$ASK The project is set up — check it" else "$ASK $p is set up — check it"
            flow == "init" && id == "plan_gate" -> ask("approve the setup plan?")
            flow == "init" && id == "questions" -> ask("your answers are needed")
            flow == "init" && id == "rung_gate" -> ask("a setup check fails")
            flow == "init" && id == "git_repo" -> ask("not a git repository yet")
            flow == "init" && id == "audit_now" -> ask("run a bug hunt now?")
            !ac.isNullOrBlank() -> ask("check $ac")
            id.endsWith("questions") || name in setOf("questions", "your answers") -> ask("your answers are needed")
            id.contains("spec") || phase == "spec" && id !in SPEC_MENUS -> ask("approve the spec?")
            id == "plan_gate" || id == "plan" && phase == "triage" -> ask("approve the plan?")
            id == "final_review" -> ask("approve the final review?")
            id == "pr_gate" -> ask("open the PR?")
            name.isNotBlank() -> ask(name)
            else -> ask("a step waits for you")
        }
    }

    /** "✓ <flow> is done". */
    fun doneTitle(flowTitle: String?): String = "$OK ${flowName(flowTitle)} is done"

    /** "✗ <flow> stopped: <short reason>". */
    fun failedTitle(flowTitle: String?, error: String?): String {
        val why = shortReason(error)
        return "$FAIL ${flowName(flowTitle)} stopped" + if (why.isBlank()) "" else ": $why"
    }

    private fun flowName(t: String?) = t?.trim()?.ifBlank { null }?.let { words(humanize(it), 48) } ?: "The flow"

    /**
     * A failure's reason in a few words: the first line, without a Python or Java exception's class name, ending at a
     * whole word.
     */
    fun shortReason(error: String?, max: Int = 60): String {
        val first = error.orEmpty().lineSequence().map { it.trim() }.firstOrNull { it.isNotBlank() } ?: return ""
        val plain = first.replace(Regex("^([A-Za-z_][\\w.]*(Error|Exception|Exit|Interrupt)):\\s*"), "").trim()
        return words(plain.trimEnd('.').ifBlank { first }, max)
    }

    /** [text] at most [max] characters, cut only after a whole word, with "…" when cut. */
    fun words(text: String, max: Int = LINE): String {
        val t = text.replace(Regex("\\s+"), " ").trim()
        if (t.length <= max) return t
        val room = t.take(max - 1)
        val cut = room.lastIndexOf(' ').takeIf { it >= max / 3 } ?: return room.trimEnd() + "…"
        var kept = room.take(cut).trimEnd(',', ';', ':', ' ', '·', '-', '—')
        // "… because a…" reads badly: a small word at the end goes too
        while (true) {
            val last = kept.substringAfterLast(' ')
            if (last.lowercase() !in SMALL || kept.length - last.length <= max / 3) break
            kept = kept.dropLast(last.length).trimEnd(',', ';', ':', ' ')
        }
        return "$kept…"
    }

    private val SMALL = setOf("a", "an", "the", "of", "to", "and", "or", "in", "on", "at", "for", "with", "by", "because", "is", "are")

    /** At most [max] lines; more become max-1 lines and "+N more". Blank lines go; each line ends at a whole word. */
    fun clip(lines: List<String>, max: Int = MAX_LINES): List<String> {
        val kept = lines.map { words(it) }.filter { it.isNotBlank() }
        if (kept.size <= max) return kept
        return kept.take(max - 1) + "+${kept.size - (max - 1)} more"
    }

    /**
     * Short lines from prose (a body without a summary): one line per paragraph line or sentence, markdown marks
     * removed, at most [max] lines. Never a cut word.
     */
    fun fromBody(body: String?, max: Int = MAX_LINES): List<String> {
        val text = body.orEmpty()
            .replace(Regex("```[\\s\\S]*?```"), " ")
            .replace(Regex("`([^`]*)`"), "$1")
            .replace(Regex("\\[([^]]+)]\\([^)]*\\)"), "$1")
        val lines = text.lines()
            .map { it.trim().replace(Regex("^#{1,6}\\s+"), "").replace(Regex("^[-*]\\s+"), "").replace("**", "").trim() }
            .filter { it.isNotBlank() && !it.matches(Regex("-{3,}")) }
            .flatMap { sentences(it) }
        return clip(lines, max)
    }

    private fun sentences(line: String): List<String> =
        if (line.length <= LINE) listOf(line)
        else line.split(Regex("(?<=[.!?])\\s+(?=[A-Z0-9])")).map { it.trim() }.filter { it.isNotBlank() }

    /** A snake_case or kebab-case id ("hand_over") as words ("hand over"); other text stays as it is. */
    fun humanize(s: String): String =
        s.replace(Regex("(?<![\\w./])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\\w./])")) { it.value.replace('_', ' ') }
}
