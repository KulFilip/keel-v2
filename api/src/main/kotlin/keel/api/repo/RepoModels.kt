package keel.api.repo

import com.fasterxml.jackson.annotation.JsonInclude

data class Worktree(val branch: String?, val path: String)
data class BranchInfo(val name: String, val note: String)
data class RepoInfo(
    val branch: String?,
    val base: String?,
    val ahead: Int,
    val behind: Int,
    val remote: String?,
    val worktrees: List<Worktree>,
    val branches: List<BranchInfo>,
    /** remote-tracking branches (`origin/feature/x`), without the `HEAD` symbolic refs; empty without a remote */
    val remoteBranches: List<BranchInfo> = emptyList(),
)

@JsonInclude(JsonInclude.Include.NON_NULL)
data class TreeNode(
    val path: String,
    val name: String,
    val depth: Int,
    val kind: String,
    val mark: String? = null,
    val keel: Boolean,
    val frozen: Boolean,
    val ac: String? = null,
)

/** `keel`: written by keel's own commit step (author KeelBot or the configured keel author, or co-authored by KeelBot). */
data class Commit(val sha: String, val message: String, val author: String, val at: String, val keel: Boolean = false)

/**
 * One file. `ac` is the newest acceptance criterion named by a commit on this branch that touched it; `phase`,
 * `bucket` and `verdict` say which keel rule applies to it now (verdict `deny` = frozen).
 */
data class FileView(
    val path: String,
    val size: Long,
    val mark: String?,
    val frozen: Boolean,
    val keel: Boolean,
    val ac: String?,
    val head: String,
    val lastCommit: Commit?,
    val binary: Boolean = false,
    val modified: Long = 0,
    val phase: String = "none",
    val bucket: String = "other",
    val verdict: String = "allow",
)

/** One changed path from `git status`: what is staged (index), what is not (work tree), or untracked. */
@JsonInclude(JsonInclude.Include.NON_NULL)
data class Change(
    val path: String,
    val from: String? = null,
    val staged: String? = null,
    val unstaged: String? = null,
    val untracked: Boolean = false,
    val conflict: Boolean = false,
)

@JsonInclude(JsonInclude.Include.NON_NULL)
data class CommitFile(val path: String, val status: String, val from: String? = null)
data class CommitView(val sha: String, val message: String, val body: String, val author: String, val at: String, val keel: Boolean, val files: List<CommitFile>)

/**
 * One local branch against the base (Code › Source control › a branch, with the Git plugin): the commits it has that the
 * base does not, and the files it changed since it left the base (`base...branch`, so the base's own new commits do not
 * show). `current` = the project folder is on it.
 */
data class BranchView(
    val name: String,
    val base: String?,
    val current: Boolean,
    val ahead: Int,
    val behind: Int,
    val commits: List<Commit>,
    val files: List<CommitFile>,
    val truncated: Boolean = false,
)

/** A unified diff of one file. `ref` is what it is compared with, in words. */
data class FileDiff(val path: String, val against: String, val ref: String, val diff: String, val binary: Boolean, val truncated: Boolean)

data class MergeResult(val ok: Boolean, val merged: Boolean, val conflicts: List<String>, val output: String)
