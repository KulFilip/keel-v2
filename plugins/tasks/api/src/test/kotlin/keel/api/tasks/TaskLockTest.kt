package keel.api.tasks

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Import
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * A slow Jira must not block the task: the tracker is reached outside the task's lock, so an edit of the same task made
 * while Jira answers goes through, and is still there afterwards.
 */
@Import(TaskLockTest.SlowJira::class)
class TaskLockTest : ApiTest() {

    @TestConfiguration
    class SlowJira {
        @Bean
        fun slowTracker(): TicketTracker = object : TicketTracker {
            override fun connection(pid: String) = TrackerConnection("https://jira.example")
            override fun client(pid: String): TicketClient = object : TicketClient {
                override fun transitionTo(key: String, target: String): TicketMove {
                    entered.countDown()
                    release.await(20, TimeUnit.SECONDS)
                    return object : TicketMove { override val moved = true; override val from: String? = "To Do"; override val to = target }
                }
                override fun comment(key: String, text: String) {}
                override fun setUsers(key: String, fieldId: String, users: List<String>) {}
            }
            override fun syncInfo(pid: String) = SyncInfo.NONE
            override fun sync(pid: String): SyncResult? = null
            override fun poll() {}
        }
    }

    @Test
    fun `an edit goes through while Jira is still answering a move of the same task`() {
        entered = CountDownLatch(1)
        release = CountDownLatch(1)
        val (pid, _) = newProject("tasks-lock")
        val id = post("/api/projects/$pid/tasks", mapOf("title" to "Slow ticket", "external_key" to "ABC-1"))
            .andExpect(status().isOk).json()["id"].asText()
        val pool = Executors.newFixedThreadPool(2)
        try {
            val move = pool.submit { post("/api/tasks/$id/status", mapOf("to" to "in_progress")).andExpect(status().isOk) }
            assertThat(entered.await(10, TimeUnit.SECONDS)).isTrue()          // keel is inside Jira's call now
            val edit = pool.submit { put("/api/tasks/$id", mapOf("description" to "edited meanwhile")).andExpect(status().isOk) }
            edit.get(5, TimeUnit.SECONDS)                                      // times out when the move holds the task's lock
            release.countDown()
            move.get(10, TimeUnit.SECONDS)
        } finally {
            release.countDown()
            pool.shutdownNow()
        }
        val t = get("/api/tasks/$id").json()
        assertThat(t["status"].asText()).isEqualTo("in_progress")
        assertThat(t["description"].asText()).isEqualTo("edited meanwhile")
        assertThat(t["external_status"].asText()).isEqualTo("In Progress")      // Jira's answer was written on the edited task
    }

    companion object {
        @Volatile var entered = CountDownLatch(1)
        @Volatile var release = CountDownLatch(1)
    }
}
