package keel.api.common

import jakarta.servlet.http.HttpServletRequest
import org.springframework.web.util.UriUtils
import java.nio.charset.StandardCharsets

/**
 * One way to read "which path is this request for", shared by every filter that decides by path (LocalAuth, McpAudit,
 * McpLevelGuard). `request.requestURI` is the raw path: Spring MVC matches the controllers on a cleaned one (it drops
 * `;params`, decodes `%xx`, skips empty and `.` segments), so `/api;x/projects` or `/%61pi/projects` reached a
 * controller while `startsWith("/api/")` on the raw path said "not the api" and skipped the checks.
 * [of] gives the cleaned path the controllers see; [ambiguous] marks the forms nobody writes on purpose.
 */
object ApiPath {
    private val ENCODED_SEPARATOR = Regex("%(2f|5c|2e|00)", RegexOption.IGNORE_CASE)

    /** The path as Spring MVC matches it: no `;params`, percent-decoded, no empty or `.` segments, `..` resolved. */
    fun of(request: HttpServletRequest): String = clean(request.requestURI ?: "")

    fun clean(raw: String): String {
        val noParams = raw.split('/').joinToString("/") { it.substringBefore(';') }
        val decoded = runCatching { UriUtils.decode(noParams, StandardCharsets.UTF_8) }.getOrDefault(noParams)
        val out = ArrayList<String>()
        for (seg in decoded.replace('\\', '/').split('/')) {
            when (seg) {
                "", "." -> {}
                ".." -> if (out.isNotEmpty()) out.removeAt(out.size - 1)
                else -> out.add(seg)
            }
        }
        val trailing = if (decoded.endsWith("/") && out.isNotEmpty()) "/" else ""
        return "/" + out.joinToString("/") + trailing
    }

    /** The api's own paths: the ones that need a credential. */
    fun isApi(path: String): Boolean = path.startsWith("/api/") || path.startsWith("/internal/")

    /** A raw path with `;`, a backslash, `//`, an encoded `/` `\` `.` or NUL, or a `.`/`..` segment: refused for the api. */
    fun ambiguous(request: HttpServletRequest): Boolean {
        val raw = request.requestURI ?: return false
        return raw.contains(';') || raw.contains('\\') || raw.contains("//") || ENCODED_SEPARATOR.containsMatchIn(raw) ||
            raw.split('/').any { it == "." || it == ".." }
    }
}
