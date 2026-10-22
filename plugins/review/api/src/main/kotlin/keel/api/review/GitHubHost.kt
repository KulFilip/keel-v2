package keel.api.review

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import keel.api.common.RestClients
import org.springframework.http.MediaType
import org.springframework.web.client.ResourceAccessException
import org.springframework.web.client.RestClient
import org.springframework.web.client.RestClientResponseException
import java.net.URI
import java.net.URLEncoder
import java.time.Duration
import java.util.Base64

/**
 * GitHub (github.com or an Enterprise server) for the review window: REST for pull requests, reviews and comments,
 * GraphQL for review threads (only GraphQL knows a thread and can resolve it). [apiBase] overrides the API root (tests).
 */
class GitHubHost(override val ref: HostRef, private val token: String, private val mapper: ObjectMapper, apiBase: String = "") : CodeHost {

    private val root: String = apiBase.trim().trimEnd('/').ifBlank {
        if (ref.host == "github.com") "https://api.github.com" else "https://${ref.host}/api/v3"
    }
    private val graphql: String = when {
        apiBase.isNotBlank() -> "$root/graphql"
        ref.host == "github.com" -> "https://api.github.com/graphql"
        else -> "https://${ref.host}/api/graphql"
    }
    private val owner = ref.path.substringBefore('/')
    private val name = ref.path.substringAfter('/')
    private val repo = "$root/repos/${enc(owner)}/${enc(name)}"

    private val notes = java.util.Collections.synchronizedList(mutableListOf<String>())
    override fun takeNotes(): List<String> = synchronized(notes) { notes.toList().also { notes.clear() } }
    private fun note(text: String) { synchronized(notes) { if (text !in notes) notes += text } }
    private val ownHost = Paging.sameHost(root)

    private val rest: RestClient by lazy {
        RestClients.builder(Duration.ofSeconds(8), Duration.ofSeconds(30))
            .defaultHeader("Authorization", "Bearer $token")
            .defaultHeader("Accept", "application/vnd.github+json")
            .defaultHeader("X-GitHub-Api-Version", "2022-11-28")
            .build()
    }

    override fun me(): String = get("$root/user", "your GitHub user").path("login").asText().ifBlank {
        throw HostException("GitHub did not say who the token belongs to.")
    }

    override fun list(me: String): List<PrSummary> {
        val all = getAll("$repo/pulls?state=open&sort=updated&direction=desc&per_page=100", "the pull requests")
        if (all.truncated) note("Only the ${all.items.size} most recently updated open pull requests are listed; the counts cover those.")
        return all.items.map { summary(it, me) }
    }

    override fun forBranch(branch: String, me: String): PrSummary? =
        get("$repo/pulls?state=open&head=${enc("$owner:$branch")}&per_page=5", "the pull request of $branch").firstOrNull()?.let { summary(it, me) }

    private fun summary(p: JsonNode, me: String) = PrSummary(
        number = p.path("number").asInt(),
        title = p.path("title").asText(),
        author = p.path("user").path("login").asText(),
        branch = p.path("head").path("ref").asText(),
        base = p.path("base").path("ref").asText(),
        draft = p.path("draft").asBoolean(false),
        updatedAt = p.path("updated_at").asText(),
        url = p.path("html_url").asText(),
        reviewRequested = p.path("requested_reviewers").any { it.path("login").asText().equals(me, true) },
        mine = p.path("user").path("login").asText().equals(me, true),
        headSha = p.path("head").path("sha").asText(null),
        assigned = p.path("assignees").any { it.path("login").asText().equals(me, true) },
    )

