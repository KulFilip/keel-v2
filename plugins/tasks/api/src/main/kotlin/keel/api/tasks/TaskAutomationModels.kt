package keel.api.tasks

/**
 * 0.18.52 task automations (docs/plans/task-automations.md). A rule per keel status a ticket's Jira move lands in:
 * [mode] off (nothing), propose (keel picks a flow and asks in the Inbox) or start (keel starts it by itself, with
 * [runMode] and [capTokens]). For in_review the flow is a review of the task's pull request.
 */
data class AutomationRule(val mode: String = "off", val runMode: String? = null, val capTokens: Int? = null)

/** Who KeelBot is in Jira: an account (accountId, user name or display name) or, as the fallback, a label. */
data class KeelBotOwner(val account: String? = null, val label: String? = null) {
    val set: Boolean get() = !account.isNullOrBlank() || !label.isNullOrBlank()
}

data class AutomationSettings(
    val rules: Map<String, AutomationRule> = DEFAULT_RULES,
    val keelbot: KeelBotOwner = KeelBotOwner(),
    /** A KeelBot-owned ticket: keel posts its suggested reply on GitHub without asking (never a push or a code change). */
    val allowReply: Boolean = false,
    /** Flows keel starts by itself per project and day; above it keel proposes instead. */
    val dailyAutoStarts: Int = 5,
    /** The pick call does not run when its estimate is above this (keel proposes the type's default flow). */
    val pickCapTokens: Int = 8_000,
) {
    fun rule(status: String): AutomationRule = rules[status] ?: AutomationRule()

    companion object {
        val MODES = listOf("off", "propose", "start")
        val DEFAULT_RULES = mapOf(TaskStatus.IN_PROGRESS to AutomationRule("propose"), TaskStatus.IN_REVIEW to AutomationRule("propose"))
    }
}

/** PUT body: null keeps the saved value. */
data class AutomationSave(
    val rules: Map<String, AutomationRule>? = null,
    val keelbot: KeelBotOwner? = null,
    val allowReply: Boolean? = null,
    val dailyAutoStarts: Int? = null,
    val pickCapTokens: Int? = null,
)

data class AutomationView(
    val settings: AutomationSettings,
    /** The keel statuses a rule can name, and the modes. */
    val statuses: List<String> = TaskStatus.ALL,
    val modes: List<String> = AutomationSettings.MODES,
    /** false: the Code Review plugin is off, so keel cannot watch a KeelBot-owned ticket's PR comments. */
    val reviewWatch: Boolean,
    /** false: no tracker (Jira) for this project, so no Jira move can start a rule. */
    val tracker: Boolean,
    val autoStartsToday: Int,
)

/** keel's pick for a task: a workflow, why, the flow's title and request, questions to ask first, and settings. */
data class FlowPick(
    val workflowId: String,
    val why: String,
    val title: String,
    val request: String,
    val questions: List<Map<String, Any?>> = emptyList(),
    val settings: Map<String, Any?> = emptyMap(),
    /** true: the type's default flow, without (or despite) the model. */
    val fallback: Boolean = true,
    val model: String? = null,
    val tokens: Long = 0,
)

/** The body of POST /api/tasks/{id}/pick and /review: nothing yet (the rule's run mode and cap apply on Start). */
data class PickBody(val note: String? = null)
