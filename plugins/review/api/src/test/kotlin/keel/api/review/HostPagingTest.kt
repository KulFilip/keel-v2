package keel.api.review

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.net.InetSocketAddress

/** The hosts read every page (up to a maximum and then say so), surface errors, and map rate limits. No Spring: a tiny server. */
class HostPagingTest {
    private val mapper = jacksonObjectMapper()
    private class Reply(val code: Int, val body: String, val headers: Map<String, String> = emptyMap())
    private var handler: (method: String, path: String, query: String, body: String) -> Reply = { _, _, _, _ -> Reply(404, "{}") }
    private val calls = java.util.concurrent.CopyOnWriteArrayList<String>()
    private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { s ->
        s.createContext("/") { ex: HttpExchange ->
            val body = ex.requestBody.readAllBytes().toString(Charsets.UTF_8)
            calls += "${ex.requestMethod} ${ex.requestURI}"
            val r = handler(ex.requestMethod, ex.requestURI.rawPath, ex.requestURI.rawQuery.orEmpty(), body)
            ex.responseHeaders.add("Content-Type", "application/json")
            r.headers.forEach { (k, v) -> ex.responseHeaders.add(k, v) }
            val bytes = r.body.toByteArray()
            ex.sendResponseHeaders(r.code, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        s.start()
    }
    private val url get() = "http://127.0.0.1:${server.address.port}"

    @AfterEach
    fun stop() = server.stop(0)

    private val ghRef = HostRef("github", "github.com", "acme/app", "https://github.com/acme/app")
    private val glRef = HostRef("gitlab", "gitlab.example.com", "grp/app", "https://gitlab.example.com/grp/app")
    private fun gh() = GitHubHost(ghRef, "tok", mapper, url)
    private fun gl() = GitLabHost(glRef, "tok", mapper, url)

    private fun failure(block: () -> Unit): HostException =
        try { block(); throw AssertionError("expected a HostException") } catch (e: HostException) { e }

    private fun page(query: String) = Regex("(?:^|&)page=(\\d+)").find(query)?.groupValues?.get(1)?.toInt() ?: 1

    /** `pages` pages of `per` items made by `item(page, i)`, linked by Link headers like GitHub's. */
    private fun paged(path: String, query: String, pages: Int, per: Int, item: (Int, Int) -> String, wrap: (String) -> String = { it }): Reply {
        val p = page(query)
        val links = mutableListOf<String>()
        if (p < pages) {
            links += "<$url$path?per_page=100&page=${p + 1}>; rel=\"next\""
            links += "<$url$path?per_page=100&page=$pages>; rel=\"last\""
        }
        return Reply(200, wrap((1..per).joinToString(",", "[", "]") { item(p, it) }), if (links.isEmpty()) emptyMap() else mapOf("Link" to links.joinToString(", ")))
    }

    private fun pr(n: Int) = """{"number":$n,"title":"t$n","user":{"login":"a"},"head":{"ref":"b$n","sha":"s"},"base":{"ref":"main"},"updated_at":"x","html_url":"u"}"""

    @Test
    fun `GitHub pull requests are read page after page`() {
        handler = { _, path, q, _ -> paged(path, q, 3, 100, { p, i -> pr(p * 1000 + i) }) }
        val prs = gh().list("me")
        assertThat(prs).hasSize(300)
        assertThat(gh().takeNotes()).isEmpty()
    }

    @Test
    fun `a list longer than the maximum is cut and the host says so`() {
        handler = { _, path, q, _ -> paged(path, q, 30, 100, { p, i -> pr(p * 1000 + i) }) }
        val h = gh()
        assertThat(h.list("me")).hasSize(Paging.MAX_PAGES * 100)
        assertThat(h.takeNotes().single()).contains("1000").contains("pull requests")
    }

    @Test
    fun `the conversation keeps the newest comments when it is cut`() {
        handler = { _, path, q, _ ->
            paged(path, q, 14, 100, { p, i -> """{"id":${p * 1000 + i},"user":{"login":"a"},"body":"b","created_at":"x","html_url":"u"}""" })
        }
        val h = gh()
        val c = h.conversation(7)
        assertThat(c).hasSize(Paging.MAX_PAGES * 100)
        assertThat(c.last().id).isEqualTo((14 * 1000 + 100).toString())       // the newest is there
        assertThat(c.first().id).isEqualTo((5 * 1000 + 1).toString())         // pages 1-4, the oldest, are left out
        assertThat(h.takeNotes().single()).contains("newest")
    }

    @Test
    fun `a failing checks call is an error, not no checks`() {
        handler = { _, path, _, _ -> if (path.endsWith("/check-runs")) Reply(500, """{"message":"boom"}""") else Reply(200, """{"statuses":[]}""") }
        val pr = PrDetail(1, "t", "a", "", "b", "main", "abc", "open", false, "u", true)
        assertThatThrownBy { gh().checks(pr) }.isInstanceOf(HostException::class.java).hasMessageContaining("500")
    }

    @Test
    fun `GitHub rate limits say when to try again, not that the token needs repo access`() {
        handler = { _, _, _, _ -> Reply(403, """{"message":"API rate limit exceeded"}""", mapOf("X-RateLimit-Remaining" to "0", "X-RateLimit-Reset" to "1893456000")) }
        assertThat(failure { gh().list("me") }.hint).contains("Rate limited, try again at 2030-01-01 00:00 UTC")
        handler = { _, _, _, _ -> Reply(429, "{}", mapOf("Retry-After" to "60")) }
        assertThat(failure { gh().list("me") }.hint).startsWith("Rate limited, try again at")
    }

    @Test
    fun `review threads follow the cursor to the next page`() {
        fun node(id: String) = """{"id":"$id","isResolved":false,"isOutdated":false,"path":"a.kt","line":3,"originalLine":3,"diffSide":"RIGHT",
            "comments":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"id":"c","databaseId":1,"body":"x","createdAt":"t","url":"u","author":{"login":"a"}}]}}"""
        handler = { _, _, _, body ->
            val cursor = mapper.readTree(body).path("variables").path("c").asText(null)
            val more = cursor == null
            Reply(200, """{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":$more,"endCursor":"c1"},
                "nodes":[${node(if (more) "T1" else "T2")}]}}}}}""")
        }
        assertThat(gh().threads(5).map { it.id }).containsExactly("T1", "T2")
    }

    @Test
    fun `GitLab merge requests and jobs are paged, and an outdated discussion is told from its position`() {
        handler = { _, path, q, _ ->
            when {
                path.endsWith("/merge_requests/3") -> Reply(200, """{"diff_refs":{"head_sha":"new","base_sha":"b","start_sha":"s"}}""")
                path.endsWith("/discussions") -> Reply(200, """[
                  {"id":"d1","notes":[{"id":1,"author":{"username":"a"},"body":"x","created_at":"t","position":{"new_line":4,"new_path":"a.kt","head_sha":"old"}}]},
                  {"id":"d2","notes":[{"id":2,"author":{"username":"a"},"body":"y","created_at":"t","position":{"new_line":9,"new_path":"a.kt","head_sha":"new"}}]}]""")
                else -> paged(path, q, 2, 100, { p, i -> """{"iid":${p * 1000 + i},"title":"t","author":{"username":"a"},"source_branch":"s","target_branch":"m","updated_at":"x","web_url":"u"}""" })
            }
        }
        val h = gl()
        assertThat(h.list("me")).hasSize(200)
        val t = h.threads(3).associateBy { it.id }
        assertThat(t["d1"]!!.outdated).isTrue()
        assertThat(t["d2"]!!.outdated).isFalse()
    }

    @Test
    fun `a GitLab review that fails in the middle tells which comments went out, and each one is reported`() {
        var posts = 0
        handler = { m, path, _, _ ->
            when {
                m == "GET" -> Reply(200, """{"diff_refs":{"head_sha":"h","base_sha":"b","start_sha":"s"}}""")
                path.endsWith("/discussions") && ++posts == 2 -> Reply(500, """{"message":"boom"}""")
                else -> Reply(201, "{}")
            }
        }
        val sent = mutableListOf<String?>()
        val comments = listOf(OutComment("a.kt", 1, "RIGHT", "one", "d1"), OutComment("a.kt", 2, "RIGHT", "two", "d2"))
        val pr = PrDetail(3, "t", "a", "", "b", "main", "abc", "open", false, "https://x/3", true)
        assertThat(failure { gl().submit(pr, "COMMENT", "", comments) { sent += it?.draftId } }.hint).contains("1 of 2")
        assertThat(sent).containsExactly("d1")
    }

    @Test
    fun `a remote on a port keeps it for https and drops it for ssh`() {
        assertThat(ReviewGit.parseRemote("https://gitlab.corp:8443/grp/app.git")).isEqualTo("gitlab.corp:8443" to "grp/app")
        assertThat(ReviewGit.parseRemote("ssh://git@gitlab.corp:2222/grp/app.git")).isEqualTo("gitlab.corp" to "grp/app")
        assertThat(ReviewGit.parseRemote("git@github.com:acme/app.git")).isEqualTo("github.com" to "acme/app")
        assertThat(ReviewGit.parseRemote("https://github.com/acme/app")).isEqualTo("github.com" to "acme/app")
    }
}
