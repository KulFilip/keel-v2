package keel.api.auth

import jakarta.servlet.http.HttpServletRequest
import keel.api.common.Hash
import keel.api.common.KeelProperties
import org.springframework.stereotype.Component
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
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

    fun matches(candidate: String?): Boolean = !candidate.isNullOrEmpty() && Hash.constantTimeEquals(candidate, value)

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
        Files.deleteIfExists(tmp)
        keel.api.common.OwnerOnly.create(tmp, (made + "\n").toByteArray())
        Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        return made
    }

    companion object {
        private val random = SecureRandom()
        fun hex(b: ByteArray): String = Hash.hex(b)
        fun sha256(s: String): String = Hash.sha256Hex(s)
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
