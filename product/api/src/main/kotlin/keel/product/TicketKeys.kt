package keel.product

import keel.api.common.BadRequest

/**
 * A team's ticket-key pattern (ERPDM-\d+, SW-\d+): checked when it is saved, then matched case-insensitive and with word
 * edges, so `feature/erpdm-1234-vat` and `ERPDM-1234: add VAT` both give ERPDM-1234. Only the first [TEXT_MAX]
 * characters of a text are read.
 */
object TicketKeys {
    const val MAX = 100
    const val TEXT_MAX = 2048

    /** A group with a repeat inside that is repeated again: (a+)+, (\d*)*, (x{2,})+ — slow on long text. */
    private val NESTED = Regex("""\([^()]*[+*}][^()]*\)\s*[+*{]""")

    /** The pattern a team without its own uses: its Jira project key (letters, digits and _ only). */
    fun default(jiraProject: String?): String? = jiraProject?.takeIf { it.isNotBlank() }?.let { "$it-\\d+" }

    /** The saved form of [pattern] (trimmed; null when blank), or a BadRequest that says what is wrong. */
    fun check(pattern: String?): String? {
        val p = pattern?.trim()?.ifEmpty { null } ?: return null
        if (p.length > MAX) throw BadRequest("The key pattern is too long ($MAX characters at most)", "Like ERPDM-\\d+")
        if (NESTED.containsMatchIn(p)) throw BadRequest("The key pattern repeats a repeat", "Write ERPDM-\\d+, not (ERPDM-\\d+)+.")
        val r = runCatching { Regex(p) }.getOrElse { throw BadRequest("The key pattern is not a valid pattern: ${it.message?.lineSequence()?.first()}", "Like ERPDM-\\d+") }
        if (r.matches("")) throw BadRequest("The key pattern matches nothing at all", "Like ERPDM-\\d+")
        return p
    }

    fun regex(pattern: String): Regex = Regex("(?<![A-Za-z0-9])(?:$pattern)(?![0-9])", RegexOption.IGNORE_CASE)

    /** The keys in [text], upper case, each once, in order. */
    fun find(r: Regex, text: String?): List<String> =
        if (text.isNullOrEmpty()) emptyList() else r.findAll(text.take(TEXT_MAX)).map { it.value.uppercase() }.distinct().toList()
}