    override fun pr(number: Int): PrDetail {
        val p = get("$repo/pulls/$number", "pull request #$number")
        val headRepo = p.path("head").path("repo").path("full_name").asText("")
        return PrDetail(
            number = number,
            title = p.path("title").asText(),
            author = p.path("user").path("login").asText(),
            body = p.path("body").asText(""),
            branch = p.path("head").path("ref").asText(),
            base = p.path("base").path("ref").asText(),
            headSha = p.path("head").path("sha").asText(),
            state = if (p.path("merged").asBoolean(false)) "merged" else p.path("state").asText(),
            draft = p.path("draft").asBoolean(false),
            url = p.path("html_url").asText(),
            sameRepo = headRepo.equals(ref.path, true),
            mergeable = p.path("mergeable").takeIf { it.isBoolean }?.asBoolean(),
            mergeState = p.path("mergeable_state").asText(null),
        )
    }

    override fun checks(pr: PrDetail): List<CheckRun> {
        // an error is an error ("keel could not read the checks"), never "no checks"
        val runs = getAll("$repo/commits/${pr.headSha}/check-runs?per_page=100", "the checks") { it.path("check_runs") }
        val out = runs.items.map { c ->
            CheckRun(c.path("name").asText(), (c.path("conclusion").asText("").ifBlank { c.path("status").asText("pending") }).lowercase(),
                c.path("html_url").asText(null))
        }
        val status = getAll("$repo/commits/${pr.headSha}/status?per_page=100", "the commit status") { it.path("statuses") }
        val more = status.items.map { s -> CheckRun(s.path("context").asText(), s.path("state").asText().lowercase(), s.path("target_url").asText(null)) }
        if (runs.truncated || status.truncated) note("Only the first ${Paging.MAX_PAGES * 100} checks are listed.")
        return out + more
    }

    override fun decisions(number: Int): Decisions {
        val latest = linkedMapOf<String, String>()
        // oldest first, the latest state of a person counts: when the list is cut, the newest reviews are the ones kept
        val reviews = getAll("$repo/pulls/$number/reviews?per_page=100", "the reviews", newest = true)
        if (reviews.truncated) note("Only the newest ${reviews.items.size} reviews were read, so an older approval may be missing.")
        for (r in reviews.items) {
            val state = r.path("state").asText()
            if (state == "APPROVED" || state == "CHANGES_REQUESTED" || state == "DISMISSED") latest[r.path("user").path("login").asText()] = state
        }
        return Decisions(latest.filterValues { it == "APPROVED" }.keys.toList(), latest.filterValues { it == "CHANGES_REQUESTED" }.keys.toList())
    }

    override fun threads(number: Int): List<ReviewThread> {
        val nodes = mutableListOf<JsonNode>()
        var cursor: String? = null
        var pages = 0
        do {
            if (pages >= Paging.MAX_PAGES) {
                note("Only the first ${nodes.size} review threads are shown.")
                break
            }
            val d = graph(THREADS, mapOf("o" to owner, "r" to name, "n" to number, "c" to cursor), "the review threads")
            val rt = d.path("repository").path("pullRequest").path("reviewThreads")
            rt.path("nodes").forEach { nodes.add(it) }
            pages++
            cursor = nextCursor(rt)
        } while (cursor != null)
        return nodes.map { t ->
            val first = t.path("comments")
            val raw = first.path("nodes").toMutableList()
            var after = nextCursor(first)
            var more = 0
            while (after != null && more < Paging.MAX_PAGES) {
                val c = graph(THREAD_COMMENTS, mapOf("id" to t.path("id").asText(), "c" to after), "the comments of a thread")
                    .path("node").path("comments")
                raw.addAll(c.path("nodes").toList())
                after = nextCursor(c)
                more++
            }
            if (after != null) note("A thread has more comments than keel reads (${raw.size}).")
            val comments = raw.map { c ->
                ReviewComment(c.path("databaseId").asText(), c.path("author").path("login").asText("ghost"), c.path("body").asText(),
                    c.path("createdAt").asText(), c.path("url").asText(null))
            }
            // an outdated thread has no line in the current diff (line is null); originalLine is where it was, for the
            // list. The thread says outdated: the diff does not draw it at that line.
            val line = t.path("line").takeIf { it.isInt }?.asInt() ?: t.path("originalLine").takeIf { it.isInt }?.asInt()
            ReviewThread(t.path("id").asText(), t.path("path").asText(null), line, t.path("diffSide").asText("RIGHT"),
                t.path("isResolved").asBoolean(), t.path("isOutdated").asBoolean(), comments, comments.firstOrNull()?.id)
        }
    }

