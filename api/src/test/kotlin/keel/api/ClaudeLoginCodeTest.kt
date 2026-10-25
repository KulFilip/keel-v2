package keel.api

import keel.api.connections.ConnectionService
import keel.api.connections.LoginService
import keel.api.connections.LoginView
import keel.api.connections.SecretService
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.mockito.ArgumentMatchers.anyString
import java.nio.file.Files
import java.nio.file.Path

/**
 * The Claude login box after a code: the real CLI (2.1.197) refuses a code from another `setup-token` run with
 * "OAuth error: Request failed with status code 400" / "Press Enter to retry." — the box must say so and get a new link,
 * not show "Checking the code…" forever. Stand-in CLIs here, no pseudo-terminal, made-up tokens only.
 */
class ClaudeLoginCodeTest {
    private val dir: Path = Files.createTempDirectory("claude-login-test")
    private val secrets: SecretService = mock(SecretService::class.java)

    @AfterEach
    fun clean() { dir.toFile().deleteRecursively() }

    private fun service(script: String, timeoutSec: Long = 60): LoginService {
        val f = dir.resolve("fake-claude.sh")
        Files.writeString(f, script)
        return LoginService(secrets, keel.api.connections.FirstModelLogin(mock(keel.api.settings.SettingsService::class.java), false), false, "sh $f", "true", "true", timeoutSec)
    }

    private fun LoginService.waitUntil(id: String, ok: (LoginView) -> Boolean): LoginView {
        repeat(150) {   // up to 15 s
            val v = get(id)
            if (ok(v)) return v
            Thread.sleep(100)
        }
        error("login $id never got there: ${get(id)}")
    }

    @Test
    fun `a refused code puts the box back to code_needed with a new link, and the second code saves the token`() {
        val token = "sk-ant-oat02-test" + "A".repeat(40)
        val svc = service("""
            echo "Browser didn't open? Use the url below to sign in (c to copy)"
            echo 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=first'
            printf 'Paste code here if prompted > '
            read code
            echo 'OAuth error: Request failed with status code 400'
            echo 'Press Enter to retry.'
            read enter
            echo 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=second'
            printf 'Paste code here if prompted > '
            read code
            if [ "${'$'}code" = second-code ]; then echo "Your OAuth token: $token"; else echo 'OAuth error: still wrong'; fi
        """.trimIndent())
        val v = svc.start("claude")
        assertThat(v.status).isEqualTo("code_needed")
        assertThat(v.url).endsWith("state=first")

        svc.code(v.id, "old-tab-code")
        val refused = svc.waitUntil(v.id) { it.status == "code_needed" && it.url?.endsWith("state=second") == true }
        assertThat(refused.message).contains("Claude did not accept that code (OAuth error 400)").contains("link from THIS box")
        assertThat(refused.error).isEqualTo(refused.message)
        verify(secrets, never()).put(anyString(), anyString())

        val checking = svc.code(v.id, "second-code")
        assertThat(checking.error).isNull()
        val done = svc.waitUntil(v.id) { it.status in setOf("done", "failed") }
        assertThat(done.status).isEqualTo("done")
        assertThat(done.toString()).doesNotContain("sk-ant-oat02")
        verify(secrets).put("CLAUDE_CODE_OAUTH_TOKEN", token)
    }

    @Test
    fun `a code that gets no answer ends with what the CLI printed, not Checking the code forever`() {
        val svc = service("""
            echo 'https://claude.com/cai/oauth/authorize?code=true&client_id=x'
            printf 'Paste code here if prompted > '
            read code
            echo 'Exchanging the code'
            exec sleep 600
        """.trimIndent(), timeoutSec = 1)
        val v = svc.start("claude")
        assertThat(svc.code(v.id, "some-code").message).isEqualTo("Checking the code…")
        val end = svc.waitUntil(v.id) { it.status != "waiting" }
        assertThat(end.status).isEqualTo("failed")
        assertThat(end.message).doesNotContain("Checking the code")
            .contains("did not answer within 1 s").contains("Exchanging the code").contains("Start again")
    }

    @Test
    fun `the refusal is read from the real CLI's output, with squashed spaces and the masked echo of the code`() {
        assertThat(LoginService.refusal("***************estate\nOAuth error: Request failed with status code 400\nPress Enter to retry.\n"))
            .isEqualTo("OAuth error 400")
        assertThat(LoginService.refusal("Paste code here if prompted > ****estate\nOAutherror:Requestfailedwithstatuscode400\nPressEntertoretry."))
            .isEqualTo("OAuth error 400")
        assertThat(LoginService.refusal("Paste code here if prompted > *******an-error\n")).isNull()   // only the code's own tail
        assertThat(LoginService.refusal("Invalid code\n")).isEqualTo("Invalid code")
        assertThat(LoginService.refusal("")).isNull()
    }

    @Test
    fun `newer sk-ant-oat tokens are taken and not called badly copied`() {
        assertThat(LoginService.CLAUDE_TOKEN.find("token: sk-ant-oat02-test" + "b".repeat(30))?.value).startsWith("sk-ant-oat02-test")
        assertThat(LoginService.CLAUDE_TOKEN.find("sk-ant-oat01-test" + "c".repeat(30))).isNotNull()
        val conn = mock(ConnectionService::class.java, org.mockito.Mockito.CALLS_REAL_METHODS)
        assertThat(conn.shapeProblem("claude", "subscription", "sk-ant-oat02-test" + "d".repeat(30))).isNull()
        assertThat(conn.shapeProblem("claude", "subscription", "half-of-a-token-ABC")).contains("does not start with sk-ant-oat")
    }
}
