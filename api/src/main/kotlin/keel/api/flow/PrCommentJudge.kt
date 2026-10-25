package keel.api.flow

/**
 * The review threads of a pull request and keel's cheap "Is the reviewer right?" check of one, for the Tasks plugin's
 * automations (a ticket assigned to KeelBot: keel watches its PR). The Code Review plugin (plugins/review) gives the one
 * bean; without it there is none and keel does not watch PR comments.
 *
 * Part of keel's api SDK (keel-api-sdk): a plugin may implement it.
 */
interface PrCommentJudge {
    /** The pull request's threads as the host lists them now ([prUrl] is the PR's web link). */
    fun threads(pid: String, prUrl: String): PrThreads

    /** Checks the thread's last comment (one cheap model call, cached per comment and head commit) and waits for it. */
    fun check(pid: String, prUrl: String, threadId: String): PrCommentVerdict

    /** Posts [body] as a reply in the thread (only after the person's OK, or the project's allow-reply switch). */
    fun reply(pid: String, prUrl: String, threadId: String, body: String)

    /** Starts the small flow that makes the change the thread asks for (never pushes); returns its thread id. */
    fun address(pid: String, prUrl: String, threadId: String): String
}

data class PrThreads(val author: String?, val headSha: String?, val threads: List<PrThread>)

/** One thread, with its last comment. */
data class PrThread(
    val id: String,
    val path: String?,
    val line: Int?,
    val resolved: Boolean,
    val lastCommentId: String,
    val lastAuthor: String,
    val lastBody: String,
    val url: String? = null,
)

/**
 * The check's answer. [verdict]: reviewer_right | author_right | partly | unclear (the first item's, or the strongest
 * one), or null when it did not run ([error] says why, [flow] when the project checks threads with a workflow instead).
 */
data class PrCommentVerdict(
    val verdict: String?,
    val why: String = "",
    val reply: String = "",
    val error: String? = null,
    val flow: String? = null,
)
