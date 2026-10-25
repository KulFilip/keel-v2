package keel.product

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import keel.api.common.Time
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Component
import java.sql.ResultSet
import java.util.UUID

// ---------- what keel Product keeps (its own tables, db/product/P1__product.sql) ----------

data class Initiative(
    val id: String,
    val n: Int,
    val title: String,
    val idea: String,
    val whyNow: String?,
    val outcomeHope: String?,
    val owner: String?,
    /** idea, brief, impact, decision, plan, delivery, outcome, done */
    val stage: String,
    /** new, running, waiting, ready, parked, failed, done */
    val status: String,
    val option: String?,
    val repos: List<String>,
    val metric: String?,
    val revisitAt: String?,
    val createdAt: String,
    val updatedAt: String,
)

data class ProductDoc(
    val initiativeId: String,
    val kind: String,
    val version: Int,
    val path: String,
    val sha: String?,
    val text: String,
    val data: Any?,
    val threadId: String?,
    val createdAt: String,
    val approvedAt: String?,
)

data class ProductRun(
    val threadId: String,
    val initiativeId: String,
    val stage: String,
    val workflowId: String,
    val status: String,
    val reason: String?,
    val startedAt: String,
    val endedAt: String?,
)

data class ProductQuestion(
    val id: String,
    val initiativeId: String,
    val stage: String,
    val role: String,
    val askedTo: String?,
    val about: String?,
    val text: String,
    val answer: String?,
    val answeredBy: String?,
    val status: String,
    val createdAt: String,
    val answeredAt: String?,
)

data class Disagreement(
    val id: String,
    val initiativeId: String,
    val stage: String,
    val author: String,
    val reason: String,
    val proposal: String?,
    val decider: String,
    val status: String,
    val outcome: String?,
    val decidedBy: String?,
    val createdAt: String,
    val decidedAt: String?,
)

data class ProductEvent(val id: Long, val initiativeId: String, val at: String, val actor: String, val kind: String, val text: String, val data: Any?)

data class FollowUp(
    val id: String,
    val initiativeId: String,
    val kind: String,
    val text: String,
    val owner: String?,
    val dueAt: String,
    val repeatDays: Int?,
    val ref: String?,
    val doneAt: String?,
    val lastRemindedAt: String?,
    val createdAt: String,
)

data class PlanItem(
    val initiativeId: String,
    val version: Int,
    val id: String,
    val epic: String,
    val team: String?,
    val repo: String?,
    val title: String,
    val body: Map<String, Any?>,
    val jiraKey: String?,
    val projectId: String?,
    val taskId: String?,
)

/** A branch or commit and the ticket key found in it ('' = none), P4__product_ticket_links.sql. */
data class TicketLink(
    val projectId: String,
    val kind: String,
    val ref: String,
    val key: String,
    val teamId: String?,
    val title: String?,
    val author: String?,
    val at: String?,
    val files: List<String> = emptyList(),
)

data class ProjectScan(val projectId: String, val at: String, val branches: Int, val commits: Int, val linked: Int, val error: String?)

/** A ticket on a team's Tasks board linked to an initiative (P7__product_initiative_tickets.sql). */
data class InitiativeTicket(val initiativeId: String, val key: String, val projectId: String?, val taskId: String?, val addedAt: String)

/** A business flow of one repo (P6__product_flows.sql); [data] holds its steps, endpoints and tables. */
data class BusinessFlow(
    val projectId: String,
    val id: String,
    val name: String,
    val summary: String?,
    val team: String?,
    val data: Map<String, Any?>,
    val edited: Boolean,
    val hidden: Boolean,
    val updatedAt: String,
)

data class FlowRun(val threadId: String, val projects: List<String>, val status: String, val error: String?, val startedAt: String, val endedAt: String?)

/** A Jira ticket keel Product made above the stories (P2__product_tickets.sql). */
data class JiraTicket(val initiativeId: String, val level: String, val ref: String, val site: String, val jiraProject: String, val jiraKey: String,
                      val createdAt: String)

/** An epic of a plan version, as the product manager left it (P5__product_drafts.sql). */
data class PlanEpic(val initiativeId: String, val version: Int, val id: String, val team: String?, val title: String)

data class TeamPath(val teamId: String, val projectId: String, val glob: String, val source: String)

