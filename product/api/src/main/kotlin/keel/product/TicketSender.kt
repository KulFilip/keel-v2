package keel.product

import keel.api.common.BadRequest
import keel.api.common.Conflict
import keel.api.common.NotFound
import keel.api.common.Time
import keel.api.jira.JiraClient
import keel.api.jira.JiraException
import keel.api.jira.JiraIssueType
import keel.api.jira.JiraService
import keel.api.projects.ProjectService
import org.springframework.stereotype.Service

/** Where an initiative's own Jira ticket goes (Product › Teams › Initiatives in Jira). Unset = no initiative ticket. */
data class InitiativeJira(
    /** The keel project whose connection it uses; null = the keel-wide connection. */
    val connection: String? = null,
    val project: String? = null,
    val type: String? = null,
)

/** One ticket of the tree as it will be (or was) sent. */
data class TicketRow(
    /** initiative | epic | story | subtask */
    val level: String,
    /** INI-7, the epic id (PAY), the story id (PAY-S1), "PAY-S1/2" for a story's 2nd sub-task */
    val ref: String,
    val title: String,
    val team: String?,
    /** The Jira project key, the site and the issue type it goes to; null when it cannot go (see [problem]). */
    val project: String?,
    val site: String?,
    val type: String?,
    /** The ref of the ticket above it (an epic for a story). */
    val parent: String?,
    /** Its key when it is in Jira already. */
    val key: String?,
    /** create | exists | blocked */
    val action: String,
    val problem: String? = null,
)

data class TicketPreview(val rows: List<TicketRow>, val problems: List<String>, val notes: List<String>) {
    val creates get() = rows.count { it.action == "create" }
    val ok get() = problems.isEmpty()
}

data class SendResult(val created: List<TicketRow>, val jira: List<String>, val notes: List<String>, val preview: TicketPreview)

/**
 * keel Product's ticket tree in Jira: Initiative (optional) → Epic (one per plan epic) → Story → Sub-task, sent top-down.
 * [preview] says what would be made where and every problem first; [send] makes it and keeps each key (stories on their
 * plan item, the initiative and the epics in product_tickets), so a second send never makes a twin.
 *
 * Where a ticket goes: the epic's team picks the connection (its [TeamJira.connection], else the keel-wide one, else —
 * as before teams had their own Jira — the story's repo's own connection) and the project key (the team's, else that
 * connection's). The issue types are the team's, else found in the project (Initiative when the project has a type
 * above epics, Epic, Story, its sub-task type). A story names its epic with `parent` on Cloud and the Epic Link field on
 * Server; when Jira refuses the link the story goes alone and the send says so.
 */
