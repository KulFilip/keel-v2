package keel.api.plugins

import keel.api.common.Time
import keel.api.connections.SecretService
import keel.api.projects.ProjectService
import org.springframework.beans.factory.ObjectProvider
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Component
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap

/** One saved connection, as its row has it (never the password). */
data class DbRow(
    val id: String,
    /** a project's id, or `*` for a global connection */
    val projectId: String,
    val name: String,
    val kind: String,
    val driver: String,
    val env: String,
    val shown: String,
    val source: String?,
    val ok: Boolean?,
    val server: String?,
    val tables: Int?,
    val error: String?,
    val checkedAt: String?,
    /** host | socket | url | env */
    val connectMode: String,
    val host: String?,
    val port: Int?,
    val username: String?,
    val defaultDb: String?,
    val urlOverride: String?,
    val socketPath: String?,
    val envVar: String?,
    val note: String?,
    /** none | read | write_approve */
    val agentAccess: String,
    val askFirst: Boolean,
    /** keel | session | never */
    val keepPassword: String,
) {
    val global: Boolean get() = projectId == DatabaseStore.GLOBAL

    /** What agents may really do: staging and prod are read only for them, always (whatever agent_access says). */
    val agentAccessEffective: String
        get() = if (agentAccess == "write_approve" && env !in DatabaseService.CHANGE_ENVS) "read" else agentAccess
}

/** A connection as one project sees it: its own, or a global one (overridden: the project has its own of that name). */
data class DbResolved(val row: DbRow, val overridden: Boolean)

/** Where the full address of a connection comes from: the address, or why there is none now. */
data class DbConnect(val url: String?, val unavailable: String? = null, val hint: String? = null)

/**
 * The Database plugin's connections in core's table db_connections (V11, V22): global ones (`*`) and a project's own,
 * which one a project sees, and where each one's full address is. The address with its password is a secret (`db.<id>`,
 * keel's secret store) for "keep in keel"; for "this session only" it stays in this process's memory; for "never" keel
 * keeps none. Both [DatabaseService] and [DatabaseKeys] read through here.
 */
