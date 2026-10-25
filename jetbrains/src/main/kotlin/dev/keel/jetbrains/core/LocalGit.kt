package dev.keel.jetbrains.core

import com.intellij.openapi.project.Project
import java.io.File
import java.util.concurrent.TimeUnit

/** The few git reads the plugin needs in the project folder (KeelBot's changed lines and its diffs). Call off the EDT. */
object LocalGit {
    fun run(project: Project, vararg args: String, timeoutSeconds: Long = 20): String? {
        val base = project.basePath ?: return null
        return try {
            val p = ProcessBuilder(listOf("git") + args).directory(File(base)).redirectErrorStream(false).start()
            p.outputStream.close()
            val out = p.inputStream.bufferedReader().readText()
            p.errorStream.bufferedReader().readText()
            if (!p.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
                p.destroyForcibly()
                null
            } else if (p.exitValue() == 0) {
                out
            } else {
                null
            }
        } catch (e: Exception) {
            null
        }
    }

    /** The file as the last commit has it ("" for a new file). */
    fun headText(project: Project, path: String): String = run(project, "show", "HEAD:$path") ?: ""

    /** `git diff -U0 HEAD -- path`: the changed hunks of the file. */
    fun diffU0(project: Project, path: String): String = run(project, "diff", "-U0", "HEAD", "--", path) ?: ""
}
