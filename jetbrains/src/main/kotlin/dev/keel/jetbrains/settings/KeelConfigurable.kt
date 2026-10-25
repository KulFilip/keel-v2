package dev.keel.jetbrains.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBRadioButton
import com.intellij.ui.components.JBTextField
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.panel
import dev.keel.jetbrains.api.KeelApi
import dev.keel.jetbrains.api.KeelException
import dev.keel.jetbrains.api.LocalKey
import dev.keel.jetbrains.core.KeelConnection
import dev.keel.jetbrains.core.KeelProjectService
import kotlinx.coroutines.runBlocking
import javax.swing.ButtonGroup
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JLabel
import dev.keel.jetbrains.api.Project as KeelProject

/** Settings › Tools › keel: the address, how to sign in (keel2 here, or a pairing code), and this project's keel project. */
class KeelConfigurable(private val project: Project) : Configurable {
    private val url = JBTextField()
    private val local = JBRadioButton("Use keel2 on this computer (runs keel2 auth key; the key stays in memory)")
    private val paired = JBRadioButton("Pair with a code (keel › Settings › Devices › Pair)")
    private val code = JBTextField(12)
    private val name = JBTextField()
    private val pair = JButton("Pair")
    private val pairState = JLabel("")
    private val test = JButton("Test connection")
    private val testState = JLabel("")
    private val notify = JBCheckBox("Show a balloon when a flow waits for me")
    private val projects = ComboBox<KeelProject?>()
    private val loadProjects = JButton("Load keel's projects")

    override fun getDisplayName() = "keel"

    override fun createComponent(): JComponent {
        ButtonGroup().apply { add(local); add(paired) }
        local.addActionListener { sync() }
        paired.addActionListener { sync() }
        pair.addActionListener { doPair() }
        test.addActionListener { doTest() }
        loadProjects.addActionListener { doLoadProjects() }
        projects.renderer = SimpleListCellRenderer.create("Found by its folder (automatic)") { p -> p?.let { "${it.name} (${it.root.ifBlank { it.id }})" } ?: "Found by its folder (automatic)" }
        return panel {
            row("keel address:") { cell(url).align(AlignX.FILL).comment("Default ${KeelSettings.DEFAULT_URL}; a Tailscale or tunnel address works too.") }
            buttonsGroup("Sign in") {
                row { cell(local) }
                row { cell(paired) }
                indent {
                    row("Code:") { cell(code); cell(pair); cell(pairState) }
                    row("This IDE is called:") { cell(name).align(AlignX.FILL) }
                }
            }
            row { cell(test); cell(testState) }
            group("This project") {
                row("keel project:") { cell(projects).align(AlignX.FILL); cell(loadProjects) }
                row { comment("keel runs in Docker, so its paths differ from the IDE's: the plugin matches the folder name, then the project name.") }
            }
            row { cell(notify) }
            row { comment("The device token is kept in the IDE's password safe, never in settings files or logs.") }
        }.also { reset() }
    }

    private fun sync() {
        val p = paired.isSelected
        code.isEnabled = p
        pair.isEnabled = p
        name.isEnabled = p
    }

    override fun isModified(): Boolean {
        val s = KeelSettings.get()
        return url.text.trim() != s.url || (if (paired.isSelected) KeelSettings.MODE_PAIRED else KeelSettings.MODE_LOCAL) != s.mode ||
            name.text.trim() != s.state.deviceName.orEmpty() || notify.isSelected != s.state.notify ||
            (projects.selectedItem as? KeelProject)?.id != KeelProjectSettings.of(project).state.projectId
    }

    override fun apply() {
        val s = KeelSettings.get()
        s.state.url = url.text.trim().ifEmpty { KeelSettings.DEFAULT_URL }
        s.state.mode = if (paired.isSelected) KeelSettings.MODE_PAIRED else KeelSettings.MODE_LOCAL
        s.state.deviceName = name.text.trim().ifEmpty { null }
        s.state.notify = notify.isSelected
        KeelProjectSettings.of(project).state.projectId = (projects.selectedItem as? KeelProject)?.id
        KeelConnection.get().reset()
    }

    override fun reset() {
        val s = KeelSettings.get()
        url.text = s.url
        local.isSelected = s.mode != KeelSettings.MODE_PAIRED
        paired.isSelected = s.mode == KeelSettings.MODE_PAIRED
        name.text = s.state.deviceName ?: KeelConnection.defaultDeviceName()
        notify.isSelected = s.state.notify
        val svc = KeelProjectService.of(project)
        projects.removeAllItems()
        projects.addItem(null)
        svc.projects.forEach { projects.addItem(it) }
        val picked = KeelProjectSettings.of(project).state.projectId
        projects.selectedItem = svc.projects.firstOrNull { it.id == picked }
        sync()
    }

    private fun background(work: () -> String, done: (String) -> Unit) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val msg = try {
                work()
            } catch (e: KeelException) {
                listOfNotNull(e.message, e.hint).joinToString(" ")
            } catch (e: LocalKey.Failed) {
                listOfNotNull(e.message, e.hint).joinToString(" ")
            } catch (e: Exception) {
                e.message ?: e.javaClass.simpleName
            }
            ApplicationManager.getApplication().invokeLater({ done(msg) }, ModalityState.any())
        }
    }

    private fun doPair() {
        val u = url.text.trim().ifEmpty { KeelSettings.DEFAULT_URL }
        val c = code.text.trim()
        if (c.isEmpty()) {
            pairState.text = "Type the code keel shows."
            return
        }
        val n = name.text.trim().ifEmpty { KeelConnection.defaultDeviceName() }
        pairState.text = "Pairing…"
        background({
            val res = runBlocking { KeelApi(u, token = { null }).pair(c, n) }
            KeelCredentials.setDeviceToken(u, res.token)
            "Paired with ${res.keel.name} ${res.keel.version} as \"${res.device.name}\"."
        }) {
            pairState.text = it
            code.text = ""
            paired.isSelected = true
            sync()
        }
    }

    private fun tokenFor(u: String): String = if (paired.isSelected) {
        KeelCredentials.deviceToken(u) ?: throw KeelException(401, "Not paired with $u yet.", "Type keel's code and press Pair.")
    } else {
        LocalKey.read()
    }

    private fun doTest() {
        val u = url.text.trim().ifEmpty { KeelSettings.DEFAULT_URL }
        testState.text = "Testing…"
        background({
            val token = tokenFor(u)
            val api = KeelApi(u, token = { token })
            val h = runBlocking { api.health() }
            val list = runBlocking { api.projects() }
            "Connected: keel ${h.version}, ${list.size} project(s)."
        }) { testState.text = it }
    }

    private fun doLoadProjects() {
        val u = url.text.trim().ifEmpty { KeelSettings.DEFAULT_URL }
        background({
            val token = tokenFor(u)
            val list = runBlocking { KeelApi(u, token = { token }).projects() }
            ApplicationManager.getApplication().invokeLater({
                val picked = (projects.selectedItem as? KeelProject)?.id ?: KeelProjectSettings.of(project).state.projectId
                projects.removeAllItems()
                projects.addItem(null)
                list.forEach { projects.addItem(it) }
                projects.selectedItem = list.firstOrNull { it.id == picked }
            }, ModalityState.any())
            "${list.size} project(s)"
        }) { testState.text = it }
    }
}
