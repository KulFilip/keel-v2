package keel.api

import com.fasterxml.jackson.databind.ObjectMapper
import com.sun.net.httpserver.HttpServer
import keel.api.common.Conflict
import keel.api.connections.GitHubLoginService
import keel.api.connections.SecretService
import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.Path

/** Connections › GitHub › Sign in with GitHub: the device flow through `gh` (a stand-in script here) and the OAuth
 *  device flow without it (a local stub). No real GitHub is called; the token is never in a response. */
class GitHubLoginApiTest : ApiTest() {
    private val ghLog: Path = dataDir.resolve("gh.log")

    @AfterEach
    fun clean() {
        runCatching { delete("/api/github") }
        Files.deleteIfExists(ghLog)
    }

    private fun waitFor(id: String): com.fasterxml.jackson.databind.JsonNode {
        repeat(200) {
            val v = get("/api/github/login/$id").json()
            if (v["status"].asText() in setOf("done", "failed", "cancelled")) return v
            Thread.sleep(100)
        }
        error("sign-in $id never ended")
    }

    @Test
    fun `gh sign-in shows the code and the link, saves the token where a pasted one goes, and says who is connected`() {
        assertThat(get("/api/github").json()["set"].asBoolean()).isFalse()
        val v = post("/api/github/login", mapOf("host" to "github.com")).andExpect(status().isOk).json()
        assertThat(v["code"].asText()).isEqualTo("AB12-CD34")
        assertThat(v["url"].asText()).isEqualTo("https://github.com/login/device")
        val done = waitFor(v["id"].asText())
        assertThat(done["status"].asText()).isEqualTo("done")
        assertThat(done["login"].asText()).isEqualTo("mili-dev")
        assertThat(done["scopes"].map { it.asText() }).containsExactly("read:org", "repo", "workflow")
        assertThat(done.toString()).doesNotContain("gho_fake")

        val gh = get("/api/github").json()
        assertThat(gh["set"].asBoolean()).isTrue()
        assertThat(gh["from"].asText()).isEqualTo("keel")
        assertThat(gh["hint"].asText()).isEqualTo("…234")
        assertThat(gh["login"].asText()).isEqualTo("mili-dev")
        assertThat(gh["host"].asText()).isEqualTo("github.com")
        assertThat(gh["via"].asText()).isEqualTo("gh")
        assertThat(gh.toString()).doesNotContain("gho_fake")

        val calls = Files.readAllLines(ghLog)
        assertThat(calls.first()).isEqualTo("--version")
        assertThat(calls).anyMatch { it == "auth login --hostname github.com --git-protocol https --web --scopes repo,read:org,workflow --insecure-storage" }
        assertThat(calls).contains("auth token --hostname github.com")
    }

    @Test
    fun `an Enterprise host goes to gh as --hostname, and a bad host is refused`() {
        val v = post("/api/github/login", mapOf("host" to "GHE.Example.com")).json()
        assertThat(waitFor(v["id"].asText())["status"].asText()).isEqualTo("done")
        assertThat(Files.readAllLines(ghLog)).anyMatch { it.startsWith("auth login --hostname ghe.example.com ") }
        assertThat(get("/api/github").json()["host"].asText()).isEqualTo("ghe.example.com")
        post("/api/github/login", mapOf("host" to "evil.com; rm -rf /")).andExpect(status().isBadRequest)
    }

    @Test
    fun `sign out removes the token and runs gh auth logout`() {
        val v = post("/api/github/login", mapOf("host" to "github.com")).json()
        waitFor(v["id"].asText())
        delete("/api/github").andExpect(status().isOk)
        val gh = get("/api/github").json()
        assertThat(gh["set"].asBoolean()).isFalse()
        assertThat(gh["login"].isNull).isTrue()
        assertThat(Files.readAllLines(ghLog)).contains("auth logout --hostname github.com")
    }

