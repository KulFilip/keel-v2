package keel.api

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.within
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.UUID

/** The budget bar on every page: today, this month, each running flow against its own cap, and the day and month caps. */
class BudgetNowApiTest : ApiTest() {

    @Autowired lateinit var jdbc: JdbcTemplate

    private val today: LocalDate = LocalDate.now(ZoneOffset.UTC)

    private fun call(pid: String, at: Instant, tokensIn: Long, tokensOut: Long, cached: Long, cost: Double, thread: String? = null,
                     mode: String = "subscription") {
        jdbc.update(
            """INSERT INTO agent_calls(id, project_id, thread_id, agent, provider, status, started_at, tokens_in, tokens_out, tokens_cached, cost_usd, mode)
               VALUES (?, ?, ?, 'implementer', 'claude', 'done', ?, ?, ?, ?, ?, ?)""",
            "c-" + UUID.randomUUID(), pid, thread, at.toString(), tokensIn, tokensOut, cached, cost, mode,
        )
    }

    private fun thread(pid: String, id: String, title: String, status: String, stateJson: String?) {
        val now = Instant.now().toString()
        jdbc.update(
            "INSERT INTO threads(id, project_id, title, status, state_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            id, pid, title, status, stateJson, now, now,
        )
    }

    @Test
    fun `today, this month, running flows against their caps, and the day and month caps`() {
        val (pid, _) = newProject("budget-now")
        val startOfToday = today.atStartOfDay().toInstant(ZoneOffset.UTC)
        val running = "t-" + UUID.randomUUID()
        val waiting = "t-" + UUID.randomUUID()
        thread(pid, running, "add a logger", "running", """{"status":"running","usage":{"tokens_in":0,"tokens_out":0,"cost_usd":0,"premium_requests":0,"cap_tokens":636000}}""")
        // the engine counted more than the finished calls hold (an agent is still running): its number wins
        thread(pid, waiting, "fix the login", "waiting", """{"status":"waiting","usage":{"tokens_in":200000,"tokens_out":10000,"cost_usd":1.5,"premium_requests":0,"cap_tokens":0,"cap_usd":5.0}}""")
        thread(pid, "t-" + UUID.randomUUID(), "old flow", "done", null)

        call(pid, startOfToday.plusSeconds(60), 400_000, 100_000, 170_000, 2.0, running)    // 517k with a tenth of the cache
        call(pid, startOfToday.minusSeconds(3600), 100_000, 0, 0, 0.5)                       // yesterday (or earlier this month)
        call(pid, today.withDayOfMonth(1).minusDays(1).atStartOfDay().toInstant(ZoneOffset.UTC), 900_000, 0, 0, 9.0)  // last month
        call("another-project", Instant.now(), 5_000_000, 0, 0, 99.0)
        post("/api/projects/$pid/caps", mapOf("scope" to "day", "limit" to 1_000_000, "unit" to "tokens", "action" to "pause")).andExpect(status().isOk)
        post("/api/projects/$pid/caps", mapOf("scope" to "flow", "limit" to 300_000, "unit" to "tokens", "action" to "stop")).andExpect(status().isOk)

        val res = get("/api/projects/$pid/budget/now").andExpect(status().isOk).json()
        assertThat(res["today"]["tokens"].asLong()).isEqualTo(517_000)
        assertThat(res["today"]["cost_usd"].asDouble()).isCloseTo(2.0, within(1e-9))
        val monthTokens = if (today.dayOfMonth == 1) 517_000L else 617_000L                   // on the 1st, "an hour ago" was last month
        assertThat(res["month"]["tokens"].asLong()).isEqualTo(monthTokens)

        val flows = res["flows"].associateBy { it["thread_id"].asText() }
        assertThat(flows.keys).containsExactlyInAnyOrder(running, waiting)
        assertThat(flows[running]!!["title"].asText()).isEqualTo("add a logger")
        assertThat(flows[running]!!["tokens"].asLong()).isEqualTo(517_000)
        assertThat(flows[running]!!["cap_tokens"].asLong()).isEqualTo(636_000)
        assertThat(flows[running]!!["cap_usd"].isNull).isTrue()
        assertThat(flows[waiting]!!["status"].asText()).isEqualTo("waiting")
        assertThat(flows[waiting]!!["tokens"].asLong()).isEqualTo(210_000)
        assertThat(flows[waiting]!!["cost_usd"].asDouble()).isCloseTo(1.5, within(1e-9))
        assertThat(flows[waiting]!!["cap_tokens"].isNull).isTrue()                             // 0 = no cap
        assertThat(flows[waiting]!!["cap_usd"].asDouble()).isCloseTo(5.0, within(1e-9))

        // only the caps a bar can show against a window: the day cap, not the per-flow one
        assertThat(res["caps"].map { it["window"].asText() }).containsExactly("day")
        assertThat(res["caps"][0]["limit"].asDouble()).isEqualTo(1_000_000.0)
    }

