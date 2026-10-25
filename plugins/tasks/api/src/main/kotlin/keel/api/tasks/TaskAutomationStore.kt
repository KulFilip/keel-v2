package keel.api.tasks

import keel.api.common.Json
import keel.api.common.Time
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Component
import java.time.LocalDate
import java.time.ZoneOffset

/** A task keel watches: its ticket is KeelBot's ([owned]); [seen] = "<thread>:<comment>" already handled. */
data class TaskWatch(val taskId: String, val prUrl: String?, val owned: Boolean, val seen: List<String>, val looked: Boolean)

/** A flow keel started for a task without changing its status (kind review | address). */
data class TaskRun(val threadId: String, val taskId: String, val kind: String, val workflowId: String?)

/** The automation tables (V24): task_automations, task_watch, task_runs. Plain SQL, no logic. */
@Component
class TaskAutomationStore(private val jdbc: JdbcTemplate) {

    fun settings(pid: String): AutomationSettings =
        jdbc.query("SELECT json FROM task_automations WHERE project_id = ?", { rs, _ -> rs.getString(1) }, pid).firstOrNull()
            ?.let { runCatching { Json.read<AutomationSettings>(it) }.getOrNull() } ?: AutomationSettings()

    fun save(pid: String, s: AutomationSettings) {
        jdbc.update(
            "INSERT INTO task_automations(project_id, json, updated_at) VALUES (?, ?, ?) " +
                "ON CONFLICT(project_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
            pid, Json.write(s), Time.now(),
        )
    }

    fun watch(taskId: String): TaskWatch? = jdbc.query(
        "SELECT task_id, pr_url, owned, seen, looked FROM task_watch WHERE task_id = ?",
        { rs, _ -> TaskWatch(rs.getString(1), rs.getString(2), rs.getInt(3) == 1, Json.readList(rs.getString(4)), rs.getInt(5) == 1) }, taskId,
    ).firstOrNull()

    /** Marks the task KeelBot's (or not); a new PR link starts a new baseline. */
    fun setOwned(taskId: String, owned: Boolean, prUrl: String?) {
        val cur = watch(taskId)
        if (cur == null) {
            jdbc.update("INSERT INTO task_watch(task_id, pr_url, owned, seen, looked, updated_at) VALUES (?, ?, ?, '[]', 0, ?)",
                taskId, prUrl, if (owned) 1 else 0, Time.now())
            return
        }
        val newPr = prUrl != null && prUrl != cur.prUrl
        jdbc.update("UPDATE task_watch SET owned = ?, pr_url = ?, seen = ?, looked = ?, updated_at = ? WHERE task_id = ?",
            if (owned) 1 else 0, prUrl ?: cur.prUrl, if (newPr) "[]" else Json.write(cur.seen), if (newPr || !cur.looked) 0 else 1, Time.now(), taskId)
    }

    /** Remembers the comments handled (the newest 500), and that the first look is done. */
    fun markSeen(taskId: String, ids: Collection<String>) {
        val cur = watch(taskId) ?: return
        val all = (cur.seen + ids).distinct().takeLast(500)
        jdbc.update("UPDATE task_watch SET seen = ?, looked = 1, updated_at = ? WHERE task_id = ?", Json.write(all), Time.now(), taskId)
    }

    fun owned(): List<TaskWatch> = jdbc.query(
        "SELECT task_id, pr_url, owned, seen, looked FROM task_watch WHERE owned = 1",
        { rs, _ -> TaskWatch(rs.getString(1), rs.getString(2), true, Json.readList(rs.getString(4)), rs.getInt(5) == 1) },
    )

    fun addRun(threadId: String, taskId: String, kind: String, workflowId: String?) {
        jdbc.update("INSERT OR REPLACE INTO task_runs(thread_id, task_id, kind, workflow_id, created_at) VALUES (?, ?, ?, ?, ?)",
            threadId, taskId, kind, workflowId, Time.now())
    }

    fun run(threadId: String): TaskRun? = jdbc.query(
        "SELECT thread_id, task_id, kind, workflow_id FROM task_runs WHERE thread_id = ?",
        { rs, _ -> TaskRun(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4)) }, threadId,
    ).firstOrNull()

    fun runs(taskId: String): List<TaskRun> = jdbc.query(
        "SELECT thread_id, task_id, kind, workflow_id FROM task_runs WHERE task_id = ? ORDER BY created_at",
        { rs, _ -> TaskRun(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4)) }, taskId,
    )

    /** Flows keel started by itself today (UTC) in the project: history lines of kind auto_start. */
    fun autoStartsToday(pid: String): Int = jdbc.queryForObject(
        "SELECT COUNT(*) FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE t.project_id = ? AND e.kind = 'auto_start' AND e.at >= ?",
        Int::class.java, pid, LocalDate.now(ZoneOffset.UTC).toString(),
    ) ?: 0
}
