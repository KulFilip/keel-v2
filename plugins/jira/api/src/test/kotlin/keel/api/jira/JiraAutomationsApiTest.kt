package keel.api.jira

import com.fasterxml.jackson.databind.JsonNode
import keel.api.flow.PrCommentJudge
import keel.api.flow.PrCommentVerdict
import keel.api.flow.PrThread
import keel.api.flow.PrThreads
import keel.api.support.ApiTest
import keel.api.support.StubJira
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * 0.18.52 task automations with Jira (docs/plans/task-automations.md): a move made in Jira gets one proposal, keel's
 * own move none; Start runs the picked flow; a "start by itself" rule; a review proposal for the PR; a KeelBot-owned
 * ticket's new PR comment is checked once, noted in Jira and asked in the Inbox; approved moves the ticket.
 */
class JiraAutomationsApiTest : ApiTest() {

    /** The Code Review plugin's part, faked: the PR's threads, the cheap check, replies and "Address it". */
    object FakeJudge : PrCommentJudge {
        var author: String? = "dev1"
        val threads = CopyOnWriteArrayList<PrThread>()
        val checks = AtomicInteger()
        val replies = CopyOnWriteArrayList<Pair<String, String>>()
        val addressed = CopyOnWriteArrayList<String>()

        fun reset() {
            author = "dev1"; threads.clear(); checks.set(0); replies.clear(); addressed.clear()
        }

        override fun threads(pid: String, prUrl: String) = PrThreads(author, "abc123", threads.toList())
        override fun check(pid: String, prUrl: String, threadId: String): PrCommentVerdict {
            checks.incrementAndGet()
            return PrCommentVerdict("reviewer_right", "The empty cart is not handled: it returns null.", "Good catch, I will handle the empty cart.")
        }
        override fun reply(pid: String, prUrl: String, threadId: String, body: String) {
            replies += threadId to body
        }
        override fun address(pid: String, prUrl: String, threadId: String): String {
            addressed += threadId
            return "t-address-1"
        }
    }

    @TestConfiguration
    class FakeJudgeConfig {
        @Bean
        fun fakeJudge(): PrCommentJudge = FakeJudge
    }

    companion object {
        val cloud: StubJira = StubJira.start("cloud")
        const val PR = "https://github.com/acme/app/pull/7"
    }

    private val picks = CopyOnWriteArrayList<JsonNode>()

    private fun pickAnswer(workflow: String, questions: List<Map<String, Any?>> = emptyList()) {
        engine.extraRoutes["/tasks/pick"] = { body ->
            picks.add(body!!)
            200 to mapOf("ok" to true, "fake" to false, "tokens_in" to 500, "tokens_out" to 80, "pick" to mapOf(
                "workflow" to workflow, "why" to "New behaviour on the cart page.", "title" to "Empty cart",
                "request" to "Make the empty cart work.", "questions" to questions, "settings" to emptyMap<String, Any>(), "fallback" to false))
        }
    }

    @AfterEach
    fun clean() {
        engine.extraRoutes.remove("/tasks/pick")
        engine.extraTemplates.removeIf { it["id"] == "review-pr" }
        picks.clear()
        FakeJudge.reset()
        github.reset()
        delete("/api/secrets/GITHUB_TOKEN")
    }

    private fun ev(type: String, pid: String, tid: String, step: String? = null, data: Map<String, Any?> = emptyMap()) =
        mapOf("type" to type, "thread_id" to tid, "project_id" to pid, "step" to step, "at" to "2026-10-25T10:00:00Z", "data" to data)

    private fun send(vararg events: Map<String, Any?>) =
        post("/internal/events", events.toList(), mapOf("X-Keel-Token" to TOKEN)).andExpect(status().isOk)

    private fun task(id: String): JsonNode = get("/api/tasks/$id").andExpect(status().isOk).json()
    private fun notes(t: JsonNode) = t["events"].map { it["note"]?.asText().orEmpty() }
    private fun items(pid: String, kind: String) = get("/api/inbox?project=$pid").json()["items"].filter { it["kind"].asText() == kind }
    private fun sync(pid: String) = post("/api/projects/$pid/tasks/sync").andExpect(status().isOk).json()