data class Team(
    val id: String,
    val name: String,
    val lead: String?,
    val jiraProject: String?,
    val capacityDays: Double?,
    val members: List<String>,
    val source: String,
    val owns: List<TeamPath>,
    val createdAt: String,
    val updatedAt: String,
    val jira: TeamJira = TeamJira(),
    /** The ticket-key pattern as the team saved it (null: [TicketKeys.default] of its Jira project). */
    val keyPattern: String? = null,
) {
    /** The keel projects the team owns (all or part of). */
    val projects: List<String> get() = owns.map { it.projectId }.distinct()

    /** The pattern keel matches branches and commits with. */
    val keys: String? get() = keyPattern ?: TicketKeys.default(jiraProject)
}

/** A team's own Jira. Blank issue types are found in Jira (TicketSender); blank labels add none. */
data class TeamJira(
    /** The keel project whose Jira connection the team uses; null = keel's keel-wide connection. */
    val connection: String? = null,
    val initiativeType: String? = null,
    val epicType: String? = null,
    val storyType: String? = null,
    val subtaskType: String? = null,
    /** Jira Server and Data Center: the Epic Link field (customfield_…) a story names its epic with; blank = found by name. */
    val epicLinkField: String? = null,
    val labels: List<String> = emptyList(),
    val component: String? = null,
)

data class TeamSuggestion(
    val id: String,
    val teamId: String,
    val page: String,
    val text: String,
    val source: String?,
    val status: String,
    val createdAt: String,
    val decidedAt: String?,
)

/** JDBC for keel Product's tables. Every write goes through here. */
@Component
class ProductStore(private val jdbc: JdbcTemplate, private val mapper: ObjectMapper, @Suppress("unused") schema: ProductSchema) {
    private fun json(v: Any?): String? = v?.let { mapper.writeValueAsString(it) }
    private fun <T> parse(s: String?, fallback: T, read: (String) -> T): T = if (s.isNullOrBlank()) fallback else runCatching { read(s) }.getOrDefault(fallback)
    private fun any(s: String?): Any? = parse(s, null) { mapper.readValue<Any>(it) }
    fun newId(prefix: String) = "$prefix-${UUID.randomUUID().toString().replace("-", "").take(10)}"

    // ---- initiatives
    private fun initiative(rs: ResultSet) = Initiative(
        rs.getString("id"), rs.getInt("n"), rs.getString("title"), rs.getString("idea"), rs.getString("why_now"),
        rs.getString("outcome_hope"), rs.getString("owner"), rs.getString("stage"), rs.getString("status"), rs.getString("option"),
        parse(rs.getString("repos_json"), emptyList()) { mapper.readValue<List<String>>(it) }, rs.getString("metric"),
        rs.getString("revisit_at"), rs.getString("created_at"), rs.getString("updated_at"),
    )

    fun initiatives(): List<Initiative> = jdbc.query("SELECT * FROM product_initiatives ORDER BY n DESC") { rs, _ -> initiative(rs) }
    fun initiative(id: String): Initiative? = jdbc.query("SELECT * FROM product_initiatives WHERE id = ?", { rs, _ -> initiative(rs) }, id).firstOrNull()

    fun nextNumber(): Int = (jdbc.queryForObject("SELECT COALESCE(MAX(n), 0) FROM product_initiatives", Int::class.java) ?: 0) + 1

    fun insert(i: Initiative) {
        jdbc.update(
            "INSERT INTO product_initiatives(id, n, title, idea, why_now, outcome_hope, owner, stage, status, option, repos_json, metric, revisit_at, created_at, updated_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            i.id, i.n, i.title, i.idea, i.whyNow, i.outcomeHope, i.owner, i.stage, i.status, i.option, json(i.repos), i.metric, i.revisitAt,
            i.createdAt, i.updatedAt,
        )
    }

    fun update(i: Initiative): Initiative {
        val next = i.copy(updatedAt = Time.now())
        jdbc.update(
            "UPDATE product_initiatives SET title = ?, idea = ?, why_now = ?, outcome_hope = ?, owner = ?, stage = ?, status = ?, option = ?, " +
                "repos_json = ?, metric = ?, revisit_at = ?, updated_at = ? WHERE id = ?",
            next.title, next.idea, next.whyNow, next.outcomeHope, next.owner, next.stage, next.status, next.option, json(next.repos), next.metric,
            next.revisitAt, next.updatedAt, next.id,
        )
        return next
    }

