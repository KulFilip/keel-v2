package keel.api.plugins

/**
 * A database address taken apart. [password] and [secretParams] live in memory only: the table keeps the other parts,
 * the whole address stays in keel's secret store.
 */
data class DbAddress(
    val driver: String,
    val host: String? = null,
    val port: Int? = null,
    val username: String? = null,
    val password: String? = null,
    /** the database; for SQLite, the file */
    val database: String? = null,
    /** a Unix socket: PostgreSQL's socket folder, MySQL's socket file */
    val socket: String? = null,
    /** the query after `?` without the user, the password, the socket and secrets (`sslmode=require`) */
    val params: String? = null,
    /** query parameters that hold a secret (`token=…`, `sslpassword=…`), kept only with the password */
    val secretParams: String? = null,
)

/** Reads and writes database addresses: postgres://, postgresql://, mysql://, mariadb://, sqlite:, with or without jdbc:. */
object DbUrls {
    val DRIVERS = listOf("mysql", "mariadb", "postgres", "sqlite")
    private val SCHEMES = mapOf(
        "postgres" to "postgres", "postgresql" to "postgres", "mysql" to "mysql", "mariadb" to "mariadb",
        "sqlite" to "sqlite", "sqlite3" to "sqlite",
    )
    private val SECRET_NAMES = Regex("^(password|passwd|pwd|pass|secret|token|api_?key|access_?token|sslpassword)$", RegexOption.IGNORE_CASE)

    /** The engine's kind of a driver: MariaDB speaks MySQL. */
    fun kindOf(driver: String): String = if (driver == "mariadb") "mysql" else driver

    fun defaultPort(driver: String): Int? = when (driver) {
        "postgres" -> 5432
        "mysql", "mariadb" -> 3306
        else -> null
    }

    fun label(driver: String): String = when (driver) {
        "postgres" -> "PostgreSQL"
        "mysql" -> "MySQL"
        "mariadb" -> "MariaDB"
        "sqlite" -> "SQLite"
        else -> driver
    }

    /** The driver an address names (mariadb stays mariadb), or null when keel cannot read it. */
    fun driverOf(url: String): String? =
        SCHEMES[url.trim().removePrefix("jdbc:").substringBefore(":").substringBefore("+").lowercase()]

    fun parse(url: String): DbAddress? {
        val raw = url.trim().removePrefix("jdbc:")
        val driver = driverOf(raw) ?: return null
        if (driver == "sqlite") {
            val path = raw.replace(Regex("^sqlite3?:(//)?", RegexOption.IGNORE_CASE), "")
            return DbAddress("sqlite", database = decode(path).ifBlank { null })
        }
        if (!raw.contains("://")) return DbAddress(driver)
        val rest = raw.substringAfter("://").substringBefore('#')
        val at = userinfoEnd(rest)
        val userinfo = if (at >= 0) rest.substring(0, at) else null
        val after = if (at >= 0) rest.substring(at + 1) else rest
        val hostEnd = after.indexOfFirst { it == '/' || it == '?' }.let { if (it < 0) after.length else it }
        val hostPort = after.substring(0, hostEnd)
        val tail = after.substring(hostEnd)
        val path = tail.substringBefore('?').removePrefix("/")
        val query = if ('?' in tail) tail.substringAfter('?') else ""
        var user = userinfo?.substringBefore(':')?.let(::decode)?.ifEmpty { null }
        var password = userinfo?.takeIf { ':' in it }?.substringAfter(':')?.let(::decode)
        val (host, port) = hostAndPort(hostPort)
        var socket: String? = null
        val kept = mutableListOf<String>()
        val secret = mutableListOf<String>()
        query.split('&', ';').filter { it.isNotBlank() }.forEach { p ->
            val k = p.substringBefore('=')
            val v = decode(p.substringAfter('=', ""))
            when {
                k.equals("user", true) && user == null -> user = v
                k.equals("password", true) && password == null -> password = v
                driver == "postgres" && k == "host" && v.startsWith("/") -> socket = v
                driver != "postgres" && (k == "unix_socket" || k == "socket") -> socket = v
                SECRET_NAMES.matches(k) -> secret += p
                else -> kept += p
            }
        }
        return DbAddress(driver, host?.ifBlank { null }, port, user, password, decode(path).ifBlank { null }, socket,
            kept.joinToString("&").ifEmpty { null }, secret.joinToString("&").ifEmpty { null })
    }