    /** A project connected to the stub Jira, with a real (not fake) model so keel asks the engine for its pick. */
    private fun project(name: String, extra: Map<String, Any?> = emptyMap()): String {
        cloud.reset()
        val (pid, _) = newProject(name)
        put("/api/projects/$pid/jira", mapOf("kind" to "cloud", "base_url" to cloud.url, "email" to cloud.email, "token" to cloud.token,
            "project_key" to "SHOPS") + extra).andExpect(status().isOk)
        put("/api/projects/$pid/settings", mapOf("default_model" to mapOf("provider" to "claude", "mode" to "subscription", "model" to "sonnet")))
            .andExpect(status().isOk)
        return pid
    }

    @Test
    fun `a ticket moved in Jira gets one proposal, Start runs the picked flow, and keel's own move proposes nothing`() {
        val pid = project("auto-propose")
        pickAnswer("feature", listOf(mapOf("id" to "q1", "question" to "Mobile too?", "options" to listOf("yes", "no"))))
        cloud.add("SHOPS-1234", "Empty cart crashes", "To Do", "Story", "The cart page crashes when the basket is empty.")
        assertThat(sync(pid)["created"].asInt()).isEqualTo(1)
        assertThat(items(pid, "task-proposal")).isEmpty()                      // a new import is not a move
        val id = get("/api/projects/$pid/tasks").json()["tasks"].single()["id"].asText()

        // someone moves the ticket in Jira
        cloud.issues.getValue("SHOPS-1234").status = "In Progress"
        sync(pid)
        assertThat(task(id)["status"].asText()).isEqualTo("in_progress")
        val p = items(pid, "task-proposal").single()
        assertThat(p["title"].asText()).isEqualTo("I want to run the feature flow on SHOPS-1234")
        assertThat(p["detail"].asText()).contains("New behaviour on the cart page.").contains("1 question(s) first")
        assertThat(p["payload"]["workflow_id"].asText()).isEqualTo("feature")
        assertThat(p["questions"].single()["question"].asText()).isEqualTo("Mobile too?")
        assertThat(p["task"]["actions"].map { it["id"].asText() }).containsExactly("start", "other", "later")
        val sent = picks.single()
        assertThat(sent["kind"].asText()).isEqualTo("flow")
        assertThat(sent["ticket"]["key"].asText()).isEqualTo("SHOPS-1234")
        assertThat(sent["ticket"]["description"].asText()).contains("basket is empty")
        assertThat(sent["workflows"].map { it["id"].asText() }).contains("feature").doesNotContain("knowledge-refresh")
        assertThat(notes(task(id))).anyMatch { it.contains("Jira moved SHOPS-1234 to In Progress: keel proposes the feature flow") }

        // the next sync sees no new move: no second proposal, no second pick
        sync(pid)
        assertThat(items(pid, "task-proposal")).hasSize(1)
        assertThat(picks).hasSize(1)

        // Start, with the answer to keel's question
        engine.nextThreadIds += "t-auto-1"
        post("/api/inbox/tasks/${p["task"]["item_id"].asLong()}/act", mapOf("action" to "start", "answers" to mapOf("q1" to "yes"), "allow_dirty" to true))
            .andExpect(status().isOk)
        val started = task(id)
        assertThat(started["thread_id"].asText()).isEqualTo("t-auto-1")
        assertThat(started["workflow_id"].asText()).isEqualTo("feature")
        val body = engine.lastBody("/threads")!!
        assertThat(body["title"].asText()).isEqualTo("SHOPS-1234: Empty cart")
        assertThat(body["request"].asText()).startsWith("Make the empty cart work.").contains("- Mobile too? yes").endsWith("Jira ticket: SHOPS-1234 (${cloud.url}/browse/SHOPS-1234)")
        assertThat(items(pid, "task-proposal")).isEmpty()

        // keel's own move (its flow opened the PR: keel moves the ticket to In Review) comes back as no move at all
        send(ev("step.finished", pid, "t-auto-1", "open", mapOf("note" to "PR opened: $PR")))
        assertThat(cloud.issues.getValue("SHOPS-1234").status).isEqualTo("In Review")
        sync(pid)
        assertThat(task(id)["status"].asText()).isEqualTo("in_review")
        assertThat(items(pid, "task-proposal")).isEmpty()
        assertThat(picks).hasSize(1)
    }

