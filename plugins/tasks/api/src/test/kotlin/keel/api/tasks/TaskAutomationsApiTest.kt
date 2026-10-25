package keel.api.tasks

import com.fasterxml.jackson.databind.JsonNode
import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * 0.18.52 task automations on the Tasks plugin alone (no Jira, no Code Review): the settings, "Pick a flow for me"
 * (the type's default without a model, the engine's pick with one), Use another flow, Not now, and "Review it".
 * The Jira side (a move made in Jira, KeelBot-owned tickets): plugins/jira/api JiraAutomationsApiTest.
 */
class TaskAutomationsApiTest : ApiTest() {

    @AfterEach
    fun clean() {
        engine.extraRoutes.remove("/tasks/pick")
    }

    private fun task(id: String): JsonNode = get("/api/tasks/$id").andExpect(status().isOk).json()
    private fun proposals(pid: String) = get("/api/inbox?project=$pid").json()["items"].filter { it["kind"].asText() == "task-proposal" }
    /** The bell's notifications that point at task [id] and are still unread. */
    private fun unread(id: String) = get("/api/notifications?limit=500").json().filter { it["link"].asText() == "/tasks/$id" && !it["read"].asBoolean() }
    private fun newTask(pid: String, title: String, type: String = "bug") =
        post("/api/projects/$pid/tasks", mapOf("title" to title, "type" to type, "description" to "The cart page crashes.")).andExpect(status().isOk).json()["id"].asText()

    @Test
    fun `the automation settings have defaults and are checked`() {
        val (pid, _) = newProject("auto-settings")
        val v = get("/api/projects/$pid/tasks/automations").andExpect(status().isOk).json()
        assertThat(v["settings"]["rules"]["in_progress"]["mode"].asText()).isEqualTo("propose")
        assertThat(v["settings"]["rules"]["in_review"]["mode"].asText()).isEqualTo("propose")
        assertThat(v["settings"]["allow_reply"].asBoolean()).isFalse()
        assertThat(v["statuses"].map { it.asText() }).containsExactly("in_progress", "in_review", "blocked")
        assertThat(v["tracker"].asBoolean()).isFalse()                        // no Jira plugin here
        assertThat(v["review_watch"].asBoolean()).isFalse()                   // no Code Review plugin here

        val saved = put("/api/projects/$pid/tasks/automations", mapOf("keelbot" to mapOf("account" to "acc-keelbot-1", "label" to "keel"),
            "allow_reply" to true, "daily_auto_starts" to 2)).andExpect(status().isOk).json()["settings"]
        assertThat(saved["keelbot"]["account"].asText()).isEqualTo("acc-keelbot-1")
        assertThat(saved["allow_reply"].asBoolean()).isTrue()
        assertThat(saved["rules"]["in_progress"]["mode"].asText()).isEqualTo("propose")      // null keeps the rules

        put("/api/projects/$pid/tasks/automations", mapOf("keelbot" to mapOf("account" to "a\" OR 1=1"))).andExpect(status().isBadRequest)
        put("/api/projects/$pid/tasks/automations", mapOf("keelbot" to mapOf("label" to "two words"))).andExpect(status().isBadRequest)
        put("/api/projects/$pid/tasks/automations", mapOf("rules" to mapOf("in_progress" to mapOf("mode" to "start", "run_mode" to "wild")))).andExpect(status().isBadRequest)
        put("/api/projects/$pid/tasks/automations", mapOf("daily_auto_starts" to 1000)).andExpect(status().isBadRequest)
        get("/api/projects/nope/tasks/automations").andExpect(status().isNotFound)
    }

