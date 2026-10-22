package keel.product

import keel.api.addons.FeatureService
import keel.api.common.NotFound
import keel.api.common.Time
import keel.api.projects.ProjectService
import keel.api.workspace.Workspace
import org.slf4j.LoggerFactory
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import java.nio.file.Files
import java.nio.file.Paths
import java.time.OffsetDateTime

data class ScanResult(val projects: List<ProjectScan>)

/** One ticket key and the work keel found for it in git. */
data class TicketWork(
    val key: String,
    val team: String?,
    val branches: List<TicketLink>,
    val commits: List<TicketLink>,
    val lastAt: String?,
)

data class TeamTickets(val team: String?, val tickets: List<TicketWork>, val unlinked: List<TicketLink>, val scans: List<ProjectScan>)

/**
 * Ticket keys in the teams' git: keel reads each team project's branches (local and remote) and its commits of the last
 * [DAYS] days, and links every one whose name or message has a key of the team's pattern (TicketKeys). What has no key
 * is kept too, for the "no ticket key" list. A scan replaces a project's rows; it runs on "Scan now" and every 15 minutes.
 */
@Service
class TicketLinks(
    private val store: ProductStore,
    private val projects: ProjectService,
    private val workspace: Workspace,
    private val features: FeatureService,
    private val props: ProductProperties,
) {
    companion object {
        const val DAYS = 90
        const val MAX_COMMITS = 2000
        const val MAX_FILES = 50
        private const val US = '\u001f'
        private const val RS = '\u001e'
        private val TRUNKS = setOf("HEAD", "main", "master", "develop", "dev", "trunk")
    }

    private val log = LoggerFactory.getLogger(javaClass)

    @Scheduled(fixedDelayString = "\${keel.product.scan-ms:900000}", initialDelayString = "\${keel.product.scan-ms:900000}")
    fun tick() {
        if (!props.scheduler || !features.partOn("product")) return
        runCatching { scanAll() }.onFailure { log.warn("keel Product ticket scan: {}", it.message) }
    }

    /** Every project of a team that has a key pattern. */
    @Synchronized
    fun scanAll(): ScanResult = ScanResult(store.teams().filter { it.keys != null }.flatMap { it.projects }.distinct().map { scan(it) })

    @Synchronized
    fun scan(projectId: String): ProjectScan {
        val p = projects.find(projectId) ?: throw NotFound("No project $projectId")
        val patterns = store.teams().filter { projectId in it.projects }.mapNotNull { t -> t.keys?.let { t.id to TicketKeys.regex(it) } }
        val root = Paths.get(p.root)
        fun failed(why: String) = ProjectScan(projectId, Time.now(), 0, 0, 0, why).also { store.saveScan(it) }
        if (!Files.isDirectory(root.resolve(".git")) && !Files.isRegularFile(root.resolve(".git"))) return failed("not a git repo")

        val refs = workspace.git(root, "for-each-ref", "--format=%(refname)$US%(committerdate:iso-strict)$US%(authorname)$US%(subject)",
            "refs/heads", "refs/remotes", timeout = 30)
        if (!refs.ok) return failed("git for-each-ref: ${refs.err.take(200)}")
        val log = workspace.git(root, "log", "--all", "--since=$DAYS.days", "--max-count=$MAX_COMMITS", "--no-merges",
            "--format=$RS%H$US%an$US%aI$US%B$US", "--name-only", timeout = 60)
        if (!log.ok) return failed("git log: ${log.err.take(200)}")

        fun keys(text: String): List<Pair<String, String>> = patterns.flatMap { (team, r) -> TicketKeys.find(r, text).map { it to team } }
            .distinctBy { it.first }

        val links = mutableListOf<TicketLink>()
        val branches = linkedMapOf<String, List<String>>()
        for (line in refs.out.lineSequence().filter { it.isNotBlank() }) {
            val f = line.split(US)
            val name = branchName(f[0]) ?: continue
            if (name in branches) continue                       // the local branch wins over origin/<same>
            branches[name] = f
        }
        for ((name, f) in branches) {
            val found = keys(name)
            if (found.isEmpty() && name in TRUNKS) continue
            val (at, author, subject) = Triple(utc(f.getOrNull(1)), f.getOrNull(2), f.getOrNull(3))
            if (found.isEmpty()) links += TicketLink(projectId, "branch", name, "", null, subject, author, at)
            found.forEach { (key, team) -> links += TicketLink(projectId, "branch", name, key, team, subject, author, at) }
        }
        var commits = 0
        for (rec in log.out.split(RS).filter { it.isNotBlank() }) {
            val f = rec.split(US)
            if (f.size < 4) continue
            commits++
            val sha = f[0].trim()
            val message = f[3].trim()
            val files = f.getOrNull(4).orEmpty().lines().map { it.trim() }.filter { it.isNotEmpty() }.take(MAX_FILES)
            val title = message.lineSequence().firstOrNull()?.take(300)
            val found = keys(message)
            if (found.isEmpty()) links += TicketLink(projectId, "commit", sha, "", null, title, f[1], utc(f[2]), files)
            found.forEach { (key, team) -> links += TicketLink(projectId, "commit", sha, key, team, title, f[1], utc(f[2]), files) }
        }
        val scan = ProjectScan(projectId, Time.now(), branches.size, commits, links.count { it.key.isNotEmpty() },
            if (patterns.isEmpty()) "no team of this project has a key pattern" else null)
        store.replaceLinks(projectId, links, scan)
        return scan
    }

    /** git's local time (2026-10-22T12:00:00+02:00) as UTC, so times of all projects sort as text. */
    private fun utc(at: String?): String? = at?.trim()?.let { runCatching { OffsetDateTime.parse(it).toInstant().toString() }.getOrNull() }

    /** refs/heads/x → x; refs/remotes/origin/x → x; origin/HEAD → null. */
    private fun branchName(ref: String): String? = when {
        ref.startsWith("refs/heads/") -> ref.removePrefix("refs/heads/")
        ref.startsWith("refs/remotes/") -> ref.removePrefix("refs/remotes/").substringAfter('/', "").takeIf { it.isNotEmpty() && it != "HEAD" }
        else -> null
    }

    /** The tickets of a team (or of every team), each with its branches and commits, the newest first. */
    fun tickets(teamId: String?, unlinkedMax: Int = 50): TeamTickets {
        val team = teamId?.let { store.team(it) ?: throw NotFound("No team $it") }
        val work = group(store.links(teamId = team?.id))
        val pids = team?.projects ?: store.teams().flatMap { it.projects }.distinct()
        return TeamTickets(team?.id, work, store.unlinked(pids, unlinkedMax), store.scans().filter { it.projectId in pids })
    }

    /** The work for these keys (a plan's sent stories). */
    fun forKeys(keys: Collection<String>): Map<String, TicketWork> = group(store.links(keys = keys)).associateBy { it.key }

    private fun group(links: List<TicketLink>): List<TicketWork> = links.groupBy { it.key }.map { (key, l) ->
        TicketWork(key, l.firstNotNullOfOrNull { it.teamId }, l.filter { it.kind == "branch" }.distinctBy { it.projectId to it.ref },
            l.filter { it.kind == "commit" }.distinctBy { it.ref }, l.mapNotNull { it.at }.maxOrNull())
    }.sortedByDescending { it.lastAt.orEmpty() }
}
