package keel.product

import keel.api.common.BadRequest
import keel.api.common.Conflict
import keel.api.common.NotFound
import keel.api.projects.ProjectService
import org.springframework.stereotype.Service

/** A change to a story draft: null keeps a field. */
data class StoryEdit(
    val epic: String? = null,
    val title: String? = null,
    val criteria: List<String>? = null,
    val tasks: List<String>? = null,
    val dependsOn: List<String>? = null,
    val estimateDays: List<Double>? = null,
    val team: String? = null,
    val repo: String? = null,
)

/** A change to an epic draft; [id] only when it is made (else from the team, like the plan's). */
data class EpicEdit(val id: String? = null, val title: String? = null, val team: String? = null)

/**
 * The plan's epics and stories as drafts: the product manager edits them while the leads look at the plan and after
 * they agreed it, until a story is sent (to Jira or keel Tasks: then Jira or the task is where it changes). Every
 * change is an event in the initiative's history.
 */
@Service
class PlanDrafts(private val store: ProductStore, private val projects: ProjectService) {
    companion object {
        private val CRITERION = Regex("^AC-\\d+\\s*\\[\\w+]\\s*\\S.*")
        private val ID = Regex("^[A-Z][A-Z0-9]{0,9}$")
    }

    private data class Plan(val i: Initiative, val version: Int, val items: List<PlanItem>, val epics: List<PlanEpic>)

    private fun open(i: Initiative): Plan {
        val doc = store.latest(i.id, "plan") ?: throw NotFound("${i.id} has no plan yet")
        val editable = i.stage == "delivery" || (i.stage == "plan" && i.status == "waiting")
        if (!editable) throw Conflict("The plan of ${i.id} cannot be edited now", "Edit it while the leads look at it, or after they agreed it.")
        return Plan(i, doc.version, store.items(i.id, doc.version), store.epics(i.id, doc.version))
    }

    private fun unsent(p: PlanItem): PlanItem {
        p.jiraKey?.let { throw Conflict("${p.id} is in Jira already ($it)", "Change it in Jira.") }
        p.taskId?.let { throw Conflict("${p.id} is a keel task already ($it)", "Change the task.") }
        return p
    }

    fun editStory(i: Initiative, sid: String, b: StoryEdit): PlanItem {
        val plan = open(i)
        val p = unsent(plan.items.firstOrNull { it.id == sid } ?: throw NotFound("No story $sid in the plan of ${i.id}"))
        val next = apply(plan, p, b)
        store.updateItem(next)
        store.event(i.id, InitiativeService.YOU, "edited", "Changed the story ${p.id}", mapOf("version" to plan.version, "story" to p.id))
        return next
    }

    fun addStory(i: Initiative, b: StoryEdit): PlanItem {
        val plan = open(i)
        val epic = b.epic?.trim() ?: throw BadRequest("Say which epic the story is in")
        if (b.title.isNullOrBlank()) throw BadRequest("Give the story a title")
        val ids = plan.items.map { it.id }.toSet()
        val sid = generateSequence(plan.items.count { it.epic == epic } + 1) { it + 1 }.map { "$epic-S$it" }.first { it !in ids }
        val blank = PlanItem(i.id, plan.version, sid, epic, null, null, "", emptyMap(), null, null, null)
        val next = apply(plan, blank, b)
        store.saveItem(next)
        store.event(i.id, InitiativeService.YOU, "edited", "Added the story $sid", mapOf("version" to plan.version, "story" to sid))
        return next
    }

    fun deleteStory(i: Initiative, sid: String) {
        val plan = open(i)
        unsent(plan.items.firstOrNull { it.id == sid } ?: throw NotFound("No story $sid in the plan of ${i.id}"))
        store.deleteItem(i.id, plan.version, sid)
        // nothing waits for a story that is gone
        plan.items.filter { sid in strings(it.body["depends_on"]) && it.jiraKey == null && it.taskId == null }.forEach { o ->
            store.updateItem(o.copy(body = o.body + ("depends_on" to strings(o.body["depends_on"]) - sid)))
        }
        store.event(i.id, InitiativeService.YOU, "edited", "Took the story $sid out of the plan", mapOf("version" to plan.version, "story" to sid))
    }

    fun editEpic(i: Initiative, eid: String, b: EpicEdit): PlanEpic {
        val plan = open(i)
        val e = epic(plan, eid)
        if (plan.items.any { it.epic == eid && it.jiraKey != null } && b.team != null && b.team != e.team) {
            throw Conflict("Stories of $eid are in Jira already", "Its team's Jira project would change: make a new epic instead.")
        }
        val next = e.copy(title = b.title?.trim()?.ifEmpty { null }?.take(300) ?: e.title, team = b.team?.let { team(it) } ?: e.team)
        store.saveEpic(next)
        // its stories follow the epic's team
        plan.items.filter { it.epic == eid && it.jiraKey == null && it.taskId == null }.forEach { store.updateItem(it.copy(team = next.team)) }
        store.event(i.id, InitiativeService.YOU, "edited", "Changed the epic $eid", mapOf("version" to plan.version, "epic" to eid))
        return next
    }