    private val QUERY_START = Regex("[?;][A-Za-z_][\\w.\\-]*=")

    /**
     * Where user[:password] ends in [rest] (the address after scheme://), or -1 when it has none. A password may hold an
     * unencoded @ / ?: the LAST @ before the query, when the text before it is user:password (its : before its first @);
     * else the @ of a clean user@host (an @ after the host is in the path). keel 0.18.55: the first @ of the authority
     * left a password's tail (p@ss/w@rd) in the shown address. Same rule as the engine's masked_url.
     */
    fun userinfoEnd(rest: String): Int {
        val q = QUERY_START.find(rest)?.range?.first ?: rest.length
        val at = if (q > 0) rest.lastIndexOf('@', q - 1) else -1
        if (at < 0) return -1
        val info = rest.substring(0, at)
        if ('@' !in info) return at
        val colon = info.indexOf(':')
        if (colon >= 0 && colon < info.indexOf('@')) return at
        return rest.split('/', '?', '#', limit = 2)[0].indexOf('@')
    }

    private fun hostAndPort(s: String): Pair<String?, Int?> {
        if (s.startsWith("[")) {
            val end = s.indexOf(']')
            if (end > 0) return s.substring(1, end) to s.substring(end + 1).removePrefix(":").toIntOrNull()
        }
        val colon = s.lastIndexOf(':')
        return if (colon >= 0 && s.indexOf(':') == colon) s.substring(0, colon) to s.substring(colon + 1).toIntOrNull() else s to null
    }

    /** The address, with the password (and secret parameters) only when [withPassword]. */
    fun build(a: DbAddress, withPassword: Boolean = true): String {
        if (a.driver == "sqlite") return "sqlite:" + (a.database ?: "")
        val auth = a.username?.takeIf { it.isNotEmpty() }?.let { u ->
            enc(u) + (if (withPassword && !a.password.isNullOrEmpty()) ":" + enc(a.password) else "") + "@"
        } ?: ""
        val params = mutableListOf<String>()
        val host = if (a.socket != null) {
            params += if (a.driver == "postgres") "host=${enc(a.socket)}" else "unix_socket=${enc(a.socket)}"
            if (a.driver == "postgres") "" else "localhost"
        } else {
            val h = a.host.orEmpty()
            (if (':' in h) "[$h]" else h) + (a.port?.let { ":$it" } ?: "")
        }
        a.params?.let { params += it }
        if (withPassword) a.secretParams?.let { params += it }
        return "${a.driver}://$auth$host/${a.database?.let(::enc).orEmpty()}" + (if (params.isEmpty()) "" else "?" + params.joinToString("&"))
    }

    /** The address without any secret, to keep in the table and to show; one keel cannot read gets its secrets as •••. */
    fun withoutPassword(url: String): String = parse(url)?.let { build(it, withPassword = false) } ?: DatabaseService.shownOf(url)

    /** The address with this password (none: as it is without one). */
    fun withPassword(url: String, password: String?): String {
        val a = parse(url) ?: return url
        return build(a.copy(password = password?.ifEmpty { null } ?: a.password))
    }

    fun passwordOf(url: String?): String? = url?.let { parse(it)?.password?.ifEmpty { null } }

    private const val UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"

    fun enc(s: String): String = buildString {
        s.toByteArray(Charsets.UTF_8).forEach { b ->
            val c = (b.toInt() and 0xff).toChar()
            if (c in UNRESERVED) append(c) else append('%').append("%02X".format(b.toInt() and 0xff))
        }
    }

    /** Percent-decoding only (a + stays a +). A broken escape keeps its text. */
    fun decode(s: String): String {
        if ('%' !in s) return s
        val out = java.io.ByteArrayOutputStream()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '%' && i + 2 < s.length && s.substring(i + 1, i + 3).toIntOrNull(16) != null) {
                out.write(s.substring(i + 1, i + 3).toInt(16))
                i += 3
            } else {
                out.write(c.toString().toByteArray(Charsets.UTF_8))
                i++
            }
        }
        return out.toString(Charsets.UTF_8)
    }
}
