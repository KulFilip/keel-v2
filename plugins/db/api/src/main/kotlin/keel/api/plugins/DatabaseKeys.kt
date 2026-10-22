package keel.api.plugins

import com.fasterxml.jackson.databind.ObjectMapper
import keel.api.flow.FlowContributor
import org.springframework.stereotype.Component

/**
 * The Database plugin's secrets for a project's flows and KeelBot turns, while the plugin is on for the project: each
 * connection the project uses (its own and the globals it sees, [DatabaseStore.active]) as the engine's key
 * `db:<name>` → {name, kind, url, env, driver, scope, agent_access, ask_first} as JSON, in name order (the engine keeps
 * them in memory). agent_access is what agents really may do (staging and prod: read at most). A connection keel cannot
 * reach now (its password kept for the session only and keel started again, a missing .env variable) comes with
 * `unavailable` and no url, so a step or an agent says why. Before step 3 core's PluginService.keysFor read them; the
 * keys are the same.
 */
@Component
class DatabaseKeys(
    private val store: DatabaseStore,
    private val plugins: PluginService,
    private val mapper: ObjectMapper,
) : FlowContributor {
    override fun keys(pid: String): Map<String, String> {
        if (!plugins.on(pid, "db")) return emptyMap()
        val out = linkedMapOf<String, String>()
        store.active(pid).forEach { r ->
            val c = store.connect(r, pid)
            val base = linkedMapOf<String, Any?>("name" to r.name, "kind" to (c.url?.let(DbUrls::driverOf)?.let(DbUrls::kindOf) ?: r.kind),
                "url" to (c.url ?: ""), "env" to r.env)
            if (c.url == null && c.unavailable == null) return@forEach
            base["driver"] = r.driver
            base["scope"] = if (r.global) "global" else "project"
            base["agent_access"] = r.agentAccessEffective
            base["ask_first"] = r.askFirst
            c.unavailable?.let { base["unavailable"] = listOfNotNull(it, c.hint).joinToString(" ") }
            out["db:${r.name}"] = mapper.writeValueAsString(base)
        }
        return out
    }
}