    // ---- documents
    private fun doc(rs: ResultSet) = ProductDoc(
        rs.getString("initiative_id"), rs.getString("kind"), rs.getInt("version"), rs.getString("path"), rs.getString("sha"),
        rs.getString("text") ?: "", any(rs.getString("data_json")), rs.getString("thread_id"), rs.getString("created_at"), rs.getString("approved_at"),
    )

    fun docs(id: String): List<ProductDoc> =
        jdbc.query("SELECT * FROM product_docs WHERE initiative_id = ? ORDER BY kind, version", { rs, _ -> doc(rs) }, id)

    fun doc(id: String, kind: String, version: Int): ProductDoc? =
        jdbc.query("SELECT * FROM product_docs WHERE initiative_id = ? AND kind = ? AND version = ?", { rs, _ -> doc(rs) }, id, kind, version).firstOrNull()

    fun latest(id: String, kind: String): ProductDoc? =
        jdbc.query("SELECT * FROM product_docs WHERE initiative_id = ? AND kind = ? ORDER BY version DESC LIMIT 1", { rs, _ -> doc(rs) }, id, kind).firstOrNull()

    fun saveDoc(d: ProductDoc) {
        jdbc.update(
            "INSERT INTO product_docs(initiative_id, kind, version, path, sha, text, data_json, thread_id, created_at, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
                "ON CONFLICT(initiative_id, kind, version) DO UPDATE SET path = excluded.path, sha = excluded.sha, text = excluded.text, " +
                "data_json = excluded.data_json, thread_id = excluded.thread_id",
            d.initiativeId, d.kind, d.version, d.path, d.sha, d.text, json(d.data), d.threadId, d.createdAt, d.approvedAt,
        )
    }

    fun approveLatest(id: String, kind: String) {
        jdbc.update(
            "UPDATE product_docs SET approved_at = ? WHERE initiative_id = ? AND kind = ? AND version = (SELECT MAX(version) FROM product_docs WHERE initiative_id = ? AND kind = ?)",
            Time.now(), id, kind, id, kind,
        )
    }

    // ---- runs
    private fun run(rs: ResultSet) = ProductRun(
        rs.getString("thread_id"), rs.getString("initiative_id"), rs.getString("stage"), rs.getString("workflow_id"), rs.getString("status"),
        rs.getString("reason"), rs.getString("started_at"), rs.getString("ended_at"),
    )

    fun runs(id: String): List<ProductRun> =
        jdbc.query("SELECT * FROM product_runs WHERE initiative_id = ? ORDER BY started_at DESC", { rs, _ -> run(rs) }, id)

    fun run(tid: String): ProductRun? = jdbc.query("SELECT * FROM product_runs WHERE thread_id = ?", { rs, _ -> run(rs) }, tid).firstOrNull()

    fun activeRun(id: String): ProductRun? =
        jdbc.query("SELECT * FROM product_runs WHERE initiative_id = ? AND status IN ('running','waiting') ORDER BY started_at DESC LIMIT 1",
            { rs, _ -> run(rs) }, id).firstOrNull()

    fun saveRun(r: ProductRun) {
        jdbc.update(
            "INSERT INTO product_runs(thread_id, initiative_id, stage, workflow_id, status, reason, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
                "ON CONFLICT(thread_id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at",
            r.threadId, r.initiativeId, r.stage, r.workflowId, r.status, r.reason, r.startedAt, r.endedAt,
        )
    }

    // ---- questions
    private fun question(rs: ResultSet) = ProductQuestion(
        rs.getString("id"), rs.getString("initiative_id"), rs.getString("stage"), rs.getString("role"), rs.getString("asked_to"),
        rs.getString("about"), rs.getString("text"), rs.getString("answer"), rs.getString("answered_by"), rs.getString("status"),
        rs.getString("created_at"), rs.getString("answered_at"),
    )

    fun questions(id: String): List<ProductQuestion> =
        jdbc.query("SELECT * FROM product_questions WHERE initiative_id = ? ORDER BY created_at", { rs, _ -> question(rs) }, id)

