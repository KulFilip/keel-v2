package dev.keel.jetbrains.ui

import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBRadioButton
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.JBUI
import dev.keel.jetbrains.api.GateAction
import dev.keel.jetbrains.api.GateForm
import dev.keel.jetbrains.api.KeelException
import dev.keel.jetbrains.core.KeelProjectService
import dev.keel.jetbrains.ui.KeelUi.full
import java.awt.BorderLayout
import javax.swing.ButtonGroup
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener

/**
 * The question a flow waits at, answered as the web answers it ([GateForm]): keel's named choices, each saying what
 * happens, a reason box when the choice wants one, the questions of a clarify step, and Send. The answer is bound to
 * the question's id: when the flow already asks something else keel answers 409 and the panel says so.
 */
class GatePanel(
    private val project: Project,
    initial: GateForm,
    private val onDone: (String) -> Unit,
) : JPanel(BorderLayout()) {
    private var form = initial
    private val body = KeelUi.stack()
    private val send = JButton()
    private val problem = KeelUi.muted("").apply { foreground = KeelUi.BAD }
    private val why = JBTextArea(3, 30).apply {
        lineWrap = true
        wrapStyleWord = true
        border = JBUI.Borders.customLine(KeelUi.LINE, 1)
    }
    private val whyLabel = KeelUi.muted("")

    init {
        isOpaque = false
        val w = form.waiting
        body.add(KeelUi.row(KeelUi.chip("◆"), KeelUi.bold(w.title.ifBlank { "keel waits for you" }), gap = 6).full())
        if (w.detail.isNotBlank()) {
            body.add(KeelUi.gap(4))
            body.add(KeelUi.prose(w.detail.take(1500) + if (w.detail.length > 1500) "…" else "").full())
        }
        body.add(KeelUi.gap(6))
        val group = ButtonGroup()
        form.rows.forEach { r ->
            val rb = JBRadioButton(r.label, r.name == form.picked).apply {
                font = font.deriveFont(java.awt.Font.BOLD)
                isOpaque = false
                addActionListener { pick(r.name) }
            }
            group.add(rb)
            body.add(rb.full())
            if (r.description.isNotBlank()) body.add(KeelUi.muted(r.description).apply { border = JBUI.Borders.emptyLeft(24) }.full())
            body.add(KeelUi.gap(2))
        }
        form.questions.forEach { q ->
            body.add(KeelUi.gap(6))
            body.add(KeelUi.bold(q.question).full())
            q.why?.takeIf { it.isNotBlank() }?.let { body.add(KeelUi.muted(it).full()) }
            val qg = ButtonGroup()
            q.options.forEach { o ->
                val text = o.label + if (o.recommended) "  (keel suggests)" else ""
                val b = if (q.multiple) JBCheckBox(text, form.isPicked(q, o.label)) else JBRadioButton(text, form.isPicked(q, o.label)).also { qg.add(it) }
                b.isOpaque = false
                b.addActionListener { form = form.toggle(q, o.label); refresh() }
                body.add(b.full())
                o.description?.takeIf { it.isNotBlank() }?.let { body.add(KeelUi.muted(it).apply { border = JBUI.Borders.emptyLeft(24) }.full()) }
            }
            val own = JBTextField().apply { emptyText.text = "Or your own words" }
            own.document.addDocumentListener(onText { form = form.type(q, own.text); refresh() })
            body.add(own.full())
        }
        body.add(KeelUi.gap(6))
        body.add(whyLabel.full())
        body.add(why.full())
        why.document.addDocumentListener(onText { form = form.setWhy(why.text); refresh() })
        body.add(KeelUi.gap(6))
        send.addActionListener { submit() }
        send.putClientProperty("JButton.buttonType", "default")
        body.add(KeelUi.row(send, problem).full())
        add(KeelUi.card(body, KeelUi.ACCENT_BG, KeelUi.ACCENT), BorderLayout.CENTER)
        refresh()
    }

    private fun pick(name: String) {
        form = form.pick(name)
        refresh()
    }

    private fun refresh() {
        val label = form.reasonLabel
        whyLabel.text = label.orEmpty()
        whyLabel.isVisible = label != null
        why.isVisible = label != null
        send.text = "Send: ${form.sendLabel}"
        problem.text = ""
        revalidate()
    }

    private fun submit() {
        val p = form.problem()
        if (p.isNotEmpty()) {
            problem.text = p
            return
        }
        send.isEnabled = false
        val svc = KeelProjectService.of(project)
        when (val a = form.action()) {
            is GateAction.Stop -> svc.io({ it.stop(a.threadId) }) { r -> finish(r.exceptionOrNull(), "The flow stopped.") }
            is GateAction.Answer -> svc.io({ it.answer(a.threadId, a.body) }) { r -> finish(r.exceptionOrNull(), "Sent: ${form.sendLabel}") }
        }
    }

    private fun finish(e: Throwable?, ok: String) {
        send.isEnabled = true
        when {
            e == null -> {
                KeelProjectService.of(project).refresh()
                onDone(ok)
            }
            e is KeelException && e.status == 409 -> onDone("The flow asks something else now. Here is the new question.")
            else -> problem.text = KeelProjectService.say(e)
        }
    }

    private fun onText(f: () -> Unit) = object : DocumentListener {
        override fun insertUpdate(e: DocumentEvent) = f()
        override fun removeUpdate(e: DocumentEvent) = f()
        override fun changedUpdate(e: DocumentEvent) = f()
    }
}
