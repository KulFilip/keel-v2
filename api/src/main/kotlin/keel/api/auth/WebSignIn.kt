package keel.api.auth

import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import keel.api.common.Forbidden
import keel.api.common.KeelProperties
import org.springframework.http.HttpHeaders
import org.springframework.http.ResponseCookie
import org.springframework.stereotype.Component
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap

/**
 * v0.18.1 the key a person's browser and terminal app sign in with: 32 random bytes in $KEEL_DATA/run/web-key (0600),
 * made once and kept across restarts, so a signed-in browser stays signed in. `keel2 auth reset` deletes the file: the
 * api makes a new key at its next start and every browser signs in again.
 *
 * The cookie's name carries the key's id (`keel_<8 hex>`): browsers keep cookies by host, not by port, so a second keel
 * on localhost (another port) has its own cookie and never reads this one.
 */
@Component
class WebKey(private val props: KeelProperties) {
    val file: Path get() = props.dataDir.resolve("run").resolve("web-key")

    val value: String by lazy { load() }

    val cookieName: String by lazy { "keel_" + sha256(value).take(8) }

    fun matches(candidate: String?): Boolean = !candidate.isNullOrEmpty() && MessageDigest.isEqual(candidate.toByteArray(), value.toByteArray())

    fun cookieOf(request: HttpServletRequest): String? = request.cookies?.firstOrNull { it.name == cookieName }?.value

    /** The key is made when keel starts: a terminal app (keel TUI, xal) reads the file before its first request. */
    @jakarta.annotation.PostConstruct
    fun ensure() {
        value
    }

    private fun load(): String {
        val f = file
        if (Files.isRegularFile(f)) {
            val text = Files.readString(f).trim()
            if (text.length >= 32) return text
        }
        Files.createDirectories(f.parent)
        val made = hex(ByteArray(32).also { random.nextBytes(it) })
        val tmp = f.resolveSibling("web-key.tmp")
        Files.writeString(tmp, made + "\n")
        runCatching { Files.setPosixFilePermissions(tmp, PosixFilePermissions.fromString("rw-------")) }
        Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        return made
    }

    companion object {
        private val random = SecureRandom()
        fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }
        fun sha256(s: String): String = hex(MessageDigest.getInstance("SHA-256").digest(s.toByteArray()))
    }
}

/** One-time sign-in codes: 60 seconds, used once. keel2 asks for one and opens the browser with it. */
@Component
class SignInCodes {
    private val codes = ConcurrentHashMap<String, Long>()

    fun make(now: Long = System.currentTimeMillis()): String {
        codes.entries.removeIf { it.value < now }
        if (codes.size >= MAX) codes.clear()
        val code = WebKey.hex(ByteArray(16).also { random.nextBytes(it) })
        codes[code] = now + TTL.toMillis()
        return code
    }

    /** True once for a code that is still fresh; the code is gone afterwards either way. */
    fun use(code: String?, now: Long = System.currentTimeMillis()): Boolean {
        if (code.isNullOrBlank()) return false
        val until = codes.remove(code.trim()) ?: return false
        return until >= now
    }

    companion object {
        val TTL: Duration = Duration.ofSeconds(60)
        const val MAX = 50
        private val random = SecureRandom()
    }
}

data class SignInCode(val code: String, val path: String, val expires_in: Long)

@RestController
class WebSignInController(private val key: WebKey, private val codes: SignInCodes) {

    /** A one-time sign-in code, only for keel2 and keel's scripts (the internal token; [LocalAuth] checked it). */
    @PostMapping("/api/web/code")
    fun code(request: HttpServletRequest): SignInCode {
        if (request.getAttribute(LocalAuth.WHO_ATTR) != "internal") {
            throw Forbidden("Only keel2 can make a sign-in code", "Run keel2 open in a terminal.")
        }
        val c = codes.make()
        return SignInCode(c, "/web/login?code=$c", SignInCodes.TTL.seconds)
    }

    /** The link keel2 opens: a fresh code sets the sign-in cookie and goes to keel's page; a used or old one says so. */
    @GetMapping("/web/login")
    fun login(@RequestParam(required = false) code: String?, @RequestParam(required = false) next: String?, response: HttpServletResponse) {
        if (!codes.use(code)) {
            response.status = HttpServletResponse.SC_FOUND
            response.setHeader(HttpHeaders.LOCATION, "/?signin=expired")
            return
        }
        response.addHeader(HttpHeaders.SET_COOKIE, cookie(key.value, MAX_AGE).toString())
        response.status = HttpServletResponse.SC_FOUND
        response.setHeader(HttpHeaders.LOCATION, safeNext(next))
    }

    /** Signs this browser out (the cookie goes; the key stays, so other browsers stay signed in). */
    @PostMapping("/api/web/sign-out")
    fun signOut(response: HttpServletResponse): Map<String, Boolean> {
        response.addHeader(HttpHeaders.SET_COOKIE, cookie("", Duration.ZERO).toString())
        return mapOf("ok" to true)
    }

    /** Who this request is (internal, mcp, person, browser): the web asks once to know it is signed in. */
    @GetMapping("/api/web/me")
    fun me(request: HttpServletRequest): Map<String, Any?> = mapOf("signed_in" to true, "via" to request.getAttribute(LocalAuth.WHO_ATTR))

    private fun cookie(value: String, maxAge: Duration): ResponseCookie =
        ResponseCookie.from(key.cookieName, value).httpOnly(true).sameSite("Strict").path("/").maxAge(maxAge).build()

    companion object {
        val MAX_AGE: Duration = Duration.ofDays(400)

        /** Only a path on this keel ("/flow?x=1"), never another site ("//evil", "https://…"). */
        fun safeNext(next: String?): String {
            val n = next?.trim().orEmpty()
            return if (n.startsWith("/") && !n.startsWith("//") && !n.contains('\\') && !n.contains("://")) n else "/"
        }
    }
}