    private fun nextCursor(connection: JsonNode): String? =
        if (connection.path("pageInfo").path("hasNextPage").asBoolean(false)) connection.path("pageInfo").path("endCursor").asText(null) else null

    override fun conversation(number: Int): List<ReviewComment> {
        // oldest first: when the list is cut, the newest comments are the ones kept
        val all = getAll("$repo/issues/$number/comments?per_page=100", "the conversation", newest = true)
        if (all.truncated) note("Only the newest ${all.items.size} conversation comments are shown; the oldest are left out.")
        return all.items.map { c ->
            ReviewComment(c.path("id").asText(), c.path("user").path("login").asText(), c.path("body").asText(), c.path("created_at").asText(),
                c.path("html_url").asText(null))
        }
    }

    override fun reply(number: Int, thread: ReviewThread, body: String) {
        val to = thread.replyTo ?: throw HostException("This thread has no comment to reply to.", status = 409)
        post("$repo/pulls/$number/comments/$to/replies", mapOf("body" to body), "your reply")
    }

    override fun resolve(number: Int, thread: ReviewThread, resolved: Boolean) {
        val op = if (resolved) "resolveReviewThread" else "unresolveReviewThread"
        graph("mutation(${'$'}id: ID!) { $op(input: {threadId: ${'$'}id}) { thread { id isResolved } } }", mapOf("id" to thread.id),
            if (resolved) "resolving the thread" else "opening the thread again")
    }

    override fun submit(pr: PrDetail, event: String, body: String, comments: List<OutComment>, onPosted: (OutComment?) -> Unit): String? {
        val out = post("$repo/pulls/${pr.number}/reviews", mapOf(
            "commit_id" to pr.headSha,
            "event" to event,
            "body" to body,
            "comments" to comments.map { mapOf("path" to it.path, "line" to it.line, "side" to it.side, "body" to it.body) },
        ).filterValues { it != "" }, "your review")
        return out.path("html_url").asText(null)
    }

    override fun merge(pr: PrDetail, method: String, deleteBranch: Boolean): String {
        val out = call("merging #${pr.number}") {
            rest.put().uri(URI.create("$repo/pulls/${pr.number}/merge")).contentType(MediaType.APPLICATION_JSON)
                .body(mapper.valueToTree<JsonNode>(mapOf("merge_method" to method, "sha" to pr.headSha)))
                .retrieve().body(JsonNode::class.java) ?: mapper.createObjectNode()
        }
        if (!out.path("merged").asBoolean(false)) throw HostException("GitHub did not merge #${pr.number}: ${out.path("message").asText()}", status = 409)
        if (deleteBranch && pr.sameRepo) {
            runCatching {
                rest.delete().uri(URI.create("$repo/git/refs/heads/${pr.branch.split('/').joinToString("/") { enc(it) }}")).retrieve().toBodilessEntity()
            }
        }
        return out.path("message").asText("Merged")
    }

    override fun fetchUrl(): String = "https://${ref.host}/${ref.path}.git"

    override fun authHeader(): String =
        "AUTHORIZATION: basic " + Base64.getEncoder().encodeToString("x-access-token:$token".toByteArray())

    override fun headRef(number: Int) = "refs/pull/$number/head"

    // ---- http

    private fun getAll(url: String, what: String, newest: Boolean = false, items: (JsonNode) -> JsonNode = { it }): Paged =
        Paging.all(url, newest, ownHost, items) { u ->
            call(what) { rest.get().uri(URI.create(u)).retrieve().toEntity(JsonNode::class.java) }
        }

