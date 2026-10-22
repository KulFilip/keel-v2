package keel.api.review

import com.fasterxml.jackson.databind.JsonNode
import org.springframework.http.HttpHeaders
import org.springframework.http.ResponseEntity
import java.net.URI
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/** What a list call read: the items, and whether more pages were left unread because [Paging.MAX_PAGES] was reached. */
class Paged(val items: List<JsonNode>, val truncated: Boolean)

/** REST pagination by the `Link` header (GitHub and GitLab both send `rel="next"` and `rel="last"`). */
object Paging {
    /** A list is read for at most this many pages (of 100): a pull request with more is cut, and the review says so. */
    const val MAX_PAGES = 10

    private val LINK = Regex("<([^>]*)>\\s*;\\s*rel=\"?([a-z]+)\"?")
    private val PAGE = Regex("([?&]page=)(\\d+)")

    fun link(headers: HttpHeaders, rel: String): String? =
        headers.getFirst(HttpHeaders.LINK)?.let { h -> LINK.findAll(h).firstOrNull { it.groupValues[2] == rel }?.groupValues?.get(1) }

    /**
     * Reads [first] and the pages after it (`rel="next"`), at most [MAX_PAGES]. [items] picks the list out of a page
     * (a page that is an array as it is, or an object that holds one). [sameHost] says whether a Link may be followed (the
     * token goes with every request: never to another server). [newest]: the list is oldest first and the last pages
     * are the ones that matter, so a list longer than the maximum drops its first pages, not its last.
     */
    fun all(first: String, newest: Boolean, sameHost: (String) -> Boolean, items: (JsonNode) -> JsonNode,
            fetch: (String) -> ResponseEntity<JsonNode>): Paged {
        val out = mutableListOf<JsonNode>()
        var url: String? = first
        var pages = 0
        while (url != null) {
            if (pages >= MAX_PAGES) return Paged(out, true)
            val res = fetch(url)
            pages++
            res.body?.let { b -> items(b).forEach { out.add(it) } }
            val next = link(res.headers, "next")?.takeIf(sameHost)
            if (next != null && newest && pages == 1) {
                val last = link(res.headers, "last")?.takeIf(sameHost)
                val lastPage = last?.let { PAGE.find(it)?.groupValues?.get(2)?.toIntOrNull() }
                if (last != null && lastPage != null && lastPage > MAX_PAGES) {
                    // too long: read the newest pages only (the first page told us how many there are)
                    out.clear()
                    for (p in lastPage - MAX_PAGES + 1..lastPage) {
                        val r = fetch(PAGE.replace(last) { m -> m.groupValues[1] + p })
                        r.body?.let { b -> items(b).forEach { out.add(it) } }
                    }
                    return Paged(out, true)
                }
            }
            url = next
        }
        return Paged(out, false)
    }

    /** "2026-10-22 14:05 UTC" for a reset time (epoch seconds) or a wait in seconds (Retry-After). */
    fun resetTime(headers: HttpHeaders, resetHeader: String?): String? {
        val reset = resetHeader?.let { headers.getFirst(it) }?.trim()?.toLongOrNull()
        val retry = headers.getFirst(HttpHeaders.RETRY_AFTER)?.trim()?.toLongOrNull()
        val at = when {
            reset != null -> Instant.ofEpochSecond(reset)
            retry != null -> Instant.now().plusSeconds(retry)
            else -> return null
        }
        return DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm 'UTC'").withZone(ZoneOffset.UTC).format(at)
    }

    fun sameHost(root: String): (String) -> Boolean {
        val h = URI.create(root).let { it.scheme + "://" + it.authority }
        return { u -> runCatching { URI.create(u).let { it.scheme + "://" + it.authority } == h }.getOrDefault(false) }
    }
}