    fun question(qid: String): ProductQuestion? = jdbc.query("SELECT * FROM product_questions WHERE id = ?", { rs, _ -> question(rs) }, qid).firstOrNull()

    fun saveQuestion(q: ProductQuestion) {
        jdbc.update(
            "INSERT INTO product_questions(id, initiative_id, stage, role, asked_to, about, text, answer, answered_by, status, created_at, answered_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET answer = excluded.answer, answered_by = excluded.answered_by, " +
                "status = excluded.status, answered_at = excluded.answered_at",
            q.id, q.initiativeId, q.stage, q.role, q.askedTo, q.about, q.text, q.answer, q.answeredBy, q.status, q.createdAt, q.answeredAt,
        )
    }

    // ---- disagreements
    private fun disagreement(rs: ResultSet) = Disagreement(
        rs.getString("id"), rs.getString("initiative_id"), rs.getString("stage"), rs.getString("author"), rs.getString("reason"),
        rs.getString("proposal"), rs.getString("decider"), rs.getString("status"), rs.getString("outcome"), rs.getString("decided_by"),
        rs.getString("created_at"), rs.getString("decided_at"),
    )

    fun disagreements(id: String): List<Disagreement> =
        jdbc.query("SELECT * FROM product_disagreements WHERE initiative_id = ? ORDER BY created_at", { rs, _ -> disagreement(rs) }, id)

    fun disagreement(did: String): Disagreement? =
        jdbc.query("SELECT * FROM product_disagreements WHERE id = ?", { rs, _ -> disagreement(rs) }, did).firstOrNull()

    fun saveDisagreement(d: Disagreement) {
        jdbc.update(
            "INSERT INTO product_disagreements(id, initiative_id, stage, author, reason, proposal, decider, status, outcome, decided_by, created_at, decided_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, outcome = excluded.outcome, " +
                "decided_by = excluded.decided_by, decided_at = excluded.decided_at",
            d.id, d.initiativeId, d.stage, d.author, d.reason, d.proposal, d.decider, d.status, d.outcome, d.decidedBy, d.createdAt, d.decidedAt,
        )
    }

    // ---- history
    fun event(id: String, actor: String, kind: String, text: String, data: Any? = null) {
        jdbc.update("INSERT INTO product_events(initiative_id, at, actor, kind, text, data_json) VALUES (?, ?, ?, ?, ?, ?)",
            id, Time.now(), actor, kind, text.take(2000), json(data))
    }

    fun events(id: String): List<ProductEvent> = jdbc.query("SELECT * FROM product_events WHERE initiative_id = ? ORDER BY id DESC", { rs, _ ->
        ProductEvent(rs.getLong("id"), rs.getString("initiative_id"), rs.getString("at"), rs.getString("actor"), rs.getString("kind"),
            rs.getString("text"), any(rs.getString("data_json")))
    }, id)

    // ---- follow-ups
    private fun followUp(rs: ResultSet) = FollowUp(
        rs.getString("id"), rs.getString("initiative_id"), rs.getString("kind"), rs.getString("text"), rs.getString("owner"),
        rs.getString("due_at"), rs.getObject("repeat_days")?.let { (it as Number).toInt() }, rs.getString("ref"), rs.getString("done_at"),
        rs.getString("last_reminded_at"), rs.getString("created_at"),
    )

    fun followUps(id: String): List<FollowUp> =
        jdbc.query("SELECT * FROM product_follow_ups WHERE initiative_id = ? ORDER BY done_at IS NOT NULL, due_at", { rs, _ -> followUp(rs) }, id)

    fun openFollowUps(): List<FollowUp> = jdbc.query("SELECT * FROM product_follow_ups WHERE done_at IS NULL ORDER BY due_at") { rs, _ -> followUp(rs) }

    fun followUp(fid: String): FollowUp? = jdbc.query("SELECT * FROM product_follow_ups WHERE id = ?", { rs, _ -> followUp(rs) }, fid).firstOrNull()

