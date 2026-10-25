package dev.keel.jetbrains.api

import java.io.File
import java.util.concurrent.TimeUnit

/**
 * "Use keel2 on this computer": runs `keel2 auth key`, which prints the keel's sign-in key for the person's own
 * terminal apps. keel accepts it as `Authorization: Bearer <key>`. The key is kept in memory only and never logged.
 */
object LocalKey {
    class Failed(message: String, val hint: String? = null) : Exception(message)

    /** Where keel2 usually is: the PATH, then the install script's places. An IDE started from the Dock has a short PATH. */
    fun candidates(home: String = System.getProperty("user.home"), path: String = System.getenv("PATH").orEmpty()): List<File> =
        (path.split(File.pathSeparator).filter { it.isNotBlank() } + listOf("$home/.local/bin", "/usr/local/bin", "/opt/homebrew/bin"))
            .distinct().map { File(it, "keel2") }

    fun find(candidates: List<File> = candidates()): File? = candidates.firstOrNull { it.isFile && it.canExecute() }

    /** The sign-in key, or [Failed] with keel2's own words (never the key itself). */
    fun read(keel2: File? = find(), timeoutSeconds: Long = 30): String {
        val exe = keel2 ?: throw Failed("keel2 was not found.", "Install keel (install.sh) or pair with a code instead.")
        val pb = ProcessBuilder(exe.absolutePath, "auth", "key").redirectErrorStream(false)
        val home = System.getProperty("user.home")
        // docker and keel2's helpers live in these places on a Mac; the IDE may not have them in its PATH
        pb.environment()["PATH"] = listOf(pb.environment()["PATH"].orEmpty(), "/usr/local/bin", "/opt/homebrew/bin", "$home/.local/bin", "/usr/bin", "/bin")
            .filter { it.isNotBlank() }.joinToString(File.pathSeparator)
        val p = try {
            pb.start()
        } catch (e: Exception) {
            throw Failed("Could not run keel2: ${e.message}")
        }
        p.outputStream.close()
        val out = p.inputStream.bufferedReader().readText()
        val err = p.errorStream.bufferedReader().readText()
        if (!p.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
            p.destroyForcibly()
            throw Failed("keel2 auth key did not answer in $timeoutSeconds s.")
        }
        val key = out.lines().map { it.trim() }.lastOrNull { it.isNotEmpty() }
        if (p.exitValue() != 0 || key.isNullOrEmpty() || key.contains(' ')) {
            val why = stripAnsi(err.ifBlank { out }).lines().map { it.trim() }.filter { it.isNotEmpty() }
            throw Failed(why.firstOrNull() ?: "keel2 auth key printed no key.", why.drop(1).firstOrNull())
        }
        return key
    }

    private fun stripAnsi(s: String) = s.replace(Regex("\u001B\\[[0-9;]*[A-Za-z]"), "")
}
