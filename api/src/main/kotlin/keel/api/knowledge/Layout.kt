package keel.api.knowledge

import keel.api.common.Yaml
import java.nio.file.Files
import java.nio.file.Path

/**
 * Where keel keeps its files in a project: keel v1's `layout:` key in .keel/config.yml. The engine has the same
 * resolver (engine keel_engine/layout.py); keep the two in step.
 *
 *   repo      the spec folder from `specs.dir`, else docs/specs or specs; docs/knowledge, docs/adr, docs/RUNNING.md
 *   keel      all of it under .keel/ (.keel/specs, .keel/knowledge, .keel/adr, .keel/RUNNING.md), out of git
 *   external  the same paths, but .keel is a symlink to a folder outside the clone
 *
 * Without the key: a .keel link is external, a project with keel files in docs/ stays repo, a new one gets
 * [NEW_PROJECT]. keel writes where the layout says and reads from every place that exists, the layout's own first.
 */
data class Layout(
    val name: String,
    val specs: String,
    val knowledge: String,
    val adr: String,
    val runbook: String,
    val claude: String,
    val specDirs: List<String>,
    val knowledgeDirs: List<String>,
    val adrDirs: List<String>,
    val runbooks: List<String>,
    val link: String? = null,
    /** external: the link's target is not visible here, in words (what to do). */
    val missing: String? = null,
) {
    val hidden: Boolean get() = name != "repo"

    /** The section's file to read: the layout's own, else one in another knowledge folder, else the layout's. */
    fun knowledgeFile(root: Path, section: String): String =
        knowledgeDirs.map { "$it/$section.md" }.firstOrNull { Files.isRegularFile(root.resolve(it)) } ?: "$knowledge/$section.md"

    /** Every folder keel's own files live in (specs, knowledge, ADRs), for "is this a keel file". */
    fun folders(): List<String> = (specDirs + knowledgeDirs + adrDirs).distinct()

    companion object {
        val LAYOUTS = listOf("repo", "keel", "external")
        private val REPO = mapOf("specs" to "docs/specs", "knowledge" to "docs/knowledge", "adr" to "docs/adr",
            "runbook" to "docs/RUNNING.md", "claude" to "CLAUDE.md")
        private val HIDDEN = mapOf("specs" to ".keel/specs", "knowledge" to ".keel/knowledge", "adr" to ".keel/adr",
            "runbook" to ".keel/RUNNING.md", "claude" to ".keel/CLAUDE.md")
        private val REPO_SPEC_DIRS = listOf("docs/specs", "specs")
        private val LEGACY_FILES = listOf("docs/specs", "docs/knowledge", "docs/adr", "docs/RUNNING.md")

        /** The layout of a project with no `layout:` key and no keel files yet (engine layout.NEW_PROJECT). */
        const val NEW_PROJECT = "keel"

        fun missingText(target: String) = "this project keeps keel's files in $target; add that folder too: keel2 add $target"

        fun rawConfig(root: Path): Map<String, Any?> {
            val f = root.resolve(".keel/config.yml")
            return runCatching { if (Files.isRegularFile(f)) Yaml.readMap(Files.readString(f)) else null }.getOrNull() ?: emptyMap()
        }

        fun hasLegacyFiles(root: Path): Boolean {
            if (LEGACY_FILES.any { Files.exists(root.resolve(it)) }) return true
            val specs = root.resolve("specs")
            return Files.isDirectory(specs) && runCatching { Files.list(specs).use { s -> s.anyMatch { it.toString().endsWith(".md") } } }.getOrDefault(false)
        }

        fun defaultName(root: Path, linked: Boolean): String = when {
            linked -> "external"
            hasLegacyFiles(root) -> "repo"
            else -> NEW_PROJECT
        }

        private fun sub(cfg: Map<String, Any?>, sec: String, key: String): String? =
            ((cfg[sec] as? Map<*, *>)?.get(key))?.toString()?.trim()?.trim('/')?.ifEmpty { null }

        private fun existing(root: Path, first: String, others: List<String>, file: Boolean = false): List<String> {
            val out = mutableListOf(first)
            for (d in others) {
                if (d.isNotEmpty() && d !in out && (if (file) Files.isRegularFile(root.resolve(d)) else Files.isDirectory(root.resolve(d)))) out += d
            }
            return out
        }

        fun resolve(root: Path, cfg: Map<String, Any?>? = null): Layout {
            val keel = root.resolve(".keel")
            var link: String? = null
            var missing: String? = null
            if (Files.isSymbolicLink(keel)) {
                val target = Files.readSymbolicLink(keel)
                link = (if (target.isAbsolute) target else root.resolve(target)).normalize().toString()
                if (!Files.isDirectory(keel)) missing = missingText(link)
            }
            val c = cfg ?: rawConfig(root)
            val name = c["layout"]?.toString()?.trim()?.takeIf { it in LAYOUTS } ?: defaultName(root, link != null)
            val p = if (name == "repo") {
                REPO + mapOf(
                    "specs" to (sub(c, "specs", "dir") ?: REPO_SPEC_DIRS.firstOrNull { Files.isDirectory(root.resolve(it)) } ?: REPO.getValue("specs")),
                    "knowledge" to (sub(c, "memory", "dir") ?: REPO.getValue("knowledge")),
                    "runbook" to (sub(c, "setup", "runbook") ?: REPO.getValue("runbook")),
                )
            } else HIDDEN
            val specDirs = existing(root, p.getValue("specs"), listOfNotNull(sub(c, "specs", "dir")) + REPO_SPEC_DIRS + HIDDEN.getValue("specs"))
            val knowledgeDirs = existing(root, p.getValue("knowledge"), listOf(REPO.getValue("knowledge"), HIDDEN.getValue("knowledge")))
            val adrDirs = existing(root, p.getValue("adr"), listOf(REPO.getValue("adr"), HIDDEN.getValue("adr")))
            val runbooks = existing(root, p.getValue("runbook"), listOf(REPO.getValue("runbook"), HIDDEN.getValue("runbook")), file = true)
                .filter { Files.isRegularFile(root.resolve(it)) }
            return Layout(name, p.getValue("specs"), p.getValue("knowledge"), p.getValue("adr"), p.getValue("runbook"),
                p.getValue("claude"), specDirs, knowledgeDirs, adrDirs, runbooks, link, missing)
        }
    }
}
