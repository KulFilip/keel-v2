package dev.keel.jetbrains.ui

import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.CollectionListModel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBRadioButton
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.ui.dsl.builder.Align
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.panel
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import dev.keel.jetbrains.api.CatalogProvider
import dev.keel.jetbrains.api.StartFlowBody
import dev.keel.jetbrains.api.WORKFLOW_BLURBS
import dev.keel.jetbrains.api.Workflow
import dev.keel.jetbrains.api.suggestWorkflow
import dev.keel.jetbrains.api.parseTokens
import dev.keel.jetbrains.api.titleFrom
import dev.keel.jetbrains.core.KeelProjectService
import dev.keel.jetbrains.ui.KeelUi.full
import java.awt.Component
import java.awt.Dimension
import javax.swing.ButtonGroup
import javax.swing.JComponent
import javax.swing.JList
import javax.swing.ListCellRenderer
import javax.swing.ListSelectionModel

/** Start a flow: a workflow of the project, a title, the request in the person's words, where, model, run mode. */
class StartFlowDialog(private val project: Project, private val prefill: Prefill?) : DialogWrapper(project, true) {
    data class Prefill(val request: String, val from: String)

    private val svc = KeelProjectService.of(project)
    private val workflows = CollectionListModel<Workflow>()
    private val workflowList = JBList(workflows)
    private var suggested: String? = null
    private val title = JBTextField()
    private val request = JBTextArea(6, 50).apply { lineWrap = true; wrapStyleWord = true }
    private val worktree = JBRadioButton("Its own worktree (you keep working here)", true)
    private val folder = JBRadioButton("This project folder")
    private val model = ComboBox<String>()
    private val effort = ComboBox<String>()
    private val manual = JBRadioButton("Ask at every gate", true)
    private val important = JBRadioButton("Only important")
    private val supervisor = JBRadioButton("Supervisor")
    private val cap = JBTextField("300k", 7)
    private var catalog: List<CatalogProvider> = emptyList()

    /** provider, mode, model id of each model row (row 0 is keel's default) */
    private val modelIds = mutableListOf<Triple<CatalogProvider, String, String>?>(null)

    init {
        setTitle("Start a keel flow")
        setOKButtonText("Start flow")
        ButtonGroup().apply { add(worktree); add(folder) }
        ButtonGroup().apply { add(manual); add(important); add(supervisor) }
        request.text = prefill?.request.orEmpty()
        title.text = prefill?.request?.let { titleFrom(it) }.orEmpty()
        title.emptyText.text = "A short name, e.g. Add refunds to orders"
        request.emptyText.text = "What should keel build? (your own words)"
        workflowList.selectionMode = ListSelectionModel.SINGLE_SELECTION
        workflowList.cellRenderer = WorkflowRenderer()
        workflowList.emptyText.text = "Loading the project's workflows…"
        model.addItem("keel's default")
        effort.addItem("default")
        model.addActionListener { fillEfforts() }
        init()
        load()
    }

    private fun load() {
        val pid = svc.pid ?: return
        svc.io({ it.workflows(pid) }) { r ->
            r.onSuccess { list ->
                workflows.replaceAll(list)
                suggested = suggestWorkflow(request.text, list.map { it.id })
                workflowList.setSelectedValue(list.firstOrNull { it.id == suggested } ?: list.firstOrNull(), true)
                if (list.isEmpty()) workflowList.emptyText.text = "This project has no workflows"
            }.onFailure { workflowList.emptyText.text = KeelProjectService.say(it) }
        }
        svc.io({ it.providerModels() }) { r ->
            r.onSuccess { c ->
                catalog = c
                c.forEach { p ->
                    p.modes.forEach { (mode, ms) ->
                        ms.forEach { m ->
                            modelIds += Triple(p, mode, m.id)
                            model.addItem("${p.label} · ${m.label}" + if (p.modes.size > 1) " ($mode)" else "")
                        }
                    }
                }
            }
        }
    }

    private fun fillEfforts() {
        val efforts = modelIds.getOrNull(model.selectedIndex)?.let { (p, mode, id) -> p.effortsOf(id, mode) }.orEmpty()
        effort.removeAllItems()
        effort.addItem("default")
        efforts.forEach { effort.addItem(it) }
    }

