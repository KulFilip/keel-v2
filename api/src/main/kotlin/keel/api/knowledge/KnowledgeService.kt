package keel.api.knowledge

import keel.api.common.BadRequest
import keel.api.common.NotFound
import keel.api.common.Time
import keel.api.projects.ProjectService
import keel.api.repo.ClassifyConfig
import keel.api.workspace.Workspace
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID

data class KeelDoc(val path: String, val what: String, val by: String, val updated: String?, val status: String)
data class Fact(val id: String, val title: String, val text: String, val kind: String, val source: String, val at: String)
data class KnowledgeSection(val id: String, val status: String, val words: Int, val cites: Int)
data class Memory(val facts: List<Fact>, val knowledge: List<KnowledgeSection>)

/** keel docs and memory (facts + knowledge base) of a project. The Wiki page reads the knowledge base from here (the
 *  Wiki plugin, plugins/wiki); the code graph is the Graph plugin's (plugins/graph). */
@Service
class KnowledgeService(
    private val jdbc: JdbcTemplate,
    private val projects: ProjectService,
    private val workspace: Workspace,
) {
    // ---- keel docs ------------------------------------------------------------------------

    fun keelDocs(pid: String): List<KeelDoc> {
        val root = projects.root(pid)
        val out = mutableListOf<KeelDoc>()
        fun add(rel: String, what: String, by: String, status: String = "ok") {
            val f = root.resolve(rel)
            if (Files.exists(f)) out += KeelDoc(rel, what, by, mtime(f), status)
        }
        val lay = Layout.resolve(root)
        // every spec folder of the layout (a mixed project has .keel/specs and docs/specs: both show)
        specFiles(root, lay).forEach { add(it, "Spec — ${countAcs(root.resolve(it))} ACs", "explorer + you") }
        val cfg = ClassifyConfig.load(root)
        contractFiles(root, cfg).forEach { add(it, "Contract", "explorer") }
        lay.adrDirs.forEach { d -> listMd(root.resolve(d)).forEach { add("$d/${it.fileName}", "Decision — ${title(it)}", "you") } }
        val kb = knowledge(root)
        if (kb.any { it.status != "missing" }) {
            val written = kb.count { it.status != "missing" }
            val stale = kb.filter { it.status == "stale" }.map { it.id }
            val dir = lay.knowledgeDirs.firstOrNull { Files.isDirectory(root.resolve(it)) } ?: lay.knowledge
            out += KeelDoc(
                "$dir/", "Knowledge base — $written sections", "librarian",
                mtime(root.resolve(dir)), if (stale.isEmpty()) "ok" else "check",
            )
        }
        // keel v2's own files only: a flow's state and events live in the engine (/data), not in the project.
        add(".keel/config.yml", "Project config", "init")
        add(".keel/ladder.json", "Ladder results", "init", "live")
        lay.runbooks.forEach { add(it, "Runbook", "init") }
        return out
    }

    /** The specs of every spec folder the layout reads, as paths from the root. */
    fun specFiles(root: Path, lay: Layout = Layout.resolve(root)): List<String> =
        lay.specDirs.flatMap { d -> listMd(root.resolve(d)).map { "$d/${it.fileName}" } }

    /** Where keel keeps this project's files (GET /api/projects/{pid}/layout). */
    fun layout(pid: String): Layout = Layout.resolve(projects.root(pid))

    private fun contractFiles(root: Path, cfg: ClassifyConfig): List<String> {
        val list = mutableListOf<String>()
        if (Files.isRegularFile(root.resolve(cfg.contractFile))) list += cfg.contractFile
        for (c in listOf("docs/contract/openapi.yaml", "docs/contract/openapi.yml", "openapi.yaml", "contracts/openapi.yaml")) {
            if (c !in list && Files.isRegularFile(root.resolve(c))) list += c
        }
        return list
    }

    private fun countAcs(f: Path) = runCatching { Regex("\\bAC-\\d+").findAll(Files.readString(f)).map { it.value }.distinct().count() }.getOrDefault(0)

    private fun listMd(dir: Path): List<Path> =
        if (!Files.isDirectory(dir)) emptyList()
        // a symlinked .md is skipped: a cloned repo could link docs/specs/x.md to a file outside it
        else Files.list(dir).use { s -> s.filter { it.toString().endsWith(".md") && Files.isRegularFile(it) && !Files.isSymbolicLink(it) }.sorted().toList() }

    private fun mtime(p: Path): String? = runCatching { Time.iso(Files.getLastModifiedTime(p).toMillis()) }.getOrNull()

    private fun title(f: Path): String = runCatching {
        Files.readAllLines(f).firstOrNull { it.startsWith("# ") }?.removePrefix("# ")?.trim()
    }.getOrNull() ?: f.fileName.toString().removeSuffix(".md")

    // ---- memory ---------------------------------------------------------------------------

    fun memory(pid: String): Memory {
        val root = projects.root(pid)
        return Memory(facts(pid), knowledge(root))
    }

    fun facts(pid: String): List<Fact> =
        jdbc.query("SELECT id, title, text, kind, source, at FROM facts WHERE project_id = ? ORDER BY at DESC", { rs, _ ->
            Fact(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5), rs.getString(6))
        }, pid)

    fun addFact(pid: String, title: String, text: String, kind: String, source: String?): Fact {
        projects.require(pid)
        checkFact(title, text, kind)
        val id = "f-" + UUID.randomUUID().toString().take(8)
        jdbc.update(
            "INSERT INTO facts(id, project_id, title, text, kind, source, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            id, pid, title, text, kind, source ?: "you", Time.now(),
        )
        return facts(pid).first { it.id == id }
    }

    fun updateFact(pid: String, fid: String, title: String?, text: String?, kind: String?): Fact {
        val cur = facts(pid).firstOrNull { it.id == fid } ?: throw NotFound("No fact $fid")
        val next = cur.copy(title = title ?: cur.title, text = text ?: cur.text, kind = kind ?: cur.kind)
        checkFact(next.title, next.text, next.kind)
        jdbc.update("UPDATE facts SET title = ?, text = ?, kind = ?, at = ? WHERE id = ? AND project_id = ?", next.title, next.text, next.kind, Time.now(), fid, pid)
        return facts(pid).first { it.id == fid }
    }

    fun deleteFact(pid: String, fid: String) {
        if (jdbc.update("DELETE FROM facts WHERE id = ? AND project_id = ?", fid, pid) == 0) throw NotFound("No fact $fid")
    }

    private fun checkFact(title: String, text: String, kind: String) {
        if (title.isBlank() || text.isBlank()) throw BadRequest("A fact needs a title and a text")
        if (kind !in FACT_KINDS) throw BadRequest("kind must be one of: ${FACT_KINDS.joinToString()}")
    }

    /**
     * docs/knowledge/<section>.md: written | missing | stale. Stale (keel v1 `memory show`) = a file the section cites
     * changed in a commit after the section's own last commit. A commit that touches no cited file leaves the section
     * current; a section that cites nothing cannot go stale this way (the knowledge check flags it instead).
     */
    fun knowledge(root: Path): List<KnowledgeSection> {
        val lay = Layout.resolve(root)
        val extra = lay.knowledgeDirs.flatMap { d -> listMd(root.resolve(d)).map { it.fileName.toString().removeSuffix(".md") } }
            .distinct().filter { it !in SECTIONS && it.lowercase() != "readme" && it != "index" }
        return (SECTIONS + extra).map { s ->
            val rel = lay.knowledgeFile(root, s)
            val f = root.resolve(rel)
            if (!Files.isRegularFile(f)) return@map KnowledgeSection(s, "missing", 0, 0)
            val text = Files.readString(f)
            val words = text.split(Regex("\\s+")).count { it.isNotBlank() }
            val cites = CITATION.findAll(text).count()
            val written = workspace.lastCommitTime(root, rel)
            val stale = written != null && (citedChange(root, text) ?: 0L) > written
            KnowledgeSection(s, if (stale) "stale" else "written", words, cites)
        }
    }

    /** When a file the section cites last changed (commit time, seconds), or null when it cites no file that exists. */
    private fun citedChange(root: Path, text: String): Long? {
        val cited = CITATION.findAll(text).map { it.groupValues[1] }.distinct()
            .filter { !it.contains("..") && Files.isRegularFile(root.resolve(it)) }.take(200).toList()
        if (cited.isEmpty()) return null
        return workspace.gitOut(root, "log", "-1", "--format=%ct", "--", *cited.toTypedArray())?.toLongOrNull()
    }

    companion object {
        val SECTIONS = listOf("architecture", "domain", "conventions", "data", "integrations", "journeys")
        val FACT_KINDS = setOf("fact", "rule", "flaky", "unlock")
        val CITATION = Regex("`([A-Za-z0-9_@./-]+\\.[A-Za-z0-9]+):(\\d+)(?:-(\\d+))?`")
    }
}
