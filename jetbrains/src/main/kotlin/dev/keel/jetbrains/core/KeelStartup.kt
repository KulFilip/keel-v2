package dev.keel.jetbrains.core

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

class KeelStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        KeelProjectService.of(project).start()
    }
}
