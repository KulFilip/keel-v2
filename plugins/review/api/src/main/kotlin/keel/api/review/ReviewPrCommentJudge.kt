package keel.api.review

import keel.api.common.BadRequest
import keel.api.common.Conflict
import keel.api.flow.PrCommentJudge
import keel.api.flow.PrCommentVerdict
import keel.api.flow.PrThread
import keel.api.flow.PrThreads
import org.springframework.stereotype.Service

/**
 * 0.18.52 the Tasks plugin's automations read a KeelBot-owned ticket's PR through Code Review: its threads
 * ([ReviewService.view]), the cheap "Is the reviewer right?" check of one ([ReviewJudgeService.judge], cached per
 * thread, last comment and head commit, so a comment is never checked twice), a reply, and "Address it".
 */
@Service
class ReviewPrCommentJudge(
    private val reviews: ReviewService,
    private val judge: ReviewJudgeService,
    private val ai: ReviewAiService,
    private val addressing: ReviewAddressService,
) : PrCommentJudge {

    /** How long [check] waits for the model (the judge runs on its own worker outside tests). */
    @Volatile var waitMs: Long = 200_000

    companion object {
        private val NUMBER = Regex("/(?:pull|merge_requests)/(\\d{1,9})(?:[/?#].*)?$")

        fun keyOf(prUrl: String): String =
            NUMBER.find(prUrl.trim())?.groupValues?.get(1)?.let { "pr:$it" } ?: throw BadRequest("\"${prUrl.take(200)}\" is not a pull request link")

        /** The strongest verdict of the items: a reviewer who is right (even partly) wins over "the code is fine". */
        fun summary(items: List<Map<String, Any?>>): String? {
            val v = items.mapNotNull { it["verdict"]?.toString() }
            return when {
                v.isEmpty() -> null
                "reviewer_right" in v -> "reviewer_right"
                "partly" in v -> "partly"
                v.all { it == "author_right" } -> "author_right"
                else -> "unclear"
            }
        }
    }

    override fun threads(pid: String, prUrl: String): PrThreads {
        val v = reviews.view(pid, keyOf(prUrl))
        return PrThreads(v.author, v.headSha, v.threads.filter { it.comments.isNotEmpty() && !it.pending }.map { t ->
            val last = t.comments.last()
            PrThread(t.id, t.path, t.line, t.resolved, last.id, last.author, last.body, last.url)
        })
    }

    override fun check(pid: String, prUrl: String, threadId: String): PrCommentVerdict {
        val key = keyOf(prUrl)
        try {
            judge.judge(pid, key, threadId, JudgeBody(key = key))
        } catch (e: Conflict) {
            if (e.message?.contains("already checking") != true) return PrCommentVerdict(null, error = e.message)
        }
        val kind = ReviewAiService.JUDGE + threadId
        val until = System.currentTimeMillis() + waitMs
        var run = ai.latest(pid, key, kind, null)
        while (run?.status == "running" && System.currentTimeMillis() < until) {
            Thread.sleep(500)
            run = ai.latest(pid, key, kind, null)
        }
        val r = run ?: return PrCommentVerdict(null, error = "the check did not run")
        if (r.result?.path("stage")?.asText() == "flow") return PrCommentVerdict(null, flow = r.result.path("workflow").asText("review").ifBlank { "review" })
        if (r.status == "running") return PrCommentVerdict(null, error = "the check takes too long")
        if (r.status != "done") return PrCommentVerdict(null, error = r.error ?: "the check failed")
        val items = r.result?.path("items")?.map { i ->
            mapOf("claim" to i.path("claim").asText(""), "verdict" to i.path("verdict").asText(""), "why" to i.path("why").asText(""))
        }.orEmpty()
        val first = items.firstOrNull()
        val why = first?.let { "${it["claim"]}: ${it["why"]}".trim(':', ' ') }.orEmpty()
        return PrCommentVerdict(summary(items), why.take(600), r.result?.path("reply")?.asText("").orEmpty())
    }

    override fun reply(pid: String, prUrl: String, threadId: String, body: String) {
        reviews.reply(pid, threadId, ReplyBody(keyOf(prUrl), body))
    }

    override fun address(pid: String, prUrl: String, threadId: String): String {
        val key = keyOf(prUrl)
        return addressing.address(pid, key, threadId, AddressBody(key)).flowId
    }
}