    @Test
    fun `keel Product's own runs count in every project's totals and in Budget's list of projects`() {
        // e2e 0.18.54: 28 product calls ($2.57) on the keel-product project showed nowhere (not Today, not Budget)
        val (pid, _) = newProject("budget-all")
        val product = "keel-product-" + UUID.randomUUID().toString().take(8)
        jdbc.update("INSERT INTO projects(id, name, root, created_at, hidden) VALUES (?, 'keel Product', ?, ?, 0)", product, "/data/$product", Instant.now().toString())
        val now = Instant.now()
        call(pid, now, 10_000, 1_000, 0, 1.0)
        call(product, now, 50_000, 5_000, 0, 2.0, mode = "api")
        call(product, now, 5_000, 500, 0, 0.57, mode = "api")

        val bar = get("/api/projects/$pid/budget/now").andExpect(status().isOk).json()
        assertThat(bar["today"]["cost_usd"].asDouble()).isCloseTo(1.0, within(1e-9))                  // this project's own
        val since = today.atStartOfDay().toInstant(ZoneOffset.UTC).toString()
        val everything = jdbc.queryForObject("SELECT SUM(cost_usd) FROM agent_calls WHERE started_at >= ?", Double::class.java, since)!!
        assertThat(bar["all_today"]["cost_usd"].asDouble()).isCloseTo(everything, within(1e-9))
        assertThat(bar["all_today"]["cost_usd"].asDouble() - bar["today"]["cost_usd"].asDouble()).isGreaterThanOrEqualTo(2.57 - 1e-9)
        assertThat(bar["all_month"]["cost_usd"].asDouble()).isGreaterThanOrEqualTo(bar["all_today"]["cost_usd"].asDouble() - 1e-9)

        val b = get("/api/projects/$pid/budget").andExpect(status().isOk).json()
        val rows = b["projects"].associateBy { it["project_id"].asText() }
        assertThat(rows[product]!!["name"].asText()).isEqualTo("keel Product")
        assertThat(rows[product]!!["cost_usd"].asDouble()).isCloseTo(2.57, within(1e-9))
        assertThat(rows[product]!!["api_cost_usd"].asDouble()).isCloseTo(2.57, within(1e-9))
        assertThat(rows[product]!!["calls"].asInt()).isEqualTo(2)
        assertThat(rows[pid]!!["tokens"].asLong()).isEqualTo(11_000)
        // the list adds up to the total, and its API-key column to the "API keys (all)" account row
        assertThat(b["projects"].sumOf { it["cost_usd"].asDouble() }).isCloseTo(b["all"]["cost_usd"].asDouble(), within(1e-6))
        assertThat(b["projects"].sumOf { it["tokens"].asLong() }).isEqualTo(b["all"]["tokens"].asLong())
        val apiRow = get("/api/limits").andExpect(status().isOk).json().first { it["id"].asText() == "api" }
        assertThat(b["projects"].sumOf { it["api_cost_usd"].asDouble() }).isCloseTo(apiRow["used"].asDouble(), within(1e-6))
    }

    @Test
    fun `an unknown project is a 404`() {
        get("/api/projects/nope/budget/now").andExpect(status().isNotFound)
    }
}
