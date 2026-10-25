package keel.api.connections

import keel.api.common.BadRequest
import keel.api.common.Conflict
import keel.api.common.NotFound
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Service
import java.io.OutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** What the web sees of a login: never the token, never the CLI's raw output. */
data class LoginView(
    val id: String,
    val provider: String,
    val status: String,            // starting | waiting | code_needed | done | failed | cancelled
    val url: String? = null,       // open this in the browser
    val code: String? = null,      // device code to type on that page (codex, copilot)
    val message: String,
    val hint: String? = null,      // last characters of the saved secret
    val error: String? = null,     // Claude: why the last code was refused (the box shows it in red); null when all is well
)

/**
 * Logs a CLI in from the dashboard, inside the container, and saves the result encrypted in the database:
 * codex `login --device-auth` → auth.json (CODEX_AUTH_JSON), copilot `login --device-code` → GitHub token (GH_TOKEN),
 * claude `setup-token` → the printed token (CLAUDE_CODE_OAUTH_TOKEN; the user pastes the code the Claude page shows).
 *
 * Each login runs in a pseudo-terminal (`script`) with a scratch HOME, so nothing of the user's computer is used and
 * nothing is left behind. The output stays in memory and is never logged or returned.
 */
@Service
class LoginService(
    private val secrets: SecretService,
    @Value("\${keel.login-pty:true}") private val usePty: Boolean,
    @Value("\${keel.login-commands.claude:claude setup-token}") private val claudeCmd: String,
    @Value("\${keel.login-commands.codex:codex login --device-auth}") private val codexCmd: String,
    @Value("\${keel.login-commands.copilot:copilot login --device-code}") private val copilotCmd: String,
    /** Claude: how long keel waits for a token or an error after a code, before it stops the login and says so. */
    @Value("\${keel.login-code-timeout-seconds:60}") private val codeTimeoutSec: Long = 60,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    private class Session(val id: String, val provider: String, val home: Path, val proc: Process, val stdin: OutputStream) {
        val out = StringBuilder()
        @Volatile var status = "starting"
        @Volatile var message = "Starting the login…"
        @Volatile var url: String? = null
        @Volatile var code: String? = null
        @Volatile var hint: String? = null
        /** v0.15.6 the Copilot CLI's "store the token in a plain file?" question was answered */
        @Volatile var consented = false
        /** Claude: a code was sent and keel waits for the token or an error (since [codeSentAt], System.nanoTime) */
        @Volatile var checking = false
        @Volatile var codeSentAt = 0L
        /** Claude: why the CLI refused the last code, shown in the box until the next code */
        @Volatile var error: String? = null
        /** Claude: the CLI refused a code and will ask "Press Enter to retry"; keel presses it once */
        @Volatile var retryPending = false
        /** Claude: Enter was pressed for a retry; the next link the CLI prints replaces [url] */
        @Volatile var newLinkWanted = false
        /** A message that ends the login for good (the code timeout); [finish] keeps it */
        @Volatile var failure: String? = null
        val started: Instant = Instant.now()
    }

    private val sessions = ConcurrentHashMap<String, Session>()

    fun start(provider: String): LoginView {
        val cmd = when (provider) {
            "claude" -> claudeCmd
            "codex" -> codexCmd
            "copilot" -> copilotCmd
            else -> throw BadRequest("No login helper for \"$provider\"", "Use claude, codex or copilot.")
        }
        evictOld(Duration.ofHours(1))
        sessions.values.filter { it.provider == provider && it.status in setOf("starting", "waiting", "code_needed") }.forEach { cancel(it.id) }
        val home = Files.createTempDirectory("keel-login-")
        val env = mapOf(
            "HOME" to home.toString(), "CODEX_HOME" to home.resolve(".codex").toString(), "XDG_CONFIG_HOME" to home.resolve(".config").toString(),
            "PATH" to (System.getenv("PATH") ?: "/usr/local/bin:/usr/bin:/bin"), "LANG" to "C.UTF-8", "TERM" to "xterm-256color",
            "BROWSER" to "/bin/false", "COLUMNS" to "1000",
        )
        Files.createDirectories(home.resolve(".codex"))
        val argv = if (usePty) keel.api.common.Proc.inTerminal("stty cols 1000 rows 50 2>/dev/null; exec $cmd") else listOf("sh", "-c", cmd)
        val pb = ProcessBuilder(argv).directory(home.toFile()).redirectErrorStream(true)
        pb.environment().clear()
        pb.environment().putAll(env)
        val proc = try { pb.start() } catch (e: Exception) {
            throw Conflict("Could not start the $provider login", "Is the $provider CLI installed in the image? (${e.message?.take(120)})")
        }
        val s = Session(UUID.randomUUID().toString().take(12), provider, home, proc, proc.outputStream)
        sessions[s.id] = s
        thread(isDaemon = true, name = "login-${s.id}") { read(s) }
        thread(isDaemon = true, name = "login-wait-${s.id}") { finish(s) }
        // Give the CLI a moment to print its link (and its device code: it can come in a later chunk),
        // so the first answer is already useful.
        repeat(40) { if ((s.url == null || (provider != "claude" && s.code == null)) && s.status == "starting") Thread.sleep(250) }
        return view(s)
    }

    /** Forgets the logins older than [maxAge]: a running one is stopped with its children, and its scratch HOME goes. */
    internal fun evictOld(maxAge: Duration) {
        val cutoff = Instant.now().minus(maxAge)
        sessions.values.filter { !it.started.isAfter(cutoff) }.forEach { s ->
            sessions.remove(s.id)
            if (s.status !in setOf("done", "failed", "cancelled")) { s.status = "cancelled"; keel.api.common.Proc.killTree(s.proc) }
            runCatching { s.home.toFile().deleteRecursively() }
        }
    }

    internal fun sessionCount(): Int = sessions.size

    fun get(id: String): LoginView = view(sessions[id] ?: throw NotFound("No login called $id", "Start the login again."))

    /** Claude: the code the Claude sign-in page shows after login. */
    fun code(id: String, code: String): LoginView {
        val s = sessions[id] ?: throw NotFound("No login called $id", "Start the login again.")
        if (s.provider != "claude") throw BadRequest("Only the Claude login asks for a code")
        if (s.status in setOf("done", "failed", "cancelled")) throw Conflict("This login has ended", "Press Start again for a new link.")
        val c = code.trim()
        if (c.isEmpty() || c.length > 2000 || c.any { it.isWhitespace() }) throw BadRequest("Paste the code exactly as the page shows it (one piece, no spaces)")
        // only what the CLI prints after this code counts for its answer (an error, the token): start a fresh buffer
        synchronized(s.out) { s.out.setLength(0) }
        s.error = null
        s.retryPending = false
        s.newLinkWanted = false
        s.codeSentAt = System.nanoTime()
        s.checking = true
        s.status = "waiting"
        s.message = "Checking the code…"
        try {
            s.stdin.write((c + enter()).toByteArray())
            s.stdin.flush()
        } catch (e: java.io.IOException) {
            s.checking = false
            throw Conflict("The Claude CLI has stopped", "Press Start again for a new link.")
        }
        return view(s)
    }

    fun cancel(id: String): LoginView {
        val s = sessions[id] ?: throw NotFound("No login called $id")
        if (s.status !in setOf("done", "failed")) {
            s.status = "cancelled"
            s.message = "Login cancelled."
        }
        keel.api.common.Proc.killTree(s.proc)
        return view(s)
    }

    private fun view(s: Session) = LoginView(s.id, s.provider, s.status, s.url, s.code, s.message, s.hint, s.error)

    private fun enter() = if (usePty) "\r" else "\n"   // Enter in a terminal is \r

    private fun read(s: Session) {
        PtyOutput.pump(s.proc, s.out, 200_000, 100_000) { parse(s) }
    }

    private fun clean(s: Session): String = PtyOutput.clean(s.out)

    private fun parse(s: Session) {
        if (s.status in setOf("done", "failed", "cancelled")) return
        val text = clean(s)
        if (s.url == null || s.newLinkWanted) {
            findLink(text)?.let { link ->
                s.url = link
                s.newLinkWanted = false
            }
        }
        if (s.provider != "claude" && s.code == null) s.code = Regex("\\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\\b").find(text)?.value
        // v0.15.6 after the person authorized, the Copilot CLI finds no keychain in keel's container and asks
        // "System keychain unavailable. Store token in plaintext config file? (y/N)" — nobody saw it, so the login waited
        // forever. keel answers yes: the token goes to the login's own temporary folder, keel saves it encrypted (GH_TOKEN)
        // and deletes that folder.
        if (s.provider == "copilot" && !s.consented && Regex("(?i)store token in plain ?text").containsMatchIn(text)) {
            s.consented = true
            s.message = "Authorized. Saving the token…"
            runCatching {
                s.stdin.write((if (usePty) "y\r" else "y\n").toByteArray())
                s.stdin.flush()
            }
        }
        if (s.provider == "copilot" && Regex("(?i)token was not saved").containsMatchIn(text) && s.status !in setOf("done", "failed", "cancelled")) {
            s.status = "failed"
            s.message = "GitHub authorized keel, but the Copilot CLI did not save the token. Start the login again, or paste a token."
        }
        when {
            s.provider == "claude" && s.url != null && s.status == "starting" -> {
                s.status = "code_needed"
                s.message = "Open the link, sign in with your Claude account, then paste the code the page shows."
            }
            s.provider != "claude" && s.url != null && s.code != null && s.status == "starting" -> {
                s.status = "waiting"
                s.message = "Open the link, enter the code, and allow access. This page notices by itself when you are done."
            }
        }
        if (s.provider == "claude") {
            CLAUDE_TOKEN.find(text.filterNot { it.isWhitespace() })?.let { save(s, "CLAUDE_CODE_OAUTH_TOKEN", it.value); return }
            claudeAnswer(s, text)
        }
    }

    /**
     * Claude, after a code: the CLI refuses a code it did not make the link for (each `setup-token` run has its own PKCE
     * state, so a code from an older box or browser tab always fails) with "OAuth error: Request failed with status code
     * 400" and "Press Enter to retry." keel shows why, presses Enter once, and takes the new link the CLI then prints.
     */
    private fun claudeAnswer(s: Session, text: String) {
        if (s.checking) {
            val refusal = refusal(text) ?: return
            s.checking = false
            s.error = "Claude did not accept that code ($refusal). A code only works with the link from THIS box: " +
                "press Open claude.com here, sign in again, and paste the new code."
            s.message = s.error!!
            s.status = "code_needed"
            s.retryPending = true
        }
        if (s.retryPending && squashed(text).contains("pressentertoretry")) {
            s.retryPending = false
            s.newLinkWanted = true
            synchronized(s.out) { s.out.setLength(0) }   // the new link is the next one printed
            runCatching {
                s.stdin.write(enter().toByteArray())
                s.stdin.flush()
            }
        }
    }

    /** Called every 2 s while the CLI runs: a code that got no answer at all ends the login with what the CLI printed last. */
    private fun checkCodeTimeout(s: Session) {
        if (!s.checking || s.status != "waiting") return
        if (System.nanoTime() - s.codeSentAt < TimeUnit.SECONDS.toNanos(codeTimeoutSec)) return
        s.checking = false
        val last = lastLine(clean(s).lines().filterNot { isEcho(it) }.joinToString("\n"))
        s.failure = "Claude did not answer within $codeTimeoutSec s after the code" +
            (last?.let { " (the CLI printed last: \"$it\")" } ?: " (the CLI printed nothing after it)") +
            ". Press Start again, open the new link, and paste the new code."
        s.message = s.failure!!
        s.status = "failed"
    }

    private fun finish(s: Session) {
        // v0.15.5 the CLI can stay open after it saved the login (the Copilot CLI does on some machines): look for the
        // result every 2 s while it runs, not only when it ends, so the page does not wait for the 15-minute limit
        val deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(15)
        var ended = false
        while (!ended && System.nanoTime() < deadline && s.status !in setOf("done", "cancelled", "failed")) {
            ended = s.proc.waitFor(2, TimeUnit.SECONDS)
            if (!ended) { collect(s); checkCodeTimeout(s) }
        }
        if (!ended && s.status != "done") keel.api.common.Proc.killTree(s.proc)
        Thread.sleep(200)
        parse(s)
        collect(s)
        if (s.status !in setOf("done", "cancelled")) {
            s.status = "failed"
            s.message = when {
                s.failure != null -> s.failure!!
                s.error != null -> s.error!!.substringBefore(" A code only works") +
                    " A code only works with the link from the same box: press Start again, open the new link, sign in, and paste the new code."
                !ended -> "The login took longer than 15 minutes and was stopped. Start it again."
                else -> lastLine(clean(s))?.let { "The login did not finish: $it" } ?: "The login did not finish. Start it again."
            }
        }
        s.home.toFile().deleteRecursively()
    }

    /** The login's result, when the CLI wrote it to a file: Codex's auth.json, the Copilot CLI's token. */
    private fun collect(s: Session) {
        if (s.status in setOf("done", "cancelled")) return
        try {
            when (s.provider) {
                "codex" -> {
                    val f = s.home.resolve(".codex/auth.json")
                    if (Files.isRegularFile(f) && Files.size(f) > 0) save(s, "CODEX_AUTH_JSON", Files.readString(f))
                }
                "copilot" -> findGithubToken(s.home)?.let { save(s, "GH_TOKEN", it) }
            }
        } catch (e: Exception) {
            log.warn("{} login: could not read the result: {}", s.provider, e.javaClass.simpleName)
        }
    }

    private fun save(s: Session, name: String, value: String) {
        if (s.status == "done") return
        s.hint = secrets.put(name, value)
        s.status = "done"
        s.message = "Logged in. Saved encrypted in keel's database as $name."
        log.info("{} login saved as {}", s.provider, name)
        s.proc.destroy()
    }

    /** The Copilot CLI keeps its token in a config file when there is no system keychain (as in a container). */
    private fun findGithubToken(home: Path): String? {
        val re = Regex("\\b(gho_|ghu_|github_pat_)[A-Za-z0-9_]{20,}")
        return Files.walk(home).use { files ->
            files.filter { Files.isRegularFile(it) && Files.size(it) < 1_000_000 }.toList()
        }.firstNotNullOfOrNull { f -> runCatching { re.find(Files.readString(f))?.value }.getOrNull() }
    }

    /** A short, safe last line for an error (anything that looks like a token is cut out). */
    private fun lastLine(text: String): String? = text.lines().map { it.trim() }.lastOrNull { it.length in 4..200 }?.let(::redact)

    companion object {
        /** `claude setup-token`'s long-lived token: sk-ant-oat01-… today, a newer sk-ant-oatNN-… later. */
        val CLAUDE_TOKEN = Regex("sk-ant-oat\\d{2}-[A-Za-z0-9_\\-]{20,}")

        internal fun findLink(text: String): String? = Regex("https://[^\\s\"'<>]+").findAll(text).map { it.value.trimEnd('.', ',', ')') }
            .firstOrNull { "device" in it || "oauth" in it || "authorize" in it }

        /** The terminal output without any white space, lower case: the CLI's redraws can drop or squash the spaces. */
        private fun squashed(text: String) = text.filterNot { it.isWhitespace() }.lowercase()

        /** The CLI's masked echo of the pasted code ("****…tail"): its visible tail must never count as an error. */
        private fun isEcho(line: String) = line.trim().let { it.startsWith("*") || it.contains("*****") }

        /**
         * Why the Claude CLI refused a code, from what it printed after the code, or null when it has not refused it (yet):
         * "OAuth error 400" from "OAuth error: Request failed with status code 400", else the error line itself.
         */
        internal fun refusal(text: String): String? {
            val lines = text.lines().map { it.replace(Regex("\\*{3,}\\S*"), "").trim() }.filter { it.isNotEmpty() }
            val errorLine = lines.firstOrNull { Regex("(?i)error|invalid").containsMatchIn(it) }
            val flat = squashed(lines.joinToString("\n"))
            if (errorLine == null && "pressentertoretry" !in flat) return null
            val status = Regex("(?i)status\\s*code\\s*(\\d{3})").find(lines.joinToString("\n"))?.groupValues?.get(1)
            return when {
                "oautherror" in flat && status != null -> "OAuth error $status"
                errorLine != null -> redact(errorLine).take(160)
                else -> "it asked to retry"
            }
        }

        private fun redact(line: String) = line.replace(Regex("(sk-ant-[A-Za-z0-9_\\-]+|gh[opsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)"), "…")
    }
}
