package keel.product

import keel.api.common.BadRequest
import keel.api.common.NotFound
import keel.api.common.Time
import keel.api.tasks.Task
import keel.api.tasks.TaskStore
import org.springframework.stereotype.Service

/** What a product manager links: tasks by id, or tickets by key (a task on a Tasks board must have it). */
data class LinkBody(val tasks: List<String>? = null, val keys: List<String>? = null)

/**
 * A ticket on a team's Tasks board (a Jira ticket the Jira plugin synced, or a local task), as keel Product shows it:
 * its live title and status, the initiatives it belongs to, and the work keel found for its key in git.
 */
data class LinkedTicket(
    /** The Jira key; a local task's id when it has none. */
    val key: String,
    val projectId: String?,
    val taskId: String?,
    val title: String?,
    /** keel's task status (todo, in_progress, …); null when no Tasks board has it now. */
    val status: String?,
    val externalStatus: String?,
    val url: String?,
    val assignee: String?,
    /** jira | local */
    val source: String?,
    val onBoard: Boolean,
    val initiatives: List<String>,
    val branches: Int,
    val commits: Int,
    val lastAt: String?,
    /** When it was linked to the initiative (null in candidate and board lists). */
    val addedAt: String? = null,
)

/**
 * B6 (docs/plans/product-link-tickets.md): the tickets already on the teams' Tasks boards, linked to an initiative by
 * hand. keel keeps only the link; the title and the status come from the Tasks board each time. Nothing changes in Jira.
 */
@Service
class InitiativeTickets(
    private val store: ProductStore,
    private val tasks: TaskStore,
    private val links: TicketLinks,
    private val teams: TeamService,
) {
    companion object {
        const val MAX_LINK = 50
        const val MAX_LIST = 50
        const val MAX_BOARD = 200
        private val KEY = Regex("^[A-Za-z][A-Za-z0-9_]{0,29}-\\d{1,9}$")
    }

    /** The key keel files a task under: its Jira key, else its own id. */
    private fun keyOf(t: Task) = t.externalKey ?: t.id

    /** The projects keel Product reads (not the product repo itself, not hidden ones). */
    private fun readable(): List<String> = teams.repoOwners().map { it.projectId }

    private fun view(key: String, t: Task?, initiatives: List<String>, work: TicketWork?, projectId: String? = null, taskId: String? = null,
                     addedAt: String? = null) = LinkedTicket(
        key, t?.projectId ?: projectId, t?.id ?: taskId, t?.title, t?.status, t?.externalStatus, t?.externalUrl, t?.assignee, t?.source,
        t != null, initiatives, work?.branches?.size ?: 0, work?.commits?.size ?: 0, work?.lastAt, addedAt,
    )

    private fun byInitiative(): Map<String, List<String>> =
        store.initiativeTickets().groupBy({ it.key }, { it.initiativeId }).mapValues { (_, v) -> v.distinct() }

    /** The task behind a link: by its id, else by its key on its project's board. */
    private fun taskOf(l: InitiativeTicket): Task? =
        l.taskId?.let { tasks.find(it) } ?: l.projectId?.let { tasks.byKey(it, l.key) }

    fun list(i: Initiative): List<LinkedTicket> {
        val linked = store.initiativeTickets(i.id)
        if (linked.isEmpty()) return emptyList()
        val all = byInitiative()
        val work = links.forKeys(linked.map { it.key })
        return linked.map { l -> view(l.key, taskOf(l), all[l.key].orEmpty(), work[l.key], l.projectId, l.taskId, l.addedAt) }
    }

    /** Tickets on the Tasks boards not linked to [i] yet: its repos' boards (every project with [all]), matching [q]. */
    fun candidates(i: Initiative, q: String?, all: Boolean): List<LinkedTicket> {
        val mine = store.initiativeTickets(i.id).map { it.key }.toSet()
        val pids = if (all || i.repos.isEmpty()) readable() else i.repos.filter { it in readable() }.ifEmpty { readable() }
        val needle = q?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
        val found = pids.asSequence().flatMap { tasks.list(it).asSequence() }
            .filter { keyOf(it) !in mine && it.status != "cancelled" }
            .filter { t -> needle == null || keyOf(t).lowercase().contains(needle) || t.title.lowercase().contains(needle) }
            .sortedByDescending { it.updatedAt }.take(MAX_LIST).toList()
        val by = byInitiative()
        val work = links.forKeys(found.mapNotNull { it.externalKey })
        return found.map { t -> view(keyOf(t), t, by[keyOf(t)].orEmpty(), work[keyOf(t)]) }
    }

    fun link(i: Initiative, b: LinkBody): List<LinkedTicket> {
        val ids = b.tasks.orEmpty().map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        val keys = b.keys.orEmpty().map { it.trim().uppercase() }.filter { it.isNotEmpty() }.distinct()
        if (ids.isEmpty() && keys.isEmpty()) throw BadRequest("Name the tickets to link", "Send tasks (task ids) or keys (like SHOPS-1234).")
        if (ids.size + keys.size > MAX_LINK) throw BadRequest("At most $MAX_LINK tickets at once")
        keys.firstOrNull { !KEY.matches(it) }?.let { throw BadRequest("\"$it\" is not a ticket key", "Like SHOPS-1234.") }
        val pids = readable()
        val found = ids.map { id -> tasks.find(id) ?: throw NotFound("No task $id", "Pick it again from Add tickets.") } +
            keys.map { k ->
                pids.firstNotNullOfOrNull { tasks.byKey(it, k) }
                    ?: throw NotFound("No Tasks board has $k", "Sync Jira on the project's Tasks board first, or check the key.")
            }
        val now = Time.now()
        found.forEach { t -> store.linkTicket(InitiativeTicket(i.id, keyOf(t), t.projectId, t.id, now)) }
        return list(i)
    }

    fun unlink(i: Initiative, key: String): List<LinkedTicket> {
        if (!store.unlinkTicket(i.id, key.trim()) && !store.unlinkTicket(i.id, key.trim().uppercase())) {
            throw NotFound("${key.trim()} is not linked to ${i.id}")
        }
        return list(i)
    }

    /** The Product map's "On the Tasks boards": the Jira tickets of these projects (and every linked ticket there). */
    fun board(pids: Collection<String>): List<LinkedTicket> {
        if (pids.isEmpty()) return emptyList()
        val by = byInitiative()
        val shown = pids.flatMap { tasks.list(it) }.filter { it.externalKey != null || keyOf(it) in by }
            .sortedByDescending { it.updatedAt }.take(MAX_BOARD)
        val work = links.forKeys(shown.mapNotNull { it.externalKey })
        return shown.map { t -> view(keyOf(t), t, by[keyOf(t)].orEmpty(), work[keyOf(t)]) }
    }
}
