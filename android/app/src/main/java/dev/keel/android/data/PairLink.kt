package dev.keel.android.data

import java.net.URI
import java.net.URLDecoder

/** What a pairing QR code (or the `keel://pair` link) carries: keel's address, the one-time code and keel's name. */
data class PairLink(val url: String, val code: String, val name: String?)

object PairLinks {
    /**
     * Reads `keel://pair?u=<urlencoded base URL>&c=<one-time code>&n=<urlencoded keel name>`. Returns null for anything
     * else: another scheme or host, a missing or non-http(s) `u`, or a missing code.
     */
    fun parse(raw: String?): PairLink? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        val uri = runCatching { URI(text) }.getOrNull() ?: return null
        if (!uri.scheme.equals("keel", ignoreCase = true)) return null
        // keel://pair?... (host "pair") and keel:pair?... (opaque) both name the pair action
        val action = uri.host ?: uri.schemeSpecificPart?.substringBefore('?')?.trim('/')
        if (!action.equals("pair", ignoreCase = true)) return null
        val query = uri.rawQuery ?: uri.rawSchemeSpecificPart?.substringAfter('?', "") ?: return null
        val params = query.split('&').filter { it.isNotEmpty() }.associate { part ->
            val k = part.substringBefore('=')
            val v = part.substringAfter('=', "")
            decode(k) to decode(v)
        }
        val url = params["u"]?.trim().orEmpty()
        val code = params["c"]?.trim().orEmpty()
        if (url.isEmpty() || code.isEmpty()) return null
        val base = KeelApi.normalizeBase(url) ?: return null
        if (!url.contains("://")) return null
        return PairLink(base.toString().trimEnd('/'), code, params["n"]?.trim()?.takeIf { it.isNotEmpty() })
    }

    private fun decode(s: String): String = runCatching { URLDecoder.decode(s, "UTF-8") }.getOrDefault(s)
}