    fun saveFollowUp(f: FollowUp) {
        jdbc.update(
            "INSERT INTO product_follow_ups(id, initiative_id, kind, text, owner, due_at, repeat_days, ref, done_at, last_reminded_at, created_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET text = excluded.text, owner = excluded.owner, " +
                "due_at = excluded.due_at, repeat_days = excluded.repeat_days, done_at = excluded.done_at, last_reminded_at = excluded.last_reminded_at",
            f.id, f.initiativeId, f.kind, f.text, f.owner, f.dueAt, f.repeatDays, f.ref, f.doneAt, f.lastRemindedAt, f.createdAt,
        )
    }

    fun closeFollowUps(id: String, ref: String) {
        jdbc.update("UPDATE product_follow_ups SET done_at = ? WHERE initiative_id = ? AND ref = ? AND done_at IS NULL", Time.now(), id, ref)
    }

    // ---- plan items
    private fun item(rs: ResultSet) = PlanItem(
        rs.getString("initiative_id"), rs.getInt("version"), rs.getString("id"), rs.getString("epic"), rs.getString("team"), rs.getString("repo"),
        rs.getString("title"), parse(rs.getString("body_json"), emptyMap()) { mapper.readValue<Map<String, Any?>>(it) },
        rs.getString("jira_key"), rs.getString("project_id"), rs.getString("task_id"),
    )

    fun items(id: String, version: Int): List<PlanItem> =
        jdbc.query("SELECT * FROM product_plan_items WHERE initiative_id = ? AND version = ? ORDER BY rowid", { rs, _ -> item(rs) }, id, version)

    fun saveItem(p: PlanItem) {
        jdbc.update(
            "INSERT INTO product_plan_items(initiative_id, version, id, epic, team, repo, title, body_json, jira_key, project_id, task_id) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(initiative_id, version, id) DO UPDATE SET jira_key = excluded.jira_key, " +
                "project_id = excluded.project_id, task_id = excluded.task_id",
            p.initiativeId, p.version, p.id, p.epic, p.team, p.repo, p.title, json(p.body), p.jiraKey, p.projectId, p.taskId,
        )
    }

    /** Every field of a story the product manager edits (saveItem keeps the plan's text and only sets the links). */
    fun updateItem(p: PlanItem) {
        jdbc.update(
            "UPDATE product_plan_items SET epic = ?, team = ?, repo = ?, title = ?, body_json = ?, project_id = ? WHERE initiative_id = ? AND version = ? AND id = ?",
            p.epic, p.team, p.repo, p.title, json(p.body), p.projectId, p.initiativeId, p.version, p.id,
        )
    }

    fun deleteItem(id: String, version: Int, sid: String) {
        jdbc.update("DELETE FROM product_plan_items WHERE initiative_id = ? AND version = ? AND id = ?", id, version, sid)
    }

    fun epics(id: String, version: Int): List<PlanEpic> =
        jdbc.query("SELECT * FROM product_plan_epics WHERE initiative_id = ? AND version = ? ORDER BY rowid", { rs, _ ->
            PlanEpic(rs.getString("initiative_id"), rs.getInt("version"), rs.getString("id"), rs.getString("team"), rs.getString("title"))
        }, id, version)

    fun saveEpic(e: PlanEpic) {
        jdbc.update(
            "INSERT INTO product_plan_epics(initiative_id, version, id, team, title) VALUES (?, ?, ?, ?, ?) " +
                "ON CONFLICT(initiative_id, version, id) DO UPDATE SET team = excluded.team, title = excluded.title",
            e.initiativeId, e.version, e.id, e.team, e.title,
        )
    }

    fun deleteEpic(id: String, version: Int, eid: String) {
        jdbc.update("DELETE FROM product_plan_epics WHERE initiative_id = ? AND version = ? AND id = ?", id, version, eid)
    }

    // ---- keel Product's settings
    fun <T> setting(key: String, type: Class<T>): T? =
        jdbc.query("SELECT json FROM product_settings WHERE key = ?", { rs, _ -> rs.getString(1) }, key).firstOrNull()
            ?.let { runCatching { mapper.readValue(it, type) }.getOrNull() }

    fun saveSetting(key: String, value: Any?) {
        if (value == null) jdbc.update("DELETE FROM product_settings WHERE key = ?", key)
        else jdbc.update("INSERT INTO product_settings(key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, " +
            "updated_at = excluded.updated_at", key, json(value), Time.now())
    }

