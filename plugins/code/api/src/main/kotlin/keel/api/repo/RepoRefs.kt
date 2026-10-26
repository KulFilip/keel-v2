package keel.api.repo

import com.fasterxml.jackson.annotation.JsonInclude
import keel.api.common.ApiException
import keel.api.common.BadRequest
import keel.api.common.Forbidden
import keel.api.common.NotFound
import keel.api.projects.ProjectService
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

/** Where a file at a ref was read from: the commit the ref names, or the work tree of the worktree that has it out. */
@JsonInclude(JsonInclude.Include.NON_NULL)
data class RefFile(
    val path: String,
    /** the ref as asked (a branch, origin/<branch>, refs/keel/…, a commit id) */
    val ref: String,
    /** the commit it names */
    val sha: String,
    /** branch | remote | review | commit | ref */
    val kind: String,
    /** the local branch "Check out" switches to (a remote branch's name without its remote); null: not a branch */
    val branch: String?,
    /** the ref is the branch the project folder has checked out (the editor shows the work tree's file instead) */
    val current: Boolean,
    /** the project folder's checked-out branch (null: detached) */
    val checkedOut: String?,
    /** a worktree (a KeelBot side session, a flow) that has this branch checked out */
    val worktree: Worktree?,
    /** ref: the committed file; worktree: the worktree's file, with what is not committed there yet */
    val source: String,
    val size: Long,
    val binary: Boolean,
    /** the text (null when binary) */
    val text: String?,
    /** uncommitted changes in the project folder: "Check out" refuses while there are any */
    val dirty: Int,
)

/** One ref keel knows that has the file: a local branch (flows, side sessions), a review ref, a remote branch. */
data class FoundRef(val ref: String, val label: String, val kind: String, val sha: String, val at: String)

data class FoundFile(val path: String, val inWorkTree: Boolean, val checkedOut: String?, val refs: List<FoundRef>)

/**
 * A file as another branch or commit has it, without checking anything out: `git cat-file` of `<commit>:<path>`
 * (a link from a KeelBot answer, a review or a flow made on a branch the project folder is not on). The ref is checked
 * with `git rev-parse --verify` after a strict name check, the path with keel's own path rules (no `..`, no `.git`, no
 * secret files); every git call gets its arguments as a list, never through a shell.
 */
@Service
class RepoRefs(private val projects: ProjectService, private val repo: RepoService) {

    /** The file at `ref`; `from = worktree` reads the worktree that has the branch checked out (its uncommitted changes too). */
    fun fileAt(pid: String, rel: String, ref: String, from: String? = null): RefFile {
        val root = projects.root(pid)
        val path = cleanPath(rel)
        val name = checkRef(ref)
        val sha = resolve(root, name) ?: throw NotFound("No branch or commit $name here", "It may have been deleted, or not fetched yet.")
        val checkedOut = projects.branch(root)
        val branch = localBranchOf(root, name)
        val current = checkedOut != null && full(root, name) == "refs/heads/$checkedOut"
        val tree = branch?.let { b -> worktreeOf(root, b) }
        val dirty = repo.changes(pid).size
        if (from == "worktree") {
            val wt = tree ?: throw NotFound("No worktree has $name checked out")
            val wroot = Path.of(wt.path)
            val target = repo.safePath(wroot, path)
            if (!Files.isRegularFile(target)) throw NotFound("No file at $path in the worktree of $name")
            val size = Files.size(target)
            tooBig(size)
            val bytes = Files.readAllBytes(target)
            val binary = RepoService.isBinary(bytes)
            return RefFile(path, name, sha, kindOf(root, name), branch, current, checkedOut, wt, "worktree", size, binary,
                if (binary) null else String(bytes, StandardCharsets.UTF_8), dirty)
        }
        val spec = "$sha:$path"
        val type = repo.git(root, "cat-file", "-t", spec)
        if (!type.ok) throw NotFound("$path is not on $name", "The file may be new on another branch, or moved.")
        if (type.out.trim() != "blob") throw BadRequest("$path is a folder on $name", "Pick a file.")
        val size = repo.git(root, "cat-file", "-s", spec).out.trim().toLongOrNull() ?: 0L
        tooBig(size)
        val r = repo.git(root, "cat-file", "blob", spec, timeout = 20)
        if (!r.ok) throw BadRequest("git could not read $path at $name", r.err.trim().take(300).ifBlank { null })
        val binary = r.out.take(8000).contains('\u0000')
        return RefFile(path, name, sha, kindOf(root, name), branch, current, checkedOut, tree, "ref", size, binary,
            if (binary) null else r.out, dirty)
    }

