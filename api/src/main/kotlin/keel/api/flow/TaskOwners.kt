package keel.api.flow

/*
 * 0.18.57 one owner per task (FlowService.owners): what a start and a running flow or side agent share. A ticket key
 * (SHOPS-1234: the flow's data.ticket, a "SHOPS-1234: ..." title, a "Jira ticket: SHOPS-1234" line), or the files a
 * request names that the other one already changed.
 */

private val TICKET = Regex("""(?<![A-Za-z0-9])([A-Z][A-Z0-9_]{1,29}-\d{1,9})(?![0-9])""")
private val KEEL_IDS = setOf("AC", "BUG", "CHG", "HUNT")
private val JIRA_LINE = Regex("""(?m)^\s*(?:Jira )?ticket:\s*([A-Z][A-Z0-9_]{1,29}-\d{1,9})\b""", RegexOption.IGNORE_CASE)
private val PATH = Regex("""(?<![\w/.-])((?:[\w.-]+/)+[\w.-]+\.[A-Za-z0-9]{1,8}|[\w-]+\.(?:php|kt|kts|java|ts|tsx|js|jsx|py|go|rb|vue|cs|rs|swift|scala|sql))(?![\w/])""")

/** The ticket a start or a flow works on: the given key, else one in the title, else a "Jira ticket:" line. */
fun ticketOf(given: String?, title: String, request: String?): String? {
    given?.trim()?.uppercase()?.takeIf { TICKET.matches(it) }?.let { return it }
    TICKET.findAll(title).map { it.groupValues[1] }.firstOrNull { it.substringBefore('-') !in KEEL_IDS }?.let { return it }
    return request?.let { JIRA_LINE.find(it)?.groupValues?.get(1)?.uppercase() }
}

/** The file paths a text names (src/Cart/Price.php, Price.php). */
fun pathsIn(text: String): Set<String> = PATH.findAll(text).map { it.groupValues[1].trim('.') }.filter { it.isNotBlank() }.toSet()

/** The files both sides name or change (a bare file name matches a path ending in it); null when none. */
fun sharedFiles(wanted: Set<String>, theirs: Collection<String>): List<String>? {
    if (wanted.isEmpty() || theirs.isEmpty()) return null
    val hit = theirs.filter { f -> wanted.any { w -> f == w || f.endsWith("/$w") || w.endsWith("/$f") } }.distinct().sorted()
    return hit.takeIf { it.isNotEmpty() }
}
