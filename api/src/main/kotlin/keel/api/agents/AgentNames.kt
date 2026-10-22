package keel.api.agents

/**
 * Agent names that changed, and how an old one still reaches its agent (the engine has the same table:
 * engine/keel_engine/agent_names.py).
 *
 * keel gave the four review agents names that say when each one runs. Workflows (keel's, a project's own, the
 * marketplace's), per-agent settings (agent_overrides, skill assignments) and calls (PUT /agents/{old}) that still say
 * the old name get the new agent. Old names are never listed as agents of their own. V21 moved the stored rows once;
 * the read-time alias covers anything saved under an old name after that (a new-name value always wins).
 */
object AgentNames {
    /** old name -> new name */
    val RENAMED: Map<String, String> = linkedMapOf(
        "ac-reviewer" to "criterion-reviewer",   // one acceptance criterion's red and green commits, during a flow
        "code-reviewer" to "branch-reviewer",    // the whole branch diff, once, at the end of a flow
        "reviewer" to "lens-reviewer",           // a diff against the spec, one lens at a time
        "ticket-reviewer" to "pr-reviewer",      // someone else's pull request (the review-pr flow)
    )

    val OLD: Set<String> = RENAMED.keys

    /** The agent's current name: an old name gives its new one, any other name stays as it is. */
    fun canonical(name: String): String = RENAMED[name] ?: name

    fun canonicalOrNull(name: String?): String? = name?.let { canonical(it) }

    fun isOld(name: String?): Boolean = name != null && name in RENAMED

    /** The old names of an agent (none for most). */
    fun oldNamesOf(name: String): List<String> = RENAMED.filterValues { it == name }.keys.toList()

    /** A per-agent map with every old-name key moved to its new name; when both are there, the new name's value wins. */
    fun <V> canonicalKeys(m: Map<String, V>): Map<String, V> {
        val out = LinkedHashMap<String, V>()
        for ((k, v) in m) if (k !in RENAMED) out[k] = v
        for ((k, v) in m) RENAMED[k]?.let { out.putIfAbsent(it, v) }
        return out
    }

    /** A list of agent names with old names replaced, each name once. */
    fun canonicalList(names: List<String>): List<String> = names.map { canonical(it) }.distinct()
}