    @Test
    fun `a start-by-itself rule starts the flow, and Review it proposes a read-only review of the PR`() {
        val pid = project("auto-start")
        pickAnswer("feature")
        val saved = put("/api/projects/$pid/tasks/automations", mapOf("rules" to mapOf(
            "in_progress" to mapOf("mode" to "start", "run_mode" to "manual", "cap_tokens" to 50_000),
            "in_review" to mapOf("mode" to "propose"),
        ))).andExpect(status().isOk).json()
        assertThat(saved["settings"]["rules"]["in_progress"]["mode"].asText()).isEqualTo("start")
        assertThat(saved["tracker"].asBoolean()).isTrue()
        assertThat(saved["review_watch"].asBoolean()).isTrue()
        put("/api/projects/$pid/tasks/automations", mapOf("rules" to mapOf("done" to mapOf("mode" to "start")))).andExpect(status().isBadRequest)
        put("/api/projects/$pid/tasks/automations", mapOf("rules" to mapOf("in_progress" to mapOf("mode" to "always")))).andExpect(status().isBadRequest)

        cloud.add("SHOPS-1300", "Empty cart crashes", "To Do", "Story", "Crash.")
        sync(pid)
        val id = get("/api/projects/$pid/tasks").json()["tasks"].single()["id"].asText()
        cloud.issues.getValue("SHOPS-1300").status = "In Progress"
        engine.nextThreadIds += "t-auto-2"
        sync(pid)
        val t = task(id)
        assertThat(t["thread_id"].asText()).isEqualTo("t-auto-2")
        assertThat(t["events"].map { it["kind"].asText() }).contains("auto_start")
        assertThat(engine.lastBody("/threads")!!.toString()).contains("manual")
        assertThat(items(pid, "task-proposal")).isEmpty()
        assertThat(get("/api/projects/$pid/tasks/automations").json()["auto_starts_today"].asInt()).isEqualTo(1)

        // In review without a PR link: the card asks for it; Review it needs one
        send(ev("thread.done", pid, "t-auto-2"))
        cloud.issues.getValue("SHOPS-1300").status = "In Review"
        sync(pid)
        assertThat(items(pid, "task-proposal").single()["task"]["actions"].map { it["id"].asText() }).containsExactly("later")
        post("/api/tasks/$id/review").andExpect(status().isConflict)

        // the PR link, then Review it: a review-pr proposal; Start runs it read-only and leaves the status alone
        post("/api/tasks/$id/pr", mapOf("url" to PR)).andExpect(status().isOk)
        engine.extraTemplates += engine.featureTemplate + mapOf("id" to "review-pr", "name" to "review a PR (keel)")
        post("/api/tasks/$id/review").andExpect(status().isOk)
        val r = items(pid, "task-proposal").single()
        assertThat(r["title"].asText()).isEqualTo("I want to review $PR with the review-pr flow on SHOPS-1300")
        engine.nextThreadIds += "t-review-1"
        post("/api/inbox/tasks/${r["task"]["item_id"].asLong()}/act", mapOf("action" to "start")).andExpect(status().isOk)
        val body = engine.lastBody("/threads")!!
        assertThat(body["data"]["pr"].asText()).isEqualTo(PR)
        assertThat(body["request"].asText()).startsWith(PR)
        val after = task(id)
        assertThat(after["status"].asText()).isEqualTo("in_review")
        assertThat(after["thread_id"].asText()).isEqualTo("t-auto-2")              // the task's own flow stays
        send(ev("thread.done", pid, "t-review-1", data = mapOf("summary" to "2 findings, 1 blocking")))
        assertThat(notes(task(id))).contains("The review-pr flow finished: 2 findings, 1 blocking Its result is on the Flow page.")
    }