    // ---- the tickets above the stories
    fun ticket(id: String, level: String, ref: String, site: String, jiraProject: String): JiraTicket? = jdbc.query(
        "SELECT * FROM product_tickets WHERE initiative_id = ? AND level = ? AND ref = ? AND site = ? AND jira_project = ?",
        { rs, _ -> ticket(rs) }, id, level, ref, site, jiraProject,
    ).firstOrNull()

    fun tickets(id: String): List<JiraTicket> =
        jdbc.query("SELECT * FROM product_tickets WHERE initiative_id = ? ORDER BY created_at", { rs, _ -> ticket(rs) }, id)

    private fun ticket(rs: ResultSet) = JiraTicket(rs.getString("initiative_id"), rs.getString("level"), rs.getString("ref"), rs.getString("site"),
        rs.getString("jira_project"), rs.getString("jira_key"), rs.getString("created_at"))

    fun saveTicket(t: JiraTicket) {
        jdbc.update(
            "INSERT INTO product_tickets(initiative_id, level, ref, site, jira_project, jira_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
                "ON CONFLICT(initiative_id, level, ref, site, jira_project) DO UPDATE SET jira_key = excluded.jira_key",
            t.initiativeId, t.level, t.ref, t.site, t.jiraProject, t.jiraKey, t.createdAt,
        )
    }

    // ---- business flows
    private fun flow(rs: ResultSet) = BusinessFlow(rs.getString("project_id"), rs.getString("id"), rs.getString("name"), rs.getString("summary"),
        rs.getString("team"), parse(rs.getString("data_json"), emptyMap()) { mapper.readValue<Map<String, Any?>>(it) }, rs.getInt("edited") == 1,
        rs.getInt("hidden") == 1, rs.getString("updated_at"))

    fun flows(projectId: String? = null): List<BusinessFlow> = if (projectId == null)
        jdbc.query("SELECT * FROM product_flows ORDER BY project_id, rowid") { rs, _ -> flow(rs) }
    else jdbc.query("SELECT * FROM product_flows WHERE project_id = ? ORDER BY rowid", { rs, _ -> flow(rs) }, projectId)

    fun saveFlow(f: BusinessFlow) {
        jdbc.update(
            "INSERT INTO product_flows(project_id, id, name, summary, team, data_json, edited, hidden, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
                "ON CONFLICT(project_id, id) DO UPDATE SET name = excluded.name, summary = excluded.summary, team = excluded.team, " +
                "data_json = excluded.data_json, edited = excluded.edited, hidden = excluded.hidden, updated_at = excluded.updated_at",
            f.projectId, f.id, f.name, f.summary, f.team, json(f.data), if (f.edited) 1 else 0, if (f.hidden) 1 else 0, f.updatedAt,
        )
    }

    fun deleteFlow(projectId: String, id: String) {
        jdbc.update("DELETE FROM product_flows WHERE project_id = ? AND id = ?", projectId, id)
    }

    private fun flowRun(rs: ResultSet) = FlowRun(rs.getString("thread_id"), parse(rs.getString("projects_json"), emptyList()) { mapper.readValue<List<String>>(it) },
        rs.getString("status"), rs.getString("error"), rs.getString("started_at"), rs.getString("ended_at"))

    fun flowRun(tid: String): FlowRun? = jdbc.query("SELECT * FROM product_flow_runs WHERE thread_id = ?", { rs, _ -> flowRun(rs) }, tid).firstOrNull()

    fun flowRuns(): List<FlowRun> = jdbc.query("SELECT * FROM product_flow_runs ORDER BY started_at DESC LIMIT 20") { rs, _ -> flowRun(rs) }

    fun saveFlowRun(r: FlowRun) {
        jdbc.update(
            "INSERT INTO product_flow_runs(thread_id, projects_json, status, error, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?) " +
                "ON CONFLICT(thread_id) DO UPDATE SET status = excluded.status, error = excluded.error, ended_at = excluded.ended_at",
            r.threadId, json(r.projects), r.status, r.error, r.startedAt, r.endedAt,
        )
    }

    // ---- tickets on the Tasks boards linked to an initiative (P7)
    private fun initiativeTicket(rs: ResultSet) = InitiativeTicket(rs.getString("initiative_id"), rs.getString("key"), rs.getString("project_id"),
        rs.getString("task_id"), rs.getString("added_at"))