    /**
     * The refs keel knows for this project that have the file: local branches (flow branches, KeelBot's side sessions),
     * keel's review refs (refs/keel/…) and remote branches, newest first, at most [FIND_MAX] (one per commit).
     */
    fun find(pid: String, rel: String): FoundFile {
        val root = projects.root(pid)
        val path = cleanPath(rel)
        val inTree = Files.isRegularFile(repo.safePath(root, path))
        val checkedOut = projects.branch(root)
        val out = repo.git(root, "for-each-ref", "--sort=-committerdate",
            "--format=%(refname)\u001f%(objectname)\u001f%(committerdate:iso-strict)", "refs/heads", "refs/keel", "refs/remotes")
        val candidates = out.out.lines().filter { it.isNotBlank() }.mapNotNull { line ->
            val p = line.split('\u001f')
            val full = p[0]
            when {
                full.startsWith("refs/remotes/") && (full.endsWith("/HEAD") || full.removePrefix("refs/remotes/").contains('/').not()) -> null
                full.startsWith("refs/keel/") && full.endsWith("-base") -> null              // a review's base, not its change
                checkedOut != null && full == "refs/heads/$checkedOut" -> null                // the work tree is that one
                else -> Triple(full, p.getOrElse(1) { "" }, p.getOrElse(2) { "" })
            }
        }.sortedBy { (full, _, _) -> if (full.startsWith("refs/heads/")) 0 else if (full.startsWith("refs/keel/")) 1 else 2 }
            .take(SCAN_MAX)
        val seen = mutableSetOf<String>()
        val hits = mutableListOf<FoundRef>()
        for ((full, sha, at) in candidates) {
            if (hits.size >= FIND_MAX) break
            if (sha in seen) continue
            if (!repo.git(root, "cat-file", "-e", "$sha:$path").ok) continue
            seen += sha
            val (ref, label, kind) = when {
                full.startsWith("refs/heads/") -> full.removePrefix("refs/heads/").let { Triple(it, it, "branch") }
                full.startsWith("refs/remotes/") -> full.removePrefix("refs/remotes/").let { Triple(it, it, "remote") }
                else -> Triple(full, reviewLabel(full), "review")
            }
            hits += FoundRef(ref, label, kind, sha, at)
        }
        return FoundFile(path, inTree, checkedOut, hits)
    }

    private fun tooBig(size: Long) {
        if (size > RepoService.RAW_MAX) {
            throw ApiException(HttpStatus.valueOf(413), "The file is too big to show (${size / (1024 * 1024)} MB)",
                "keel shows files up to ${RepoService.RAW_MAX / (1024 * 1024)} MB.")
        }
    }

    /** The commit a checked name points at, or null. */
    private fun resolve(root: Path, name: String): String? =
        repo.git(root, "rev-parse", "--verify", "--quiet", "$name^{commit}").takeIf { it.ok }?.out?.trim()?.takeIf { it.isNotEmpty() }

    /** The full ref name (refs/heads/x), or null for a commit id. */
    private fun full(root: Path, name: String): String? =
        repo.git(root, "rev-parse", "--symbolic-full-name", name).takeIf { it.ok }?.out?.trim()?.takeIf { it.startsWith("refs/") }

