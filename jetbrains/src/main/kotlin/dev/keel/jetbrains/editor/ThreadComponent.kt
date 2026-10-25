package dev.keel.jetbrains.editor

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import dev.keel.jetbrains.api.AiRun
import dev.keel.jetbrains.api.ReviewThread
import dev.keel.jetbrains.api.ThreadState2
import dev.keel.jetbrains.api.ago
import dev.keel.jetbrains.api.firstLine
import dev.keel.jetbrains.api.initials
import dev.keel.jetbrains.api.ktokens
import dev.keel.jetbrains.api.threadStateOf
import dev.keel.jetbrains.api.verdictLabel
import dev.keel.jetbrains.core.KeelProjectService
import dev.keel.jetbrains.core.ReviewSession
import dev.keel.jetbrains.ui.KeelNotifier
import dev.keel.jetbrains.ui.KeelUi
import dev.keel.jetbrains.ui.KeelUi.full
import java.awt.BorderLayout
import java.awt.Cursor
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.JButton
import javax.swing.JPanel

/**
 * A review thread inside the editor: a folded head (author · first line · status) that opens to the messages, keel's
 * "keel checked the code" card, and Reply / Is the reviewer right? / Address it / Resolve.
 */
class ThreadComponent(
    private val project: Project,
    private var thread: ReviewThread,
    private val onSize: (ThreadComponent) -> Unit,
) : JPanel(BorderLayout()) {
    private val session = ReviewSession.of(project)
    private var open = threadStateOf(thread, session.view?.me) == ThreadState2.WAITING
    private var busy: String? = null
    private var note: String? = null
    private var draftReply: String = ""

    val threadId: String get() = thread.id

    init {
        isOpaque = false
        border = JBUI.Borders.empty(4, 0)
        render()
    }

    fun update(t: ReviewThread) {
        thread = t
        render()
    }

    fun render() {
        removeAll()
        val me = session.view?.me
        val state = threadStateOf(thread, me)
        val first = thread.comments.firstOrNull()
        val body = KeelUi.stack()
        val head = KeelUi.row(
            KeelUi.muted(if (open) "▾" else "▸"),
            KeelUi.bold(first?.author ?: "?"),
            KeelUi.muted("\"" + firstLine(first?.body.orEmpty(), 70) + "\""),
            if (thread.comments.size > 1) KeelUi.muted("· ${thread.comments.size - 1} repl${if (thread.comments.size == 2) "y" else "ies"}") else KeelUi.muted(""),
            stateChip(state),
        ).apply {
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    open = !open
                    render()
                }
            })
        }
        body.add(head.full())
        if (open) {
            thread.comments.forEach { c ->
                body.add(KeelUi.gap(6))
                val who = KeelUi.row(KeelUi.avatar(c.author, initials(c.author)), KeelUi.bold(c.author), KeelUi.muted(ago(c.at).let { if (it.isBlank()) "" else "· $it" }))
                body.add(who.full())
                body.add(KeelUi.prose(c.body).apply { border = JBUI.Borders.emptyLeft(28) }.full())
            }
            session.judgeOf(thread.id)?.let { body.add(KeelUi.gap(8)); body.add(judgeCard(it).full()) }
            body.add(KeelUi.gap(8))
            val actions = mutableListOf<java.awt.Component>(
                JButton("Reply").apply { addActionListener { reply(draftReply) } },
                KeelUi.link("✦ Is the reviewer right?") { judge(again = session.ai.judges.containsKey(thread.id)) },
                KeelUi.link("✦ Address it") { address() },
                KeelUi.link(if (thread.resolved) "Reopen" else "Resolve") { resolve(!thread.resolved) },
            )
            busy?.let { actions += KeelUi.muted(it) }
            note?.let { actions += KeelUi.muted(it) }
            body.add(KeelUi.row(*actions.toTypedArray(), gap = 10).full())
        }
        add(KeelUi.card(body, UIUtil.getPanelBackground(), if (state == ThreadState2.WAITING) KeelUi.ACCENT else KeelUi.LINE), BorderLayout.CENTER)
        revalidate()
        repaint()
        onSize(this)
    }

    private fun stateChip(s: ThreadState2) = when (s) {
        ThreadState2.WAITING -> KeelUi.chip(s.label)
        ThreadState2.OPEN -> KeelUi.chip(s.label, UIUtil.getLabelForeground(), KeelUi.CARD_BG)
        ThreadState2.RESOLVED -> KeelUi.chip(s.label, KeelUi.OK, KeelUi.CARD_BG)
    }

    private fun judgeCard(run: AiRun): JPanel {
        val c = KeelUi.stack()
        val res = run.result
        val meta = listOfNotNull("keel checked the code", res?.tokens?.let { "~${ktokens(it)} tokens" }, res?.model).joinToString(" · ")
        c.add(KeelUi.row(KeelUi.chip("k"), KeelUi.bold(meta), KeelUi.link("×") { session.dismiss(thread.id) }).full())
        when {
            run.status == "running" -> c.add(KeelUi.muted("keel reads the code…").full())
            run.error != null -> c.add(KeelUi.prose(run.error).apply { foreground = KeelUi.BAD }.full())
            res != null -> {
                res.items.forEach { item ->
                    c.add(KeelUi.gap(4))
                    val color = when (item.verdict) {
                        "reviewer_right" -> KeelUi.OK
                        "author_right" -> KeelUi.BAD
                        else -> KeelUi.WARN
                    }
                    c.add(KeelUi.line(KeelUi.chip(verdictLabel(item.verdict), color, KeelUi.CARD_BG), text = KeelUi.prose(item.claim)).full())
                    if (item.why.isNotBlank()) c.add(KeelUi.prose(item.why).full())
                    item.fix?.takeIf { it.isNotBlank() }?.let { c.add(KeelUi.prose("Fix: $it").full()) }
                }
                res.text?.takeIf { res.items.isEmpty() && it.isNotBlank() }?.let { c.add(KeelUi.prose(it).full()) }
                c.add(KeelUi.gap(6))
                c.add(
                    KeelUi.row(
                        KeelUi.link("Use as my reply") { reply(res.reply ?: res.items.joinToString("\n") { it.why }) },
                        KeelUi.link("Address it (a small flow)") { address() },
                        KeelUi.link("Think harder") { judge(again = true, harder = true) },
                        KeelUi.link("Dismiss") { session.dismiss(thread.id) },
                        gap = 10,
                    ).full(),
                )
            }
        }
        return KeelUi.card(c, KeelUi.ACCENT_BG, KeelUi.ACCENT)
    }

    private fun reply(start: String) {
        val text = Messages.showMultilineInputDialog(project, "Your reply to ${thread.comments.firstOrNull()?.author ?: "the reviewer"}:", "Reply", start, null, null)
            ?: return
        if (text.isBlank()) return
        draftReply = ""
        work("Sending…") { done -> session.act({ api, pid, key -> api.reply(pid, key, thread.id, text.trim()) }) { done(it, "Sent.") } }
    }

    private fun resolve(resolved: Boolean) =
        work(if (resolved) "Resolving…" else "Reopening…") { done -> session.act({ api, pid, key -> api.resolve(pid, key, thread.id, resolved) }) { done(it, null) } }

    private fun judge(again: Boolean, harder: Boolean = false) =
        work("keel reads the code…") { done -> session.judge(thread.id, again, harder) { done(it, null) } }

    private fun address() = work("Starting a small flow…") { done ->
        session.call({ api, pid, key -> api.address(pid, key, thread.id) }) { r ->
            r.onSuccess { KeelNotifier.info(project, "keel started a flow to address it", it.title.ifBlank { it.flowId }) }
            done(r.exceptionOrNull(), r.getOrNull()?.let { "A flow addresses it: ${it.title}" })
        }
    }

    private fun work(label: String, run: ((Throwable?, String?) -> Unit) -> Unit) {
        busy = label
        note = null
        render()
        run { e, ok ->
            busy = null
            note = if (e != null) KeelProjectService.say(e) else ok
            render()
        }
    }
}
