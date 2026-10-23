package keel.api.auth

import jakarta.servlet.http.HttpServletRequest
import org.springframework.stereotype.Component
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap

/**
 * Brute-force protection for keel's sign-ins once keel is reachable beyond this computer (`keel2 start --wifi`,
 * `keel2 share tailscale|tunnel`): wrong tries are counted per client and per kind in a one-minute window. Over the
 * client's limit, or over the limit of all clients together (a client that changes its forwarded address each try),
 * every try of that kind is refused with 429 until the window has passed, a right one too: a guess must not be checked.
 *
 * A direct call from this computer (loopback, no proxy header) is never counted or refused: it is the person's own
 * browser or terminal, and keel's own scripts (the internal token and MCP tokens are never counted either).
 */
@Component
class AuthLimiter {
    enum class Kind(val perClient: Int, val total: Int) {
        /** the web key (`Authorization: Bearer`), the sign-in cookie, a device token, a sign-in code */
        SIGN_IN(20, 200),
        /** a phone's pairing code: guessable in principle (50 bits), so far fewer tries */
        PAIR(5, 30),
    }

    private val fails = ConcurrentHashMap<String, ArrayDeque<Long>>()

    /** True when this client may not try [kind] now. */
    fun blocked(kind: Kind, request: HttpServletRequest, now: Long = System.currentTimeMillis()): Boolean {
        if (ClientIp.direct(request)) return false
        return count("${kind.name}|${ClientIp.of(request)}", now) >= kind.perClient || count("${kind.name}|*", now) >= kind.total
    }

    /** One wrong try of [kind] by this client. */
    fun fail(kind: Kind, request: HttpServletRequest, now: Long = System.currentTimeMillis()) {
        if (ClientIp.direct(request)) return
        if (fails.size > MAX_KEYS) fails.entries.removeIf { e -> synchronized(e.value) { e.value.none { it > now - WINDOW_MS } } }
        listOf("${kind.name}|${ClientIp.of(request)}", "${kind.name}|*").forEach { k ->
            val q = fails.computeIfAbsent(k) { ArrayDeque() }
            synchronized(q) {
                q.addLast(now)
                while (q.size > 1000) q.removeFirst()
            }
        }
    }

    /** Seconds until the oldest wrong try of the window is gone (for Retry-After). */
    fun retryAfter(): Long = WINDOW_MS / 1000

    fun clear() = fails.clear()

    private fun count(key: String, now: Long): Int {
        val q = fails[key] ?: return 0
        synchronized(q) {
            while (q.isNotEmpty() && q.first() <= now - WINDOW_MS) q.removeFirst()
            return q.size
        }
    }

    companion object {
        const val WINDOW_MS = 60_000L
        const val MAX_KEYS = 10_000
    }
}

/**
 * Who is calling, as an address. keel sees a local proxy as the caller when it is reached through `tailscale serve`
 * or a Cloudflare tunnel (127.0.0.1, or Docker's gateway); then the proxy's header names the real client:
 * Cf-Connecting-Ip (cloudflared sets it, a client cannot), else the last X-Forwarded-For entry (the one the nearest
 * proxy added). A header from a public address is ignored. A caller on the same Wi-Fi (a private address, like Docker's
 * gateway) could still name another address: [AuthLimiter]'s limit for all clients together covers that.
 */
object ClientIp {
    fun of(request: HttpServletRequest): String {
        val remote = request.remoteAddr ?: ""
        if (!proxyLike(remote)) return remote
        request.getHeader("Cf-Connecting-Ip")?.trim()?.takeIf { it.isNotEmpty() }?.let { return it.take(64) }
        request.getHeader("X-Forwarded-For")?.split(',')?.map { it.trim() }?.lastOrNull { it.isNotEmpty() }?.let { return it.take(64) }
        return remote
    }

    /** A call made on this computer itself, not passed on by a proxy. */
    fun direct(request: HttpServletRequest): Boolean =
        loopback(request.remoteAddr ?: "") && request.getHeader("Cf-Connecting-Ip") == null && request.getHeader("X-Forwarded-For") == null

    private fun loopback(ip: String): Boolean = ip == "127.0.0.1" || ip == "::1" || ip == "0:0:0:0:0:0:0:1" || ip.startsWith("127.")

    /** Loopback or a private address (Docker's gateway): where tailscale serve and cloudflared call keel from. */
    private fun proxyLike(ip: String): Boolean {
        if (loopback(ip)) return true
        if (!ip.matches(Regex("[0-9.]+")) && !ip.contains(':')) return false
        return runCatching { InetAddress.getByName(ip).let { it.isSiteLocalAddress || it.isLoopbackAddress } }.getOrDefault(false)
    }
}
