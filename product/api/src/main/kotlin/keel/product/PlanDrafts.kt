package keel.product

import com.fasterxml.jackson.databind.ObjectMapper
import keel.api.common.BadRequest
import keel.api.common.Conflict
import keel.api.common.NotFound
import keel.api.common.Time
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
 *
 * 0.18.55 every save is a new plan version, like every other document: the drafts are copied to plan vN+1, the change
 * is made there, the plan is checked again (problems, critical path, totals: PlanCheck) and plan-vN+1.json and .md are
 * one commit in the product repo. One request (one Save in the web) is one version, never one per keystroke.
 */
@Service
class PlanDrafts(private val store: ProductStore, private val projects: ProjectService, private val repo: ProductRepo,
                 private val mapper: ObjectMapper) {
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
        return newVersion(plan, "Changed the story ${p.id}", mapOf("story" to p.id)) { v ->
            next.copy(version = v).also { store.updateItem(it) }
        }
    }

    fun addStory(i: Initiative, b: StoryEdit): PlanItem {
        val plan = open(i)
        val epic = b.epic?.trim() ?: throw BadRequest("Say which epic the story is in")
        if (b.title.isNullOrBlank()) throw BadRequest("Give the story a title")
        val ids = plan.items.map { it.id }.toSet()
        val sid = generateSequence(plan.items.count { it.epic == epic } + 1) { it + 1 }.map { "$epic-S$it" }.first { it !in ids }
        val blank = PlanItem(i.id, plan.version, sid, epic, null, null, "", mapOf("id" to sid), null, null, null)
        val next = apply(plan, blank, b)
        return newVersion(plan, "Added the story $sid", mapOf("story" to sid)) { v ->
            next.copy(version = v).also { store.saveItem(it) }
        }
    }

    fun deleteStory(i: Initiative, sid: String) {
        val plan = open(i)
        unsent(plan.items.firstOrNull { it.id == sid } ?: throw NotFound("No story $sid in the plan of ${i.id}"))
        newVersion(plan, "Took the story $sid out of the plan", mapOf("story" to sid)) { v ->
            store.deleteItem(i.id, v, sid)
            // nothing waits for a story that is gone
            plan.items.filter { sid in strings(it.body["depends_on"]) && it.jiraKey == null && it.taskId == null }.forEach { o ->
                store.updateItem(o.copy(version = v, body = o.body + ("depends_on" to strings(o.body["depends_on"]) - sid)))
            }
        }
    }

    fun editEpic(i: Initiative, eid: String, b: EpicEdit): PlanEpic {
        val plan = open(i)
        val e = epic(plan, eid)
        if (plan.items.any { it.epic == eid && it.jiraKey != null } && b.team != null && b.team != e.team) {
            throw Conflict("Stories of $eid are in Jira already", "Its team's Jira project would change: make a new epic instead.")
        }
        val next = e.copy(title = b.title?.trim()?.ifEmpty { null }?.take(300) ?: e.title, team = b.team?.let { team(it) } ?: e.team)
        return newVersion(plan, "Changed the epic $eid", mapOf("epic" to eid)) { v ->
            store.saveEpic(next.copy(version = v))
            // its stories follow the epic's team
            plan.items.filter { it.epic == eid && it.jiraKey == null && it.taskId == null }.forEach { store.updateItem(it.copy(version = v, team = next.team)) }
            next.copy(version = v)
        }
    }

    fun addEpic(i: Initiative, b: EpicEdit): PlanEpic {
        val plan = open(i)
        val team = b.team?.let { team(it) }
        val title = b.title?.trim()?.ifEmpty { null } ?: throw BadRequest("Give the epic a title")
        val base = b.id?.trim()?.uppercase() ?: team?.let { t -> t.replace(Regex("[^A-Za-z0-9]"), "").uppercase().take(4).ifEmpty { null } } ?: "EP"
        if (!ID.matches(base)) throw BadRequest("An epic id is capital letters and digits", "Like PAY.")
        val taken = (plan.epics.map { it.id } + plan.items.map { it.epic }).toSet()
        val id = if (base !in taken) base else generateSequence(2) { it + 1 }.map { "$base$it" }.first { it !in taken }
        return newVersion(plan, "Added the epic $id", mapOf("epic" to id)) { v ->
            PlanEpic(i.id, v, id, team, title.take(300)).also { store.saveEpic(it) }
        }
    }

    fun deleteEpic(i: Initiative, eid: String) {
        val plan = open(i)
        epic(plan, eid)
        if (plan.items.any { it.epic == eid }) throw Conflict("The epic $eid has stories", "Move or take out its stories first.")
        newVersion(plan, "Took the epic $eid out of the plan", mapOf("epic" to eid)) { v -> store.deleteEpic(i.id, v, eid) }
    }

    // ---------------------------------------------------------------- versions

    /**
     * One save action = one new plan version. The drafts of [plan] are copied to the next version, [change] makes the
     * edit there (the change is checked before: a refused edit makes no version), then the plan is checked again and
     * written. Version numbers count the product repo's files too (the engine numbers its versions by them).
     */
    private fun <T> newVersion(plan: Plan, what: String, data: Map<String, Any?>, change: (Int) -> T): T {
        val id = plan.i.id
        val files = repo.list("initiatives/$id").mapNotNull { Regex("^plan-v(\\d+)\\.").find(it)?.groupValues?.get(1)?.toIntOrNull() }
        val v = maxOf(plan.version, store.planRowsVersion(id), files.maxOrNull() ?: 0) + 1
        plan.epics.forEach { store.saveEpic(it.copy(version = v)) }
        plan.items.forEach { store.saveItem(it.copy(version = v)) }
        val out = change(v)
        val result = PlanCheck.check(planOf(store.epics(id, v), store.items(id, v)))
        val dir = "initiatives/$id"
        val sha = repo.writeAll(
            mapOf("$dir/plan-v$v.json" to mapper.writerWithDefaultPrettyPrinter().writeValueAsString(result["plan"]),
                  "$dir/plan-v$v.md" to PlanCheck.markdown(result)),
            "$id: plan v$v (by hand: $what)",
        )
        val before = store.doc(id, "plan", plan.version)
        store.saveDoc(ProductDoc(id, "plan", v, "$dir/plan-v$v.json", sha, PlanCheck.summary(result),
            result + mapOf("version" to v, "path" to "$dir/plan-v$v.json", "sha" to sha, "edited" to true, "from" to plan.version),
            null, Time.now(), before?.approvedAt))
        store.event(id, InitiativeService.YOU, "edited", "$what (plan v$v)", mapOf("version" to v, "from" to plan.version) + data)
        return out
    }

    /** The plan as the engine writes it ({epics: [{id, team, title, stories: [...]}]}) from the drafts of one version. */
    private fun planOf(epics: List<PlanEpic>, items: List<PlanItem>): Map<String, Any?> {
        val byEpic = items.groupBy { it.epic }
        val ids = (epics.map { it.id } + byEpic.keys).distinct()
        return mapOf("epics" to ids.map { eid ->
            val e = epics.firstOrNull { it.id == eid }
            val list = byEpic[eid].orEmpty()
            val team = e?.team ?: list.firstOrNull()?.team
            linkedMapOf("id" to eid, "team" to team, "title" to (e?.title ?: eid), "stories" to list.map { p ->
                LinkedHashMap(p.body).apply {
                    put("id", p.id)
                    put("title", p.title)
                    put("repo", p.repo)
                    if (p.team != null && p.team != team) put("team", p.team) else remove("team")
                }
            })
        })
    }

    // ---------------------------------------------------------------- checks

    private fun epic(plan: Plan, eid: String): PlanEpic = plan.epics.firstOrNull { it.id == eid }
        ?: plan.items.firstOrNull { it.epic == eid }?.let { PlanEpic(plan.i.id, plan.version, eid, it.team, eid) }
        ?: throw NotFound("No epic $eid in the plan of ${plan.i.id}")

    private fun team(ref: String): String? = ref.trim().ifEmpty { null }?.let { r ->
        (store.team(r) ?: store.teams().firstOrNull { it.name.equals(r, true) })?.id ?: throw NotFound("No team $r")
    }

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
        // "" takes the story's team away; a team is named by its id or its name (an agent's plan may use the name)
        val team = if (b.team != null) team(b.team) else epic?.team ?: p.team
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