    fun addEpic(i: Initiative, b: EpicEdit): PlanEpic {
        val plan = open(i)
        val team = b.team?.let { team(it) }
        val title = b.title?.trim()?.ifEmpty { null } ?: throw BadRequest("Give the epic a title")
        val base = b.id?.trim()?.uppercase() ?: team?.let { t -> t.replace(Regex("[^A-Za-z0-9]"), "").uppercase().take(4).ifEmpty { null } } ?: "EP"
        if (!ID.matches(base)) throw BadRequest("An epic id is capital letters and digits", "Like PAY.")
        val taken = (plan.epics.map { it.id } + plan.items.map { it.epic }).toSet()
        val id = if (base !in taken) base else generateSequence(2) { it + 1 }.map { "$base$it" }.first { it !in taken }
        val e = PlanEpic(i.id, plan.version, id, team, title.take(300))
        store.saveEpic(e)
        store.event(i.id, InitiativeService.YOU, "edited", "Added the epic $id", mapOf("version" to plan.version, "epic" to id))
        return e
    }

    fun deleteEpic(i: Initiative, eid: String) {
        val plan = open(i)
        epic(plan, eid)
        if (plan.items.any { it.epic == eid }) throw Conflict("The epic $eid has stories", "Move or take out its stories first.")
        store.deleteEpic(i.id, plan.version, eid)
        store.event(i.id, InitiativeService.YOU, "edited", "Took the epic $eid out of the plan", mapOf("version" to plan.version, "epic" to eid))
    }

    // ---------------------------------------------------------------- checks

    private fun epic(plan: Plan, eid: String): PlanEpic = plan.epics.firstOrNull { it.id == eid }
        ?: plan.items.firstOrNull { it.epic == eid }?.let { PlanEpic(plan.i.id, plan.version, eid, it.team, eid) }
        ?: throw NotFound("No epic $eid in the plan of ${plan.i.id}")

    private fun team(id: String): String? = id.trim().ifEmpty { null }?.also { store.team(it) ?: throw NotFound("No team $it") }

    private fun apply(plan: Plan, p: PlanItem, b: StoryEdit): PlanItem {
        val epic = b.epic?.trim()?.let { epic(plan, it) }
        val title = b.title?.trim()?.ifEmpty { throw BadRequest("A story needs a title") }?.take(300) ?: p.title
        val criteria = b.criteria?.map { it.trim() }?.filter { it.isNotEmpty() }?.also { c ->
            if (c.size > 10) throw BadRequest("At most 10 criteria")
            c.firstOrNull { !CRITERION.matches(it) }?.let { throw BadRequest("\"$it\" is not a criterion", "Like: AC-1 [API] GET /prices returns the currency.") }
        }
        val tasks = b.tasks?.map { it.trim() }?.filter { it.isNotEmpty() }?.also { if (it.size > 10) throw BadRequest("At most 10 tasks") }
        val ids = plan.items.map { it.id }.toSet()
        val deps = b.dependsOn?.map { it.trim() }?.filter { it.isNotEmpty() }?.distinct()?.also { d ->
            d.firstOrNull { it !in ids }?.let { throw BadRequest("No story $it in the plan") }
            if (p.id in d) throw BadRequest("A story cannot wait for itself")
            if (waitsFor(plan.items, d, p.id)) throw BadRequest("That makes a loop: ${p.id} would wait for a story that waits for it")
        }
        val est = b.estimateDays?.also { e ->
            if (e.isEmpty() || e.size > 2 || e.any { it < 0 || it > 200 }) throw BadRequest("The estimate is one or two numbers of days", "Like [2, 3].")
        }
        val repo = b.repo?.trim()?.ifEmpty { null }
        val pid = when {
            b.repo == null -> p.projectId
            repo == null -> null
            else -> projects.rows().let { rows -> (rows.firstOrNull { it.id == repo } ?: rows.firstOrNull { it.name.equals(repo, true) })?.id }
                ?: throw NotFound("No keel project $repo")
        }
        val body = p.body.toMutableMap()
        body["title"] = title
        criteria?.let { body["criteria"] = it }
        tasks?.let { body["tasks"] = it }
        deps?.let { body["depends_on"] = it }
        est?.let { body["estimate_days"] = if (it.size == 1) listOf(it[0], it[0]) else listOf(it.min(), it.max()) }
        if (b.repo != null) body["repo"] = repo
        val team = b.team?.let { team(it) } ?: epic?.team ?: p.team
        return p.copy(epic = epic?.id ?: p.epic, team = team, repo = if (b.repo != null) repo else p.repo, title = title, body = body, projectId = pid)
    }

    /** Whether one of [deps] (directly or further down) waits for [sid]. */
    private fun waitsFor(items: List<PlanItem>, deps: List<String>, sid: String): Boolean {
        val next = items.associate { it.id to strings(it.body["depends_on"]) }
        val seen = mutableSetOf<String>()
        val todo = ArrayDeque(deps)
        while (todo.isNotEmpty()) {
            val d = todo.removeFirst()
            if (d == sid) return true
            if (seen.add(d)) todo.addAll(next[d].orEmpty())
        }
        return false
    }

    private fun strings(v: Any?): List<String> = (v as? List<*>).orEmpty().mapNotNull { it?.toString()?.takeIf { s -> s.isNotBlank() } }
}