    private fun get(url: String, what: String): JsonNode = call(what) {
        rest.get().uri(URI.create(url)).retrieve().body(JsonNode::class.java) ?: mapper.createObjectNode()
    }

    private fun post(url: String, body: Any, what: String): JsonNode = call(what) {
        rest.post().uri(URI.create(url)).contentType(MediaType.APPLICATION_JSON).body(mapper.valueToTree<JsonNode>(body))
            .retrieve().body(JsonNode::class.java) ?: mapper.createObjectNode()
    }

    private fun graph(query: String, vars: Map<String, Any?>, what: String): JsonNode {
        val out = post(graphql, mapOf("query" to query, "variables" to vars), what)
        val errors = out.path("errors")
        if (errors.isArray && errors.size() > 0) {
            throw HostException("GitHub could not read $what: ${errors[0].path("message").asText().take(200)}")
        }
        return out.path("data")
    }

    private fun <T> call(what: String, block: () -> T): T = try {
        block()
    } catch (e: RestClientResponseException) {
        val msg = runCatching { mapper.readTree(e.responseBodyAsString).path("message").asText() }.getOrNull().orEmpty()
        val clean = msg.replace(token, "***").take(200)
        val limited = e.statusCode.value() == 429 ||
            (e.statusCode.value() == 403 && (e.responseHeaders?.getFirst("X-RateLimit-Remaining") == "0" || msg.contains("rate limit", true)))
        if (limited) {
            val at = e.responseHeaders?.let { Paging.resetTime(it, "X-RateLimit-Reset") }
            throw HostException("GitHub is rate limiting this token ($what).", if (at != null) "Rate limited, try again at $at." else "Rate limited, try again in a few minutes.", 429)
        }
        when (e.statusCode.value()) {
            401 -> throw HostException("GitHub refused the token ($what).", "Check the GitHub token in Connections.", 409)
            403 -> throw HostException("GitHub did not allow $what: $clean", "The token needs repo access (and pull request write access to comment).", 409)
            404 -> throw HostException("GitHub did not find $what.", "Check that the token can see ${ref.path}.", 404)
            405 -> throw HostException("GitHub did not allow $what: $clean", "It is not mergeable yet: checks, reviews or conflicts.", 409)
            422 -> throw HostException("GitHub did not accept $what: $clean", status = 409)
            else -> throw HostException("GitHub answered ${e.statusCode.value()} for $what: $clean")
        }
    } catch (e: ResourceAccessException) {
        throw HostException("Could not reach GitHub at ${URI.create(root).host} for $what.", "Check the network of keel's container.")
    }

    companion object {
        private const val COMMENT_FIELDS = "id databaseId body createdAt url author { login }"
        private const val PAGE_INFO = "pageInfo { hasNextPage endCursor }"
        val THREADS = """
            query(${'$'}o: String!, ${'$'}r: String!, ${'$'}n: Int!, ${'$'}c: String) {
              repository(owner: ${'$'}o, name: ${'$'}r) { pullRequest(number: ${'$'}n) { reviewThreads(first: 100, after: ${'$'}c) { $PAGE_INFO nodes {
                id isResolved isOutdated path line originalLine diffSide
                comments(first: 100) { $PAGE_INFO nodes { $COMMENT_FIELDS } }
              } } } }
            }
        """.trimIndent()
        val THREAD_COMMENTS = """
            query(${'$'}id: ID!, ${'$'}c: String) {
              node(id: ${'$'}id) { ... on PullRequestReviewThread { comments(first: 100, after: ${'$'}c) { $PAGE_INFO nodes { $COMMENT_FIELDS } } } }
            }
        """.trimIndent()
    }

    private fun enc(s: String) = URLEncoder.encode(s, Charsets.UTF_8).replace("+", "%20")
}
