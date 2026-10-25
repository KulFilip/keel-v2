package dev.keel.jetbrains.api

/**
 * Which keel project an IDE project is. keel usually runs in Docker, so its project root (`/projects/shop`) and the
 * IDE's base path (`/Users/ana/code/shop`) differ: compare the whole path first, then the folder name, then keel's
 * project name. A project picked by hand in the settings always wins.
 */
object ProjectMapper {
    data class Match(val project: Project, val how: String)

    fun match(basePath: String?, projects: List<Project>, pickedId: String? = null): Match? {
        if (!pickedId.isNullOrBlank()) projects.firstOrNull { it.id == pickedId }?.let { return Match(it, "picked") }
        if (projects.isEmpty()) return null
        val base = basePath?.let(::normPath)
        if (base != null) {
            projects.firstOrNull { it.root.isNotBlank() && normPath(it.root) == base }?.let { return Match(it, "path") }
            val folder = lastSegment(base)
            projects.filter { it.root.isNotBlank() && lastSegment(normPath(it.root)).equals(folder, ignoreCase = true) }
                .singleOrNull()?.let { return Match(it, "folder") }
            projects.filter { slug(it.name) == slug(folder) || slug(it.id) == slug(folder) }
                .singleOrNull()?.let { return Match(it, "name") }
        }
        return projects.singleOrNull()?.let { Match(it, "only") }
    }

    fun normPath(p: String): String = p.trim().replace('\\', '/').trimEnd('/').ifEmpty { "/" }

    fun lastSegment(p: String): String = p.substringAfterLast('/')

    private fun slug(s: String): String = s.lowercase().filter { it.isLetterOrDigit() }
}
