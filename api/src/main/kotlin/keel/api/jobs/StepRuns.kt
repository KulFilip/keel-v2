package keel.api.jobs

import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import java.time.Instant

/**
 * keel 0.18.11 what one step of a flow really did (the Flow page's blocks): its agent calls added up per step and
 * criterion. A try is a round of calls (calls that overlap in time, like parallel lanes, are one try); the model and
 * effort are the last call's, the time is the calls' own working time (not the time a gate waited), and the result is
 * the first line of what the last call answered.
 */
data class StepRun(
    val step: String,
    val ac: String?,
    val tries: Int,
    val status: String,
    val agent: String?,
    val provider: String?,
    val model: String?,
    val effort: String?,
    val startedAt: String,
    val endedAt: String?,
    val ms: Long,
    val tokensIn: Long,
    val tokensOut: Long,
    val tokensCached: Long,
    val costUsd: Double,
    val result: String?,
    val callId: String,
)

@Service
class StepRunService(private val jdbc: JdbcTemplate) {

    private data class Call(
        val id: String, val step: String, val ac: String?, val status: String, val agent: String?, val provider: String?, val model: String?,
        val effort: String?, val startedAt: String, val endedAt: String?, val tokensIn: Long, val tokensOut: Long, val tokensCached: Long,
        val costUsd: Double, val result: String?,
    )

    fun of(project: String, thread: String, now: Instant = Instant.now()): List<StepRun> {
        val calls = jdbc.query(
            """SELECT id, step, ac, status, agent, provider, model, effort, started_at, ended_at, tokens_in, tokens_out, tokens_cached,
                      cost_usd, result
               FROM agent_calls WHERE project_id = ? AND thread_id = ? ORDER BY started_at, id""",
            { rs, _ ->
                Call(
                    rs.getString("id"), rs.getString("step") ?: "", rs.getString("ac"), rs.getString("status"), rs.getString("agent"),
                    rs.getString("provider"), rs.getString("model"), rs.getString("effort"), rs.getString("started_at"), rs.getString("ended_at"),
                    rs.getLong("tokens_in"), rs.getLong("tokens_out"), rs.getLong("tokens_cached"), rs.getDouble("cost_usd"), rs.getString("result"),
                )
            },
            project, thread,
        )
        return calls.groupBy { it.step to it.ac }.map { (key, cs) ->
            val last = cs.last()
            StepRun(
                step = key.first, ac = key.second, tries = tries(cs, now), status = last.status, agent = last.agent, provider = last.provider,
                model = last.model, effort = last.effort, startedAt = cs.first().startedAt, endedAt = last.endedAt,
                ms = cs.sumOf { (end(it, now) - start(it)).coerceAtLeast(0) },
                tokensIn = cs.sumOf { it.tokensIn }, tokensOut = cs.sumOf { it.tokensOut }, tokensCached = cs.sumOf { it.tokensCached },
                costUsd = cs.sumOf { it.costUsd }, result = firstLine(last.result), callId = last.id,
            )
        }
    }

    /** Rounds of calls: a call that starts after every earlier call ended is a new try. */
    private fun tries(cs: List<Call>, now: Instant): Int {
        var n = 0
        var busyUntil = Long.MIN_VALUE
        cs.sortedBy { start(it) }.forEach { c ->
            if (start(c) >= busyUntil) n++
            busyUntil = maxOf(busyUntil, end(c, now))
        }
        return n
    }

    private fun start(c: Call): Long = millis(c.startedAt) ?: 0L
    private fun end(c: Call, now: Instant): Long = c.endedAt?.let(::millis) ?: if (c.status == "running") now.toEpochMilli() else start(c)
    private fun millis(t: String): Long? = try { Instant.parse(t).toEpochMilli() } catch (e: Exception) { null }

    companion object {
        /** The first line that says something, without markdown marks, at most 100 characters. */
        fun firstLine(text: String?): String? {
            val line = text.orEmpty().lineSequence()
                .map { it.trim().trimStart('#', '>', '-', '*', ' ').replace("**", "").replace("__", "").replace("`", "").trim() }
                .firstOrNull { it.isNotEmpty() && !it.all { ch -> ch == '-' || ch == '=' || ch == '|' } }
                ?.replace(Regex("\\s+"), " ")
                ?: return null
            return if (line.length <= 100) line else line.take(99).trimEnd() + "…"
        }
    }
}