    @Test
    fun `a KeelBot-owned ticket's new PR comment is checked once, noted in Jira and asked in the Inbox, and approved moves it`() {
        val pid = project("auto-keelbot")
        put("/api/projects/$pid/tasks/automations", mapOf("keelbot" to mapOf("account" to "acc-dev-1"), "rules" to emptyMap<String, Any>()))
            .andExpect(status().isOk)
        put("/api/secrets/GITHUB_TOKEN", mapOf("value" to github.token)).andExpect(status().isOk)
        cloud.add("SHOPS-1400", "Empty cart crashes", "To Do", "Story", "Crash.")
        sync(pid)
        val id = get("/api/projects/$pid/tasks").json()["tasks"].single()["id"].asText()
        assertThat(notes(task(id))).anyMatch { it.startsWith("KeelBot owns SHOPS-1400") }
        // the sync also asked Jira for KeelBot's tickets
        assertThat(cloud.calls.filter { it.path == "/rest/api/3/search/jql" }.map { java.net.URLDecoder.decode(it.query, Charsets.UTF_8) })
            .anyMatch { it.contains("assignee = \"acc-dev-1\"") }

        post("/api/tasks/$id/pr", mapOf("url" to PR)).andExpect(status().isOk)
        FakeJudge.threads += PrThread("th1", "src/cart.kt", 3, false, "c1", "bo", "An old comment.")
        sync(pid)                                                                // the first look: a baseline, no check
        assertThat(FakeJudge.checks.get()).isEqualTo(0)

        // a new reviewer comment, and one by the PR's author (not a review)
        FakeJudge.threads += PrThread("th2", "src/cart.kt", 12, false, "c2", "ana",
            "This returns null for an empty cart. Token ghp_abcdefghijklmnopqrstuvwxyz0123456789 ```val x = 1```") // test fixture, keel:allow-secret
        FakeJudge.threads += PrThread("th3", "src/cart.kt", 20, false, "c3", "dev1", "Fixed, see the new commit.")
        assertThat(sync(pid)["comments_checked"].asInt()).isEqualTo(1)
        assertThat(FakeJudge.checks.get()).isEqualTo(1)
        val jira = cloud.issues.getValue("SHOPS-1400").comments.last()
        assertThat(jira).startsWith("keel: ana commented on the pull request (src/cart.kt:12): \"This returns null for an empty cart.")
            .contains("keel's check: the reviewer is right").contains("Waiting for a decision in keel.")
            .doesNotContain("ghp_abcdefghij").doesNotContain("val x = 1")
        val item = items(pid, "task-review").single()
        assertThat(item["task"]["actions"].map { it["id"].asText() }).containsExactly("reply", "address", "handle")
        assertThat(item["payload"]["reply"].asText()).isEqualTo("Good catch, I will handle the empty cart.")

        // the same comment is never checked twice
        sync(pid)
        assertThat(FakeJudge.checks.get()).isEqualTo(1)
        assertThat(items(pid, "task-review")).hasSize(1)

        post("/api/inbox/tasks/${item["task"]["item_id"].asLong()}/act", mapOf("action" to "reply")).andExpect(status().isOk)
        assertThat(FakeJudge.replies.single()).isEqualTo("th2" to "Good catch, I will handle the empty cart.")
        assertThat(items(pid, "task-review")).isEmpty()

        // all reviews approve: the ticket moves on with the status mapping
        github.reviews["acme/app#7"] = listOf(github.review("ana", "APPROVED"))
        sync(pid)
        assertThat(task(id)["status"].asText()).isEqualTo("testing_pp")
        assertThat(cloud.issues.getValue("SHOPS-1400").status).isEqualTo("Testing in PP")
    }
}