    /** Links a ticket; false when it was linked already. */
    fun linkTicket(t: InitiativeTicket): Boolean = jdbc.update(
        "INSERT OR IGNORE INTO product_initiative_tickets(initiative_id, key, project_id, task_id, added_at) VALUES (?, ?, ?, ?, ?)",
        t.initiativeId, t.key, t.projectId, t.taskId, t.addedAt,
    ) > 0

    fun unlinkTicket(initiativeId: String, key: String): Boolean =
        jdbc.update("DELETE FROM product_initiative_tickets WHERE initiative_id = ? AND key = ?", initiativeId, key) > 0

    /** The linked tickets of one initiative (oldest first), or of every initiative. */
    fun initiativeTickets(initiativeId: String? = null): List<InitiativeTicket> = if (initiativeId == null)
        jdbc.query("SELECT * FROM product_initiative_tickets ORDER BY added_at, key") { rs, _ -> initiativeTicket(rs) }
    else jdbc.query("SELECT * FROM product_initiative_tickets WHERE initiative_id = ? ORDER BY added_at, key", { rs, _ -> initiativeTicket(rs) }, initiativeId)

    // ---- ticket keys found in git
    fun replaceLinks(projectId: String, links: List<TicketLink>, scan: ProjectScan) {
        jdbc.update("DELETE FROM product_ticket_links WHERE project_id = ?", projectId)
        jdbc.batchUpdate(
            "INSERT OR IGNORE INTO product_ticket_links(project_id, kind, ref, key, team_id, title, author, at, files_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            links.map { arrayOf(it.projectId, it.kind, it.ref, it.key, it.teamId, it.title, it.author, it.at, json(it.files.takeIf { f -> f.isNotEmpty() })) },
        )
        saveScan(scan)
    }

    fun saveScan(s: ProjectScan) {
        jdbc.update(
            "INSERT INTO product_scans(project_id, at, branches, commits, linked, error) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET " +
                "at = excluded.at, branches = excluded.branches, commits = excluded.commits, linked = excluded.linked, error = excluded.error",
            s.projectId, s.at, s.branches, s.commits, s.linked, s.error,
        )
    }

    fun scans(): List<ProjectScan> = jdbc.query("SELECT * FROM product_scans ORDER BY project_id") { rs, _ ->
        ProjectScan(rs.getString("project_id"), rs.getString("at"), rs.getInt("branches"), rs.getInt("commits"), rs.getInt("linked"), rs.getString("error"))
    }

    private fun link(rs: ResultSet) = TicketLink(rs.getString("project_id"), rs.getString("kind"), rs.getString("ref"), rs.getString("key"),
        rs.getString("team_id"), rs.getString("title"), rs.getString("author"), rs.getString("at"),
        parse(rs.getString("files_json"), emptyList()) { mapper.readValue<List<String>>(it) })

    /** The links with a key (of [teamId] when given, or of [keys] when given), newest first. */
    fun links(teamId: String? = null, keys: Collection<String>? = null): List<TicketLink> {
        val where = mutableListOf("key <> ''")
        val args = mutableListOf<Any>()
        teamId?.let { where += "team_id = ?"; args += it }
        if (keys != null) {
            if (keys.isEmpty()) return emptyList()
            where += "key IN (${keys.joinToString(",") { "?" }})"; args.addAll(keys)
        }
        return jdbc.query("SELECT * FROM product_ticket_links WHERE ${where.joinToString(" AND ")} ORDER BY at DESC", { rs, _ -> link(rs) }, *args.toTypedArray())
    }

    /** Branches and commits in [projectIds] with no ticket key, newest first. */
    fun unlinked(projectIds: Collection<String>, limit: Int): List<TicketLink> {
        if (projectIds.isEmpty()) return emptyList()
        return jdbc.query("SELECT * FROM product_ticket_links WHERE key = '' AND project_id IN (${projectIds.joinToString(",") { "?" }}) " +
            "ORDER BY at DESC LIMIT ?", { rs, _ -> link(rs) }, *projectIds.toTypedArray(), limit)
    }

    // ---- teams
    fun paths(teamId: String? = null): List<TeamPath> = (if (teamId == null)
        jdbc.query("SELECT * FROM product_team_paths ORDER BY team_id, project_id, glob") { rs, _ -> path(rs) }
    else jdbc.query("SELECT * FROM product_team_paths WHERE team_id = ? ORDER BY project_id, glob", { rs, _ -> path(rs) }, teamId))