    override fun createCenterPanel(): JComponent = panel {
        prefill?.from?.let { from -> row { cell(KeelUi.muted("· from $from")) } }
        group("Workflow", indent = false) {
            row { cell(JBScrollPane(workflowList).apply { preferredSize = Dimension(JBUI.scale(520), JBUI.scale(170)) }).align(Align.FILL) }
        }
        row("Title") { cell(title).align(AlignX.FILL) }
        row { label("What should keel build? (your own words)") }
        row { cell(JBScrollPane(request).apply { preferredSize = Dimension(JBUI.scale(520), JBUI.scale(110)) }).align(Align.FILL) }
        buttonsGroup("Where") {
            row { cell(worktree) }
            row { cell(folder) }
        }
        row("Model") {
            cell(model)
            label("effort:")
            cell(effort)
        }
        row { comment("Each agent of the workflow has its model in keel's settings; this choice goes along as a flow option.") }
        buttonsGroup("Run mode") {
            row {
                cell(manual)
                cell(important)
                cell(supervisor)
                label("cap:")
                cell(cap)
                label("tokens")
            }
        }
        row { comment("keel never pushes. Tested commits land on a new branch.") }
    }

    override fun getPreferredFocusedComponent(): JComponent = if (title.text.isBlank()) title else request

    override fun doValidate() = when {
        workflowList.selectedValue == null -> com.intellij.openapi.ui.ValidationInfo("Pick a workflow.", workflowList)
        title.text.isBlank() -> com.intellij.openapi.ui.ValidationInfo("Give the flow a title.", title)
        parseTokens(cap.text) == -1 -> com.intellij.openapi.ui.ValidationInfo("A number of tokens, like 300k or 1.5m.", cap)
        else -> null
    }

    override fun doOKAction() {
        if (doValidate() != null) return super.doOKAction()
        val pid = svc.pid ?: return
        val wf = workflowList.selectedValue ?: return
        val body = StartFlowBody(
            workflowId = wf.id,
            title = title.text.trim(),
            request = request.text.trim().ifEmpty { null },
            where = if (worktree.isSelected) "worktree" else "folder",
            runMode = when {
                important.isSelected -> "important"
                supervisor.isSelected -> "auto"
                else -> "manual"
            },
            capTokens = parseTokens(cap.text).takeIf { it > 0 },
            options = buildMap {
                modelIds.getOrNull(model.selectedIndex)?.let { (p, mode, id) ->
                    put("provider", p.id)
                    put("mode", mode)
                    put("model", id)
                }
                (effort.selectedItem as? String)?.takeIf { effort.selectedIndex > 0 }?.let { put("effort", it) }
            }.ifEmpty { null },
        )
        isOKActionEnabled = false
        setErrorText(null)
        svc.io({ it.startFlow(pid, body) }) { r ->
            isOKActionEnabled = true
            r.onSuccess { t ->
                close(OK_EXIT_CODE)
                KeelNotifier.info(project, "keel started \"${t.title.ifBlank { body.title }}\"")
                KeelToolWindow.openFlow(project, t.threadId, focusGate = true)
            }.onFailure { setErrorText(KeelProjectService.say(it)) }
        }
    }

    private inner class WorkflowRenderer : ListCellRenderer<Workflow> {
        override fun getListCellRendererComponent(list: JList<out Workflow>, value: Workflow, index: Int, sel: Boolean, focus: Boolean): Component {
            val p = KeelUi.stack().apply {
                border = JBUI.Borders.empty(4, 8)
                isOpaque = true
                background = if (sel) UIUtil.getListSelectionBackground(focus) else UIUtil.getListBackground()
            }
            val name = KeelUi.bold(value.id).apply { if (sel) foreground = UIUtil.getListSelectionForeground(focus) }
            val head = if (value.id == suggested) KeelUi.row(name, KeelUi.chip("suggested")) else KeelUi.row(name)
            p.add(head.full())
            val blurb = WORKFLOW_BLURBS[value.id] ?: value.name.takeIf { it != value.id } ?: "${value.steps.size} steps"
            p.add(KeelUi.muted(blurb).apply { border = JBUI.Borders.emptyLeft(6) }.full())
            return p
        }
    }

    companion object {
        fun open(project: Project, prefill: Prefill?) {
            val svc = KeelProjectService.of(project)
            if (svc.pid == null) {
                KeelNotifier.error(project, "keel: no keel project here", KeelProjectService.say(svc.error).ifBlank { "Pick this project's keel project in Settings › Tools › keel." })
                ShowSettingsUtil.getInstance().showSettingsDialog(project, "keel")
                return
            }
            StartFlowDialog(project, prefill).show()
        }
    }
}