    @Test
    fun `a pasted token replaces the sign-in and forgets who it was`() {
        waitFor(post("/api/github/login", mapOf("host" to "github.com")).json()["id"].asText())
        put("/api/secrets/GITHUB_REPO_TOKEN", mapOf("value" to "ghp_pastedtoken1234567890")).andExpect(status().isOk)
        val gh = get("/api/github").json()
        assertThat(gh["hint"].asText()).isEqualTo("…890")
        assertThat(gh["login"].isNull).isTrue()
    }

    @Test
    fun `the text gh prints is parsed for the code, the link, the account and the scopes`() {
        val out = "! First copy your one-time code: 1A2B-3C4D\nOpen this URL to continue in your web browser: https://ghe.example.com/login/device\n"
        assertThat(GitHubLoginService.parseCode(out)).isEqualTo("1A2B-3C4D")
        assertThat(GitHubLoginService.parseUrl(out)).isEqualTo("https://ghe.example.com/login/device")
        val who = GitHubLoginService.parseStatus("ghe.example.com\n  ✓ Logged in to ghe.example.com account some-one (/x)\n  - Token scopes: 'repo', 'workflow'\n", "ghe.example.com", "gh")
        assertThat(who.login).isEqualTo("some-one")
        assertThat(who.scopes).containsExactly("repo", "workflow")
    }

    @Test
    fun `without gh and without a client id the sign-in says what to set`() {
        val service = GitHubLoginService(mock(SecretService::class.java), ObjectMapper(), false, "/nonexistent/gh", "", "")
        assertThatThrownBy { service.start("github.com") }.isInstanceOf(Conflict::class.java).hasMessageContaining("gh CLI")
    }

    @Test
    fun `without gh the OAuth device flow runs with the company's client id`() {
        val seen = mutableListOf<String>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        fun reply(path: String, json: String) = server.createContext(path) { ex ->
            seen += ex.requestURI.path + " " + ex.requestBody.readBytes().toString(Charsets.UTF_8)
            val b = json.toByteArray()
            ex.responseHeaders.add("Content-Type", "application/json")
            ex.sendResponseHeaders(200, b.size.toLong())
            ex.responseBody.use { it.write(b) }
        }
        reply("/login/device/code", """{"device_code":"dc-1","user_code":"WXYZ-1234","verification_uri":"https://ghe.example.com/login/device","interval":1,"expires_in":60}""")
        reply("/login/oauth/access_token", """{"access_token":"gho_oauthoauthoauthoauthoauth9876","scope":"repo,workflow","token_type":"bearer"}""")
        reply("/api/v3/user", """{"login":"oauth-dev"}""")
        server.start()
        try {
            val secrets = mock(SecretService::class.java)
            val service = GitHubLoginService(secrets, ObjectMapper(), false, "/nonexistent/gh", "Iv1.company", "http://127.0.0.1:${server.address.port}")
            val v = service.start("ghe.example.com")
            assertThat(v.code).isEqualTo("WXYZ-1234")
            assertThat(v.url).isEqualTo("https://ghe.example.com/login/device")
            assertThat(seen.first()).contains("client_id=Iv1.company")
            var done = service.get(v.id)
            repeat(100) { if (done.status == "waiting") { Thread.sleep(100); done = service.get(v.id) } }
            assertThat(done.status).isEqualTo("done")
            assertThat(done.login).isEqualTo("oauth-dev")
            assertThat(done.scopes).containsExactly("repo", "workflow")
            assertThat(done.toString()).doesNotContain("gho_oauth")
            val puts = org.mockito.Mockito.mockingDetails(secrets).invocations.filter { it.method.name == "put" }.map { it.arguments[0] to it.arguments[1] }
            assertThat(puts).contains("GITHUB_REPO_TOKEN" to "gho_oauthoauthoauthoauthoauth9876")
            assertThat(puts.map { it.first }).contains("GITHUB_REPO_INFO")
        } finally {
            server.stop(0)
        }
    }
}