    private fun path(rs: ResultSet) = TeamPath(rs.getString("team_id"), rs.getString("project_id"), rs.getString("glob"), rs.getString("source"))

    private fun team(rs: ResultSet, owns: List<TeamPath>) = Team(
        rs.getString("id"), rs.getString("name"), rs.getString("lead"), rs.getString("jira_project"),
        rs.getObject("capacity_days")?.let { (it as Number).toDouble() },
        parse(rs.getString("members_json"), emptyList()) { mapper.readValue<List<String>>(it) }, rs.getString("source"),
        owns.filter { it.teamId == rs.getString("id") }, rs.getString("created_at"), rs.getString("updated_at"),
        parse(rs.getString("jira_json"), TeamJira()) { mapper.readValue<TeamJira>(it) }, rs.getString("key_pattern"),
    )

    fun teams(): List<Team> {
        val owns = paths()
        return jdbc.query("SELECT * FROM product_teams ORDER BY name") { rs, _ -> team(rs, owns) }
    }

    fun team(id: String): Team? = jdbc.query("SELECT * FROM product_teams WHERE id = ?", { rs, _ -> team(rs, paths(id)) }, id).firstOrNull()

    fun saveTeam(t: Team) {
        jdbc.update(
            "INSERT INTO product_teams(id, name, lead, jira_project, capacity_days, members_json, source, created_at, updated_at, jira_json, key_pattern) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
                "ON CONFLICT(id) DO UPDATE SET name = excluded.name, lead = excluded.lead, jira_project = excluded.jira_project, " +
                "capacity_days = excluded.capacity_days, members_json = excluded.members_json, updated_at = excluded.updated_at, " +
                "jira_json = excluded.jira_json, key_pattern = excluded.key_pattern",
            t.id, t.name, t.lead, t.jiraProject, t.capacityDays, json(t.members), t.source, t.createdAt, t.updatedAt, json(t.jira), t.keyPattern,
        )
    }

    fun setPaths(teamId: String, owns: List<TeamPath>, source: String? = null) {
        if (source == null) jdbc.update("DELETE FROM product_team_paths WHERE team_id = ?", teamId)
        else jdbc.update("DELETE FROM product_team_paths WHERE team_id = ? AND source = ?", teamId, source)
        owns.forEach { jdbc.update("INSERT OR IGNORE INTO product_team_paths(team_id, project_id, glob, source) VALUES (?, ?, ?, ?)", teamId, it.projectId, it.glob, it.source) }
    }

    fun addPath(p: TeamPath) {
        jdbc.update("INSERT OR IGNORE INTO product_team_paths(team_id, project_id, glob, source) VALUES (?, ?, ?, ?)", p.teamId, p.projectId, p.glob, p.source)
    }

    fun removeProject(teamId: String, projectId: String): Int =
        jdbc.update("DELETE FROM product_team_paths WHERE team_id = ? AND project_id = ?", teamId, projectId)

    fun deleteTeam(id: String) {
        jdbc.update("DELETE FROM product_team_paths WHERE team_id = ?", id)
        jdbc.update("DELETE FROM product_team_suggestions WHERE team_id = ?", id)
        jdbc.update("DELETE FROM product_teams WHERE id = ?", id)
    }

    fun suggestions(teamId: String): List<TeamSuggestion> = jdbc.query("SELECT * FROM product_team_suggestions WHERE team_id = ? ORDER BY created_at DESC", { rs, _ ->
        TeamSuggestion(rs.getString("id"), rs.getString("team_id"), rs.getString("page"), rs.getString("text"), rs.getString("source"),
            rs.getString("status"), rs.getString("created_at"), rs.getString("decided_at"))
    }, teamId)

    fun saveSuggestion(s: TeamSuggestion) {
        jdbc.update(
            "INSERT INTO product_team_suggestions(id, team_id, page, text, source, status, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
                "ON CONFLICT(id) DO UPDATE SET status = excluded.status, decided_at = excluded.decided_at",
            s.id, s.teamId, s.page, s.text, s.source, s.status, s.createdAt, s.decidedAt,
        )
    }
}