@Service
class TicketSender(
    private val store: ProductStore,
    private val jira: JiraService,
    private val projects: ProjectService,
) {
    companion object {
        const val INITIATIVE_JIRA = "initiative_jira"
    }

    private data class Target(val client: JiraClient, val project: String, val types: Types, val team: Team?)

    private data class Types(val initiative: String?, val epic: String?, val story: String, val subtask: String?, val epicLink: String?)

    fun initiativeJira(): InitiativeJira = store.setting(INITIATIVE_JIRA, InitiativeJira::class.java) ?: InitiativeJira()

    fun saveInitiativeJira(b: InitiativeJira): InitiativeJira {
        val connection = b.connection?.trim()?.ifEmpty { null }?.also { projects.require(it) }
        val project = b.project?.trim()?.uppercase()?.ifEmpty { null }
        if (project != null && !Regex("^[A-Z][A-Z0-9_]{0,29}$").matches(project)) throw BadRequest("The Jira project key is not valid", "Like PORT.")
        val v = InitiativeJira(connection, project, b.type?.trim()?.ifEmpty { null }?.take(60))
        store.saveSetting(INITIATIVE_JIRA, v.takeIf { it.project != null })
        return initiativeJira()
    }

    fun preview(i: Initiative, stories: List<String> = emptyList()): TicketPreview = plan(i, stories, dry = true).preview

    fun send(i: Initiative, stories: List<String> = emptyList()): SendResult {
        if (i.stage != "delivery") throw Conflict("The plan of ${i.id} is not agreed yet", "The leads agree the plan first.")
        return plan(i, stories, dry = false)
    }

    // ---------------------------------------------------------------- the one walk for preview and send

    private fun plan(i: Initiative, only: List<String>, dry: Boolean): SendResult {
        val doc = store.latest(i.id, "plan") ?: throw NotFound("${i.id} has no plan")
        val all = store.items(i.id, doc.version)
        val unknown = only - all.map { it.id }.toSet()
        if (unknown.isNotEmpty()) throw BadRequest("No story ${unknown.joinToString()} in the plan of ${i.id}")
        val items = if (only.isEmpty()) all else all.filter { it.id in only }
        val epics = store.epics(i.id, doc.version).associateBy { it.id }
        val rows = mutableListOf<TicketRow>()
        val problems = mutableListOf<String>()
        val notes = mutableListOf<String>()
        val created = mutableListOf<TicketRow>()
        val keys = mutableListOf<String>()
        val types = mutableMapOf<String, List<JiraIssueType>?>()
        val epicLinks = mutableMapOf<String, String?>()
        val clients = mutableMapOf<String, JiraClient>()       // story id → the client it went with (for the links)

        fun typesOf(c: JiraClient, project: String): List<JiraIssueType>? = types.getOrPut("${c.base}|$project") {
            runCatching { c.projectIssueTypes(project) }.getOrElse { ex ->
                notes += "$project: keel could not list its issue types (${msg(ex)}); it uses Epic, Story and Sub-task"
                null
            }
        }

        fun epicLinkOf(c: JiraClient): String? = if (c.cloud) null else epicLinks.getOrPut(c.base) {
            runCatching { c.fields().firstOrNull { it.custom && it.name.equals("Epic Link", true) }?.id }.getOrNull()
        }

        fun target(team: Team?, pids: List<String>): Pair<Target?, String?> {
            val conn = team?.jira?.connection
            val client = jira.siteClient(conn) ?: pids.firstNotNullOfOrNull { jira.client(it) }
                ?: return null to (if (conn != null) "the team's Jira connection (project $conn) is not set up" else "keel has no Jira connection for it " +
                    "(set the keel-wide one, or the team's)")
            val settings = jira.siteSettings(conn)?.takeIf { jira.siteClient(conn) != null } ?: pids.firstNotNullOfOrNull { p -> jira.settings(p)?.takeIf { jira.client(p) != null } }
            val project = team?.jiraProject ?: settings?.projectKey
                ?: return null to "no Jira project (set it on the team ${team?.name ?: "?"})"
            val found = typesOf(client, project)
            fun pick(own: String?, wanted: List<String>, alt: (JiraIssueType) -> Boolean): String? = own
                ?: found?.let { t -> wanted.firstNotNullOfOrNull { w -> t.firstOrNull { it.name.equals(w, true) }?.name } ?: t.firstOrNull(alt)?.name }
            val j = team?.jira ?: TeamJira()
            val t = Types(
                initiative = pick(j.initiativeType, listOf("Initiative")) { (it.level ?: 0) >= 2 },
                epic = pick(j.epicType, listOf("Epic")) { it.level == 1 } ?: "Epic".takeIf { found == null },
                story = pick(j.storyType, listOf("Story", "Task")) { !it.subtask && (it.level ?: 0) == 0 } ?: "Story",
                subtask = pick(j.subtaskType, listOf("Sub-task", "Subtask")) { it.subtask } ?: "Sub-task".takeIf { found == null },
                epicLink = j.epicLinkField ?: epicLinkOf(client),
            )
            return Target(client, project, t, team) to null
        }

        // the initiative's own ticket, when keel Product says where it goes
        val ij = initiativeJira()
        var initiativeKey: String? = null
        var initiativeSite: String? = null
        if (ij.project != null) {
            val client = jira.siteClient(ij.connection)
            val type = client?.let { c -> ij.type ?: typesOf(c, ij.project)?.let { t -> t.firstOrNull { it.name.equals("Initiative", true) }?.name ?: t.firstOrNull { (it.level ?: 0) >= 2 }?.name } }
            val have = client?.let { store.ticket(i.id, "initiative", i.id, it.base, ij.project) }
            val row = TicketRow("initiative", i.id, "${i.id} · ${i.title}", null, ij.project, client?.base, type, null, have?.jiraKey,
                when {
                    have != null -> "exists"
                    client == null || type == null -> "blocked"
                    else -> "create"
                },
                when {
                    client == null -> "the initiative's Jira connection is not set up"
                    type == null && have == null -> "the project ${ij.project} has no Initiative issue type"
                    else -> null
                })
            row.problem?.let { problems += "${i.id}: $it" }
            if (row.action == "create" && !dry && client != null && type != null) {
                runCatching { create(client, ij.project, type, row.title, initiativeText(i), labels(i, null), null, null) }
                    .onSuccess { k ->
                        store.saveTicket(JiraTicket(i.id, "initiative", i.id, client.base, ij.project, k, Time.now()))
                        keys += k
                        created += row.copy(key = k, action = "exists")
                    }
                    .onFailure { ex -> notes += "${i.id}: Jira refused the Initiative (${msg(ex)})" }
            }
            initiativeKey = store.ticket(i.id, "initiative", i.id, client?.base ?: "", ij.project)?.jiraKey ?: have?.jiraKey
            initiativeSite = client?.base
            rows += row.copy(key = initiativeKey ?: row.key)
        }

        for ((epicId, list) in items.groupBy { it.epic }) {
            val e = epics[epicId]
            val teamId = e?.team ?: list.first().team
            val team = teamId?.let { store.team(it) }
            val (t, why) = target(team, list.mapNotNull { it.projectId })
            val epicTitle = "${i.id} · $epicId · ${e?.title ?: i.title}"
            if (t == null) {
                problems += "epic $epicId: $why"
                rows += TicketRow("epic", epicId, epicTitle, teamId, null, null, null, i.id.takeIf { initiativeKey != null }, null, "blocked", why)
                list.forEach { p -> rows += storyRow(p, null, null, epicId, "blocked", why) }
                continue
            }
            val site = t.client.base
            val have = store.ticket(i.id, "epic", epicId, site, t.project)?.jiraKey
            var epicKey = have
            val epicRow = TicketRow("epic", epicId, epicTitle, teamId, t.project, site, t.types.epic, i.id.takeIf { initiativeKey != null }, have,
                when {
                    have != null -> "exists"
                    t.types.epic == null -> "blocked"
                    else -> "create"
                }, if (have == null && t.types.epic == null) "the project ${t.project} has no Epic issue type" else null)
            epicRow.problem?.let { problems += "epic $epicId: $it" }
            if (epicRow.action == "create" && !dry) {
                // the epic under the initiative: parent on Cloud (when the hierarchy allows it), Parent Link is Server's own business
                val up = initiativeKey?.takeIf { initiativeSite == site && t.client.cloud }
                epicKey = runCatching { create(t.client, t.project, t.types.epic!!, epicTitle, "Part of ${i.id}: ${i.idea}", labels(i, team), up, null, team) }
                    .recoverCatching { ex ->
                        if (up == null) throw ex
                        create(t.client, t.project, t.types.epic!!, epicTitle, "Part of ${i.id}: ${i.idea}", labels(i, team), null, null, team)
                            .also { notes += "epic $epicId: sent without its initiative $up (Jira refused the link: ${msg(ex)})" }
                    }
                    .onSuccess { k ->
                        store.saveTicket(JiraTicket(i.id, "epic", epicId, site, t.project, k, Time.now()))
                        keys += k
                        created += epicRow.copy(key = k, action = "exists")
                    }
                    .getOrElse { ex ->
                        notes += "epic $epicId: Jira refused an Epic (${msg(ex)}), the stories go without one"
                        null
                    }
            }
            rows += epicRow.copy(key = epicKey ?: have)

            for (p in list) {
                if (p.jiraKey != null) {
                    rows += storyRow(p, t, p.jiraKey, epicId, "exists", null)
                    continue
                }
                val criteria = strings(p.body["criteria"])
                rows += storyRow(p, t, null, epicId, "create", null)
                if (criteria.isEmpty()) notes += "${p.id}: no acceptance criteria"
                strings(p.body["tasks"]).forEachIndexed { n, task ->
                    rows += TicketRow("subtask", "${p.id}/${n + 1}", task.take(250), teamId, t.project, site, t.types.subtask, p.id, null,
                        if (t.types.subtask == null) "blocked" else "create", if (t.types.subtask == null) "the project ${t.project} has no sub-task type" else null)
                }
                if (dry) continue
                val key = sendStory(i, p, t, team, epicKey, notes) ?: continue
                clients[p.id] = t.client
                keys += key
                created += storyRow(p, t, key, epicId, "exists", null)
                val saved = p.copy(jiraKey = key)
                store.saveItem(saved)
                if (t.types.subtask != null) {
                    strings(p.body["tasks"]).forEachIndexed { n, task ->
                        runCatching { create(t.client, t.project, t.types.subtask, task.take(250), "", labels(i, team), key, null, team) }
                            .onSuccess { k ->
                                keys += k
                                created += TicketRow("subtask", "${p.id}/${n + 1}", task.take(250), teamId, t.project, site, t.types.subtask, p.id, k, "exists")
                            }
                            .onFailure { ex -> notes += "${p.id} sub-task: ${msg(ex)}" }
                    }
                }
            }
        }
        rows.filter { it.level == "subtask" && it.problem != null }.map { it.problem!! }.distinct().forEach { problems += it }

        if (!dry) {
            // what waits for what, once every story of this send has its key
            val byStory = store.items(i.id, doc.version).associate { it.id to it.jiraKey }
            val made = created.filter { it.level == "story" }.map { it.ref }.toSet()
            for (p in items.filter { it.id in made }) {
                val key = byStory[p.id] ?: continue
                val client = clients[p.id] ?: continue
                for (dep in strings(p.body["depends_on"])) {
                    val before = byStory[dep] ?: continue
                    runCatching { client.linkIssues("Blocks", key, before) }.onFailure { ex -> notes += "${p.id} waits for $dep: ${msg(ex)}" }
                }
            }
        }
        val preview = TicketPreview(rows, problems.distinct(), notes.distinct())
        if (!dry && keys.isNotEmpty()) store.event(i.id, InitiativeService.YOU, "jira", "Sent ${keys.size} tickets to Jira", mapOf("keys" to keys))
        return SendResult(created, keys, (problems + notes).distinct(), preview)
    }

    private fun storyRow(p: PlanItem, t: Target?, key: String?, epic: String, action: String, why: String?) =
        TicketRow("story", p.id, "${p.id} · ${p.title}", p.team, t?.project, t?.client?.base, t?.types?.story, epic, key, action, why)

    private fun sendStory(i: Initiative, p: PlanItem, t: Target, team: Team?, epicKey: String?, notes: MutableList<String>): String? {
        val summary = "${p.id} · ${p.title}"
        val text = storyText(i, p)
        var made = runCatching { create(t.client, t.project, t.types.story, summary, text, labels(i, team), epicKey.takeIf { t.client.cloud }, epicKey?.takeIf { !t.client.cloud }?.let { k -> t.types.epicLink?.let { it to k } }, team) }
        if (made.isFailure && epicKey != null) {
            // Jira took neither parent nor Epic Link: the story goes alone, and the send says so
            val refused = msg(made.exceptionOrNull()!!)
            made = runCatching { create(t.client, t.project, t.types.story, summary, text, labels(i, team), null, null, team) }
            if (made.isSuccess) notes += "${p.id}: sent without its epic $epicKey (Jira refused the link: $refused)"
        } else if (made.isSuccess && epicKey != null && !t.client.cloud && t.types.epicLink == null) {
            notes += "${p.id}: sent without its epic $epicKey (this Jira has no Epic Link field; set it on the team)"
        }
        return made.getOrElse { ex ->
            notes += "${p.id}: ${msg(ex)}"
            null
        }
    }

    private fun labels(i: Initiative, team: Team?): List<String> = (listOf(i.id) + team?.jira?.labels.orEmpty()).distinct()

    private fun create(c: JiraClient, project: String, type: String, summary: String, description: String, labels: List<String>, parent: String?,
                       field: Pair<String, String>?, team: Team? = null): String {
        val component = team?.jira?.component
        val fields = linkedMapOf<String, Any?>("project" to mapOf("key" to project), "issuetype" to mapOf("name" to type), "summary" to summary.take(250),
            "description" to description, "labels" to labels)
        parent?.let { fields["parent"] = mapOf("key" to it) }
        field?.let { (id, key) -> fields[id] = key }
        component?.let { fields["components"] = listOf(mapOf("name" to it)) }
        return c.createIssue(fields)
    }

    private fun initiativeText(i: Initiative) = buildString {
        append(i.idea).append("\n")
        i.whyNow?.takeIf { it.isNotBlank() }?.let { append("\nWhy now: $it\n") }
        i.outcomeHope?.takeIf { it.isNotBlank() }?.let { append("Outcome hoped for: $it\n") }
        append("\nkeel Product ${i.id}")
    }

    private fun msg(ex: Throwable) = when (ex) {
        is JiraException -> ex.message
        else -> ex.message ?: ex.javaClass.simpleName
    }.take(200)

    private fun strings(v: Any?): List<String> = (v as? List<*>).orEmpty().mapNotNull { it?.toString()?.takeIf { s -> s.isNotBlank() } }
}