    @Test
    fun `Pick a flow for me proposes the type's default without a model, and Not now puts it aside`() {
        val (pid, _) = newProject("auto-pick-default")
        val id = newTask(pid, "Checkout crashes")
        val asked = engine.calls.count { it.path == "/tasks/pick" }
        post("/api/tasks/$id/pick").andExpect(status().isOk)
        val p = proposals(pid).single()
        // a bug's default is fix; this project has no fix workflow (the stub engine's templates), so its first one
        assertThat(p["title"].asText()).isEqualTo("I want to run the feature flow on task ${id.take(8)}")
        assertThat(p["payload"]["fallback"].asBoolean()).isTrue()
        assertThat(p["detail"].asText()).contains("no model is set up")
        assertThat(engine.calls.count { it.path == "/tasks/pick" }).isEqualTo(asked)       // no model call

        assertThat(unread(id)).hasSize(1)

        // asking again replaces the open proposal, and its notification
        post("/api/tasks/$id/pick").andExpect(status().isOk)
        assertThat(proposals(pid)).hasSize(1)
        assertThat(unread(id)).hasSize(1)

        post("/api/inbox/tasks/${proposals(pid).single()["task"]["item_id"].asLong()}/act", mapOf("action" to "later")).andExpect(status().isOk)
        assertThat(proposals(pid)).isEmpty()
        // B3: the answered proposal's notification is done and read: the bell's count goes down
        assertThat(unread(id)).isEmpty()
        assertThat(get("/api/notifications?limit=500").json().filter { it["link"].asText() == "/tasks/$id" }).allMatch { it["done"].asBoolean() }
        assertThat(task(id)["events"].map { it["note"].asText() }).anyMatch { it.startsWith("Not now: you put keel's feature proposal aside.") }
        assertThat(task(id)["status"].asText()).isEqualTo("todo")

        // Review it needs a PR link; Pick needs a status a flow starts from
        post("/api/tasks/$id/review").andExpect(status().isConflict)
        post("/api/tasks/$id/pr", mapOf("url" to "https://github.com/acme/app/pull/9")).andExpect(status().isOk)
        post("/api/tasks/$id/pick").andExpect(status().isConflict)
    }

    @Test
    fun `with a model the engine picks, and Use another flow starts the flow the person chose`() {
        val (pid, _) = newProject("auto-pick-model")
        put("/api/projects/$pid/settings", mapOf("default_model" to mapOf("provider" to "claude", "mode" to "subscription", "model" to "sonnet")))
            .andExpect(status().isOk)
        var sent: JsonNode? = null
        engine.extraRoutes["/tasks/pick"] = { body ->
            sent = body
            200 to mapOf("ok" to true, "fake" to false, "tokens_in" to 400, "tokens_out" to 60, "pick" to mapOf(
                "workflow" to "feature", "why" to "The build fails.", "title" to "Fix the build", "request" to "Make CI green.",
                "questions" to emptyList<Any>(), "settings" to emptyMap<String, Any>(), "fallback" to false))
        }
        val id = newTask(pid, "CI is red")
        post("/api/tasks/$id/pick").andExpect(status().isOk)
        val p = proposals(pid).single()
        assertThat(p["payload"]["workflow_id"].asText()).isEqualTo("feature")
        assertThat(p["payload"]["fallback"].asBoolean()).isFalse()
        assertThat(p["payload"]["model"].asText()).contains("claude")
        assertThat(sent!!["model"]["effort"].asText()).isEqualTo("low")
        assertThat(sent!!["ticket"]["title"].asText()).isEqualTo("CI is red")

        val item = p["task"]["item_id"].asLong()
        post("/api/inbox/tasks/$item/act", mapOf("action" to "other")).andExpect(status().isBadRequest)        // which flow?
        engine.nextThreadIds += "t-other-1"
        post("/api/inbox/tasks/$item/act", mapOf("action" to "other", "workflow_id" to "knowledge-refresh", "allow_dirty" to true)).andExpect(status().isOk)
        val t = task(id)
        assertThat(t["workflow_id"].asText()).isEqualTo("knowledge-refresh")
        assertThat(t["status"].asText()).isEqualTo("in_progress")
        assertThat(engine.lastBody("/threads")!!["request"].asText()).startsWith("Make CI green.")
        assertThat(unread(id)).isEmpty()                                                                      // Start: read too
        post("/api/inbox/tasks/$item/act", mapOf("action" to "start")).andExpect(status().isConflict)           // answered already
    }
}