@Component
class DatabaseStore(
    private val jdbc: JdbcTemplate,
    private val secrets: SecretService,
    private val projects: ObjectProvider<ProjectService>,
) {
    /** "This session only": the full addresses while keel runs (gone at a restart). */
    private val session = ConcurrentHashMap<String, String>()

    private val columns = "id, project_id, name, kind, driver, env, shown, source, ok, server, tables, error, checked_at, connect_mode, " +
        "host, port, username, default_db, url_override, socket_path, env_var, note, agent_access, ask_first, keep_password"

    private fun query(where: String, vararg args: Any): List<DbRow> {
        backfill()
        return jdbc.query("SELECT $columns FROM db_connections WHERE $where ORDER BY name", { rs, _ ->
            fun int(i: Int) = rs.getObject(i)?.let { (it as Number).toInt() }
            DbRow(
                id = rs.getString(1), projectId = rs.getString(2), name = rs.getString(3), kind = rs.getString(4),
                driver = rs.getString(5) ?: rs.getString(4), env = rs.getString(6), shown = rs.getString(7), source = rs.getString(8),
                ok = int(9)?.let { it == 1 }, server = rs.getString(10), tables = int(11), error = rs.getString(12),
                checkedAt = rs.getString(13), connectMode = rs.getString(14), host = rs.getString(15), port = int(16),
                username = rs.getString(17), defaultDb = rs.getString(18), urlOverride = rs.getString(19), socketPath = rs.getString(20),
                envVar = rs.getString(21), note = rs.getString(22), agentAccess = rs.getString(23), askFirst = int(24) == 1,
                keepPassword = rs.getString(25),
            )
        }, *args)
    }

    fun byId(id: String): DbRow? = query("id = ?", id).firstOrNull()
    fun own(pid: String): List<DbRow> = query("project_id = ?", pid)
    fun globals(): List<DbRow> = query("project_id = ?", GLOBAL)

    /** The projects a global connection is narrowed to (empty: every project). */
    fun allowed(id: String): List<String> =
        jdbc.queryForList("SELECT project_id FROM db_connection_projects WHERE connection_id = ? ORDER BY project_id", String::class.java, id)

    fun hiddenIn(id: String): List<String> =
        jdbc.queryForList("SELECT project_id FROM db_connection_hidden WHERE connection_id = ? ORDER BY project_id", String::class.java, id)

    fun setAllowed(id: String, pids: List<String>) {
        jdbc.update("DELETE FROM db_connection_projects WHERE connection_id = ?", id)
        pids.distinct().forEach { jdbc.update("INSERT INTO db_connection_projects(connection_id, project_id) VALUES (?, ?)", id, it) }
    }

    fun setHidden(id: String, pid: String, hidden: Boolean) {
        jdbc.update("DELETE FROM db_connection_hidden WHERE connection_id = ? AND project_id = ?", id, pid)
        if (hidden) jdbc.update("INSERT INTO db_connection_hidden(connection_id, project_id) VALUES (?, ?)", id, pid)
    }

    /** May this project see this global connection (its allow-list), before a hide or an override? */
    fun allowedFor(row: DbRow, pid: String): Boolean = allowed(row.id).let { it.isEmpty() || pid in it }

    /** Every connection the project sees: its own, then the globals allowed for it and not hidden there. A global with the
     *  name of one of its own is there too, `overridden` (the project's own wins). */
    fun effective(pid: String): List<DbResolved> {
        val mine = own(pid)
        val names = mine.map { it.name }.toSet()
        val hidden = jdbc.queryForList("SELECT connection_id FROM db_connection_hidden WHERE project_id = ?", String::class.java, pid).toSet()
        val globals = globals().filter { it.id !in hidden && allowedFor(it, pid) }
        return mine.map { DbResolved(it, false) } + globals.map { DbResolved(it, it.name in names) }
    }

    /** The connections the project uses: its own and the globals it sees that it does not override. */
    fun active(pid: String): List<DbRow> = effective(pid).filterNot { it.overridden }.map { it.row }.sortedBy { it.name }

    /** The globals the project could see but hides. */
    fun hiddenGlobals(pid: String): List<DbRow> {
        val hidden = jdbc.queryForList("SELECT connection_id FROM db_connection_hidden WHERE project_id = ?", String::class.java, pid).toSet()
        return globals().filter { it.id in hidden && allowedFor(it, pid) }
    }

    // ---------------------------------------------------------------- addresses

    /** The address without its password, built from the row's fields (url: the one typed; env: none, it is read at use). */
    fun address(r: DbRow): String? = when (r.connectMode) {
        "env" -> null
        "url" -> r.urlOverride
        "socket" -> DbUrls.build(DbAddress(r.driver, username = r.username, database = r.defaultDb, socket = r.socketPath), false)
        else -> DbUrls.build(DbAddress(r.driver, r.host, r.port, r.username, database = r.defaultDb), false)
    }

    /** The full address keel keeps for the row now (not the one read from a project's .env). */
    fun kept(r: DbRow): String? = when (r.keepPassword) {
        "session" -> session[r.id]
        "never" -> null
        else -> secrets.get(secretName(r.id))
    }

    /** Puts the full address where the row's keep_password says, and nowhere else. */
    fun keep(id: String, keep: String, url: String?) {
        if (keep == "keel" && url != null) secrets.put(secretName(id), url) else runCatching { secrets.delete(secretName(id)) }
        if (keep == "session" && url != null) session[id] = url else session.remove(id)
    }

    fun forget(id: String) {
        runCatching { secrets.delete(secretName(id)) }
        session.remove(id)
        jdbc.update("DELETE FROM db_connection_projects WHERE connection_id = ?", id)
        jdbc.update("DELETE FROM db_connection_hidden WHERE connection_id = ?", id)
    }

    /** The full address to connect with, for one project (a global's .env and SQLite path are the project's). */
    fun connect(r: DbRow, pid: String?): DbConnect {
        if (r.connectMode == "env") {
            val root = pid?.let { runCatching { projects.getObject().root(it) }.getOrNull() }
                ?: return DbConnect(null, "${r.name} reads ${r.envVar} from a project's .env, and no project is chosen.", "Open it from a project.")
            val url = readEnv(root, r.envVar.orEmpty())
                ?: return DbConnect(null, "There is no ${r.envVar} in ${root.fileName}/.env.", "Add it there, or connect ${r.name} another way.")
            if (DbUrls.driverOf(url) == null) return DbConnect(null, "${r.envVar} in .env is not a database address keel reads.", ADDRESS_HINT)
            return DbConnect(url)
        }
        if (r.driver == "sqlite") return DbConnect(kept(r) ?: address(r))
        return when (r.keepPassword) {
            "session" -> session[r.id]?.let { DbConnect(it) } ?: DbConnect(null,
                "keel keeps the password of ${r.name} only while it runs, and it started again since.", "Type the password again in Databases.")
            "never" -> DbConnect(null, "${r.name} keeps no password: keel would ask for it each time, which comes in a later version.",
                "Pick \"In keel (encrypted)\" or \"This session only\" under Keep in Databases.")
            else -> secrets.get(secretName(r.id))?.let { DbConnect(it) }
                ?: DbConnect(null, "The address of ${r.name} is gone.", "Edit the connection and set it again.")
        }
    }

    fun hasPassword(r: DbRow): Boolean = DbUrls.passwordOf(kept(r)) != null

    // ---------------------------------------------------------------- rows from before V22

    /**
     * A row saved before V22 has no driver: its address (the secret, else the masked `shown`) gives the fields once. Its
     * secret stays as it was, so the connection keeps working. Local and test connections keep what keel2 mcp's
     * keel_db_change did on them (a change after the person's OK in the Inbox): write_approve; staging and prod: read.
     */
    fun backfill() {
        synchronized(this) {
            val old = jdbc.query("SELECT id, kind, env, shown FROM db_connections WHERE driver IS NULL",
                { rs, _ -> listOf(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4)) })
            old.forEach { (id, kind, env, shown) ->
                val url = runCatching { secrets.get(secretName(id)) }.getOrNull() ?: shown
                val a = DbUrls.parse(url)
                val driver = a?.driver ?: kind
                val plain = a != null && a.params == null && a.secretParams == null && a.socket == null
                val mode = when {
                    a == null -> "url"
                    driver == "sqlite" -> "host"
                    a.socket != null && a.params == null && a.secretParams == null -> "socket"
                    plain -> "host"
                    else -> "url"
                }
                val access = if (env in DatabaseService.CHANGE_ENVS) "write_approve" else "read"
                jdbc.update(
                    "UPDATE db_connections SET driver = ?, connect_mode = ?, host = ?, port = ?, username = ?, default_db = ?, " +
                        "url_override = ?, socket_path = ?, agent_access = ?, keep_password = 'keel', updated_at = ? WHERE id = ? AND driver IS NULL",
                    driver, mode, a?.host, a?.port, a?.username, a?.database,
                    if (mode == "url") DbUrls.withoutPassword(url) else null, a?.socket, access, Time.now(), id,
                )
            }
        }
    }

    companion object {
        const val GLOBAL = "*"
        const val ADDRESS_HINT = "Use postgres://user:password@host:5432/db, mysql://user:password@host:3306/db or sqlite:path/to/file.db." // keel:allow-secret
        private val ENV_NAME = Regex("^[A-Za-z_][A-Za-z0-9_]{0,127}$")

        fun secretName(id: String) = "db.$id"

        /** A variable of the project's .env (the person's own file: keel reads the one value when it connects, never keeps it). */
        fun readEnv(root: Path, name: String): String? {
            if (!ENV_NAME.matches(name)) return null
            val f = root.resolve(".env")
            if (!Files.isRegularFile(f)) return null
            return runCatching { Files.readAllLines(f) }.getOrDefault(emptyList()).asReversed().firstNotNullOfOrNull { line ->
                val l = line.trim().removePrefix("export ").trim()
                if (l.startsWith("#") || !l.startsWith("$name=")) null
                else l.substringAfter('=').trim().removeSurrounding("\"").removeSurrounding("'").ifBlank { null }
            }
        }
    }
}
