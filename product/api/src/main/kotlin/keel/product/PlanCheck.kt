package keel.product

/**
 * The plan check of keel Product's engine (product/engine/keel_product/plan.py `check` and `markdown`), for a plan the
 * product manager changed by hand: the problems (unknown ids, loops, criteria), the critical path (the longest chain by
 * the upper estimate), the totals per team and in all, and the counts. The result has the same keys as the engine's
 * product.plan event, so a hand-made version reads like one keel wrote.
 */
object PlanCheck {
    private val CRITERION = Regex("^AC-\\d+\\s*\\[\\w+]\\s*\\S.*")

    @Suppress("UNCHECKED_CAST")
    fun check(plan: Map<String, Any?>): Map<String, Any?> {
        val problems = mutableListOf<String>()
        val epics = (plan["epics"] as? List<Map<String, Any?>>).orEmpty()
        val stories = epics.flatMap { (it["stories"] as? List<Map<String, Any?>>).orEmpty() }
        val ids = stories.mapNotNull { it["id"] as? String }.toSet()
        for (e in epics) if ((e["team"] as? String).isNullOrBlank()) problems += "epic ${e["id"] ?: e["title"]}: no team"
        val seen = mutableSetOf<String>()
        for (s in stories) {
            val sid = s["id"] as? String
            if (sid.isNullOrBlank()) {
                problems += "story '${s["title"]}': no id"
                continue
            }
            if (!seen.add(sid)) problems += "story $sid: the id is used twice"
            val criteria = strings(s["criteria"])
            if (criteria.isEmpty()) problems += "story $sid: no acceptance criteria"
            criteria.filterNot { CRITERION.matches(it) }.forEach { problems += "story $sid: criterion is not 'AC-<n> [LAYER] text': ${it.take(60)}" }
            strings(s["depends_on"]).filter { it !in ids }.forEach { problems += "story $sid: waits for $it, which is not in the plan" }
        }
        val byId = LinkedHashMap<String, Map<String, Any?>>()
        stories.forEach { s -> (s["id"] as? String)?.takeIf { it.isNotBlank() }?.let { byId.putIfAbsent(it, s) } }
        val cycle = cycle(byId)
        if (cycle.isNotEmpty()) problems += "these stories wait for each other in a loop: " + cycle.joinToString(" → ")
        val (path, length) = if (cycle.isNotEmpty()) emptyList<String>() to 0.0 else criticalPath(byId)
        // a story's own team (the product manager may move one) before its epic's
        val teamOf = epics.flatMap { e ->
            (e["stories"] as? List<Map<String, Any?>>).orEmpty().mapNotNull { s -> (s["id"] as? String)?.let { it to ((s["team"] as? String)?.ifBlank { null } ?: e["team"] as? String) } }
        }.toMap()
        val totals = sortedMapOf<String, DoubleArray>()
        for ((sid, s) in byId) {
            val (lo, hi) = days(s)
            val t = totals.getOrPut(teamOf[sid] ?: "?") { DoubleArray(2) }
            t[0] += lo
            t[1] += hi
        }
        return linkedMapOf(
            "plan" to plan, "problems" to problems, "ok" to problems.isEmpty(), "critical_path" to path, "critical_days" to length,
            "teams" to totals.mapValues { listOf(it.value[0], it.value[1]) }, "total_days" to listOf(totals.values.sumOf { it[0] }, totals.values.sumOf { it[1] }),
            "counts" to mapOf("epics" to epics.size, "stories" to byId.size, "tasks" to byId.values.sumOf { strings(it["tasks"]).size }),
        )
    }