    private fun kindOf(root: Path, name: String): String {
        val f = full(root, name) ?: return "commit"
        return when {
            f.startsWith("refs/heads/") -> "branch"
            f.startsWith("refs/remotes/") -> "remote"
            f.startsWith("refs/keel/") -> "review"
            else -> "ref"
        }
    }

    /** The local branch "Check out" switches to: the branch itself, or a remote branch's name (git switch makes it track). */
    private fun localBranchOf(root: Path, name: String): String? {
        val f = full(root, name) ?: return null
        return when {
            f.startsWith("refs/heads/") -> f.removePrefix("refs/heads/")
            f.startsWith("refs/remotes/") -> f.removePrefix("refs/remotes/").substringAfter('/').takeIf { it.isNotBlank() }
            else -> null
        }
    }

    /** A worktree other than the project folder that has `branch` checked out (a side session's, a flow's). */
    private fun worktreeOf(root: Path, branch: String): Worktree? {
        val out = repo.git(root, "worktree", "list", "--porcelain").takeIf { it.ok }?.out ?: return null
        val me = runCatching { root.toRealPath() }.getOrDefault(root)
        var path: String? = null
        for (line in out.lines() + "") {
            when {
                line.startsWith("worktree ") -> path = line.removePrefix("worktree ")
                line.startsWith("branch ") -> {
                    val b = line.removePrefix("branch ").removePrefix("refs/heads/")
                    val p = path
                    if (b == branch && p != null && runCatching { Path.of(p).toRealPath() }.getOrNull() != me && Files.isDirectory(Path.of(p))) {
                        return Worktree(b, p)
                    }
                }
                line.isBlank() -> path = null
            }
        }
        return null
    }

    companion object {
        const val FIND_MAX = 8
        const val SCAN_MAX = 120

        /** A branch, a remote branch, a keel ref or a commit id: letters, digits and `._/+-`, never an option, a range,
         *  a reflog (`@{…}`), a revision expression (`~`, `^`, `:`) or a path inside .git. */
        private val REF_NAME = Regex("^[A-Za-z0-9][A-Za-z0-9._/+-]{0,250}$")

        fun checkRef(ref: String): String {
            val r = ref.trim()
            if (!REF_NAME.matches(r) || r.contains("..") || r.contains("//") || r.endsWith("/") || r.endsWith(".lock") ||
                r.split('/').any { it.startsWith(".") }
            ) throw BadRequest("That is not a branch or commit name", "For example feature/x, origin/feature/x or a commit id.")
            return r
        }

        /** A repo-relative file path: no absolute path, no `.` / `..` / empty part, nothing in .git, no secret file. */
        fun cleanPath(rel: String): String {
            val p = rel.trim().replace('\\', '/').removePrefix("./")
            if (p.isBlank() || p.contains('\u0000') || p.any { it.isISOControl() }) throw BadRequest("path is not valid")
            if (p.startsWith("/") || Regex("^[A-Za-z]:").containsMatchIn(p)) {
                throw Forbidden("That path is outside the project", "Use a path relative to the repo root.")
            }
            val parts = p.split('/')
            if (parts.any { it.isEmpty() || it == "." || it == ".." }) {
                throw Forbidden("That path is outside the project", "Use a path relative to the repo root.")
            }
            if (parts.any { it.equals(".git", ignoreCase = true) }) throw Forbidden("keel does not show files inside .git")
            if (RepoService.isSecret(parts.last())) {
                throw Forbidden("keel does not show secret files", "Files like .env, keys and certificates stay private.")
            }
            return p
        }

        /** refs/keel/review/pr-7 and refs/keel/review-pr/7: "PR #7 (review)". */
        fun reviewLabel(full: String): String {
            val n = Regex("""^refs/keel/review(?:/pr-|-pr/)(\d+)$""").find(full)?.groupValues?.get(1)
            return if (n != null) "PR #$n (review)" else full.removePrefix("refs/")
        }
    }
}