    /** The plan as readable Markdown (plan-vN.md next to plan-vN.json), as the engine writes it. */
    @Suppress("UNCHECKED_CAST")
    fun markdown(result: Map<String, Any?>): String = buildString {
        val counts = result["counts"] as? Map<String, Any?> ?: emptyMap()
        val total = (result["total_days"] as? List<Any?>).orEmpty().map { (it as? Number)?.toDouble() ?: 0.0 }
        appendLine("# Plan").appendLine()
        appendLine("${counts["epics"]} epics · ${counts["stories"]} stories · ${counts["tasks"]} tasks · ${g(total.getOrElse(0) { 0.0 })}–${g(total.getOrElse(1) { 0.0 })} developer days")
        val path = strings(result["critical_path"])
        if (path.isNotEmpty()) appendLine("Critical path: ${path.joinToString(" → ")} (${g((result["critical_days"] as? Number)?.toDouble() ?: 0.0)} days)")
        val plan = result["plan"] as? Map<String, Any?> ?: emptyMap()
        for (e in (plan["epics"] as? List<Map<String, Any?>>).orEmpty()) {
            appendLine().appendLine("## ${e["id"]} · ${e["title"] ?: ""} (${e["team"]})")
            for (s in (e["stories"] as? List<Map<String, Any?>>).orEmpty()) {
                val (lo, hi) = days(s)
                val deps = strings(s["depends_on"])
                appendLine("- **${s["id"]}** ${s["title"]} · ${s["repo"] ?: "?"} · ${g(lo)}–${g(hi)} d${if (deps.isNotEmpty()) " · after ${deps.joinToString()}" else ""}")
                strings(s["criteria"]).forEach { appendLine("  - $it") }
            }
        }
        val problems = strings(result["problems"])
        if (problems.isNotEmpty()) {
            appendLine().appendLine("## Problems")
            problems.forEach { appendLine("- $it") }
        }
    }

    /** The short text kept with a plan version (as for one the engine wrote). */
    @Suppress("UNCHECKED_CAST")
    fun summary(result: Map<String, Any?>): String {
        val counts = result["counts"] as? Map<String, Any?> ?: emptyMap()
        val problems = strings(result["problems"])
        return "${counts["epics"]} epics · ${counts["stories"]} stories · ${counts["tasks"]} tasks" +
            if (problems.isNotEmpty()) "\n\nProblems:\n" + problems.joinToString("\n") { "- $it" } else ""
    }

    private fun g(d: Double): String = if (d == Math.floor(d) && !d.isInfinite()) d.toLong().toString() else d.toString()

    private fun strings(v: Any?): List<String> = (v as? List<*>).orEmpty().mapNotNull { it?.toString()?.takeIf { s -> s.isNotBlank() } }

    private fun days(s: Map<String, Any?>): Pair<Double, Double> {
        val est = when (val v = s["estimate_days"]) {
            is Number -> listOf(v.toDouble(), v.toDouble())
            is List<*> -> v.mapNotNull { (it as? Number)?.toDouble() }
            else -> emptyList()
        }
        if (est.isEmpty()) return 0.0 to 0.0
        val lo = est.first()
        val hi = est.last()
        return minOf(lo, hi) to maxOf(lo, hi)
    }

    private fun cycle(byId: Map<String, Map<String, Any?>>): List<String> {
        val state = mutableMapOf<String, Int>()
        val stack = mutableListOf<String>()
        fun visit(n: String): List<String> {
            state[n] = 1
            stack += n
            for (d in strings(byId[n]?.get("depends_on"))) {
                if (d !in byId) continue
                if (state[d] == 1) return stack.subList(stack.indexOf(d), stack.size).toList() + d
                if (state[d] == null) visit(d).takeIf { it.isNotEmpty() }?.let { return it }
            }
            stack.removeAt(stack.size - 1)
            state[n] = 2
            return emptyList()
        }
        for (n in byId.keys) if (state[n] == null) visit(n).takeIf { it.isNotEmpty() }?.let { return it }
        return emptyList()
    }

    private fun criticalPath(byId: Map<String, Map<String, Any?>>): Pair<List<String>, Double> {
        if (byId.isEmpty()) return emptyList<String>() to 0.0
        val best = mutableMapOf<String, Pair<Double, List<String>>>()
        fun longest(n: String): Pair<Double, List<String>> {
            best[n]?.let { return it }
            val own = days(byId.getValue(n)).second
            val prev = strings(byId.getValue(n)["depends_on"]).filter { it in byId }.map { longest(it) }.maxByOrNull { it.first } ?: (0.0 to emptyList())
            return (prev.first + own to prev.second + n).also { best[n] = it }
        }
        // the first longest chain wins, as in the engine (max keeps the first of equals)
        var top: Pair<Double, List<String>>? = null
        for (n in byId.keys) {
            val l = longest(n)
            if (top == null || l.first > top.first) top = l
        }
        return top!!.second to top.first
    }
}
