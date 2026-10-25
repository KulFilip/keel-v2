package dev.keel.jetbrains.ui

import com.intellij.openapi.Disposable
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBFont
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import dev.keel.jetbrains.api.ActFilter
import dev.keel.jetbrains.api.ActKind
import dev.keel.jetbrains.api.ActivityLine
import dev.keel.jetbrains.api.EngineEvent
import dev.keel.jetbrains.api.FlowLive
import dev.keel.jetbrains.api.activityOf
import dev.keel.jetbrains.api.activityOfStep
import dev.keel.jetbrains.api.clock
import dev.keel.jetbrains.core.KeelProjectService
import dev.keel.jetbrains.ui.KeelUi.full
import java.awt.BorderLayout
import java.awt.Component
import java.awt.Dimension
import java.awt.datatransfer.StringSelection
import javax.swing.ButtonGroup
import javax.swing.JPanel
import javax.swing.JToggleButton
import javax.swing.SwingUtilities
import javax.swing.Timer

/**
 * A flow's live activity in the Flows tab: "Now" (the current step, each running agent with model, effort, time and
 * usage so far) and the feed (one line per agent action, newest at the bottom), fed by the project's one live stream
 * (LiveHub) through [accept]. Opened mid-run, it first reads the flow's recent agent calls (/api/jobs + their steps).
 */
class FlowActivity(
    private val project: Project,
    private val pid: String,
    val threadId: String,
    parent: Disposable,
    loadBacklog: Boolean = true,
) : JPanel(BorderLayout()), Disposable {
    val live = FlowLive()
    private val lines = ArrayList<ActivityLine>()
    private val keys = HashSet<String>()
    private val opened = HashSet<String>()
    private var filter = ActFilter.ALL
    private var paused = false
    private var currentStep: String? = null

    private val now = KeelUi.stack()
    private val feed = KeelUi.scrollStack().apply { border = JBUI.Borders.empty(4, 6) }
    private val scroll = JBScrollPane(feed).apply {
        preferredSize = Dimension(JBUI.scale(400), JBUI.scale(300))
        verticalScrollBar.unitIncrement = JBUI.scale(16)
        border = JBUI.Borders.customLine(KeelUi.LINE, 1)
    }
    private val pause = JToggleButton("Pause auto-scroll")
    private val empty = KeelUi.muted("Nothing yet: the agents' reads, edits, commands and tests show here as they happen.")
    private val tick = Timer(1000) { if (live.running.isNotEmpty()) renderNow() }

    init {
        Disposer.register(parent, this)
        isOpaque = false
        val top = KeelUi.stack()
        top.add(now.full())
        top.add(KeelUi.gap(8))
        val group = ButtonGroup()
        val chips = ActFilter.entries.map { f ->
            JToggleButton(f.label, f == filter).apply {
                group.add(this)
                addActionListener { setFilter(f) }
            }
        }
        pause.addActionListener {
            paused = pause.isSelected
            pause.text = if (paused) "Resume auto-scroll" else "Pause auto-scroll"
            if (!paused) toBottom()
        }
        top.add(KeelUi.row(KeelUi.muted("ACTIVITY"), *chips.toTypedArray(), pause, KeelUi.link("Copy log") { copyLog() }, gap = 6).full())
        top.add(KeelUi.gap(4))
        add(top, BorderLayout.NORTH)
        add(scroll, BorderLayout.CENTER)
        feed.add(empty.full())
        renderNow()
        tick.start()
        if (loadBacklog) backlog()
    }

    /** The step the flow view says it is at (before any event came). */
    fun setStep(step: String?) {
        currentStep = step
        renderNow()
    }

    /** One event of the live stream for this flow. */
    fun accept(ev: EngineEvent) {
        if (ev.threadId != threadId) return
        live.apply(ev)
        activityOf(ev, live::agentOf)?.let { add(it) }
        if (ev.type.startsWith("agent.") && ev.type != "agent.step" || ev.type.startsWith("step.") || ev.type.startsWith("thread.")) renderNow()
    }

    fun lineCount(): Int = lines.size

    fun shownCount(): Int = lines.count { filter.matches(it) }

    fun setFilter(f: ActFilter) {
        filter = f
        feed.removeAll()
        lines.filter { f.matches(it) }.ifEmpty { null }?.forEach { feed.add(row(it).full()) } ?: feed.add(empty.full())
        feed.revalidate()
        feed.repaint()
        toBottom()
    }

    fun text(): String = lines.joinToString("\n") { it.plain() }

    private fun add(line: ActivityLine) {
        if (!keys.add(line.key)) return
        val atBottom = scroll.verticalScrollBar.let { it.value + it.visibleAmount >= it.maximum - JBUI.scale(24) }
        lines += line
        if (lines.size > MAX) {
            val drop = lines.size - MAX
            repeat(drop) { keys.remove(lines.removeAt(0).key) }
            setFilter(filter)
            return
        }
        if (!filter.matches(line)) return
        if (feed.componentCount == 1 && feed.getComponent(0) === empty) feed.remove(empty)
        feed.add(row(line).full())
        feed.revalidate()
        // newest at the bottom: follow it, unless paused or the person scrolled up to read
        if (!paused && atBottom) toBottom()
    }

    private fun toBottom() = SwingUtilities.invokeLater {
        feed.revalidate()
        scroll.verticalScrollBar.value = scroll.verticalScrollBar.maximum
    }

    private fun renderNow() {
        now.removeAll()
        now.add(KeelUi.row(KeelUi.bold("Now"), KeelUi.muted(live.step ?: currentStep ?: "—")).full())
        if (live.running.isEmpty()) {
            now.add(KeelUi.muted("No agent runs right now.").full())
        } else {
            live.running.values.forEach { a -> now.add(KeelUi.row(KeelUi.chip("●", KeelUi.OK, KeelUi.CARD_BG), JBLabel(a.line())).full()) }
        }
        now.revalidate()
        now.repaint()
    }

    private fun row(l: ActivityLine): JPanel {
        val p = KeelUi.stack().apply { border = JBUI.Borders.empty(1, 0) }
        val mark = when (l.kind) {
            ActKind.READ -> "·"
            ActKind.EDIT -> "✎"
            ActKind.COMMAND -> "›"
            ActKind.TEST -> if ((l.failed ?: 0) > 0) "✗" else "✓"
            ActKind.GUARD -> "⊘"
            ActKind.GATE -> "◆"
            ActKind.STEP -> "▪"
            ActKind.AGENT -> "●"
            ActKind.TEXT -> "“"
            ActKind.ERROR -> "!"
        }
        val color = when {
            l.ok == false || l.kind == ActKind.ERROR || l.kind == ActKind.GUARD || (l.failed ?: 0) > 0 -> KeelUi.BAD
            l.kind == ActKind.TEST -> KeelUi.OK
            l.kind == ActKind.GATE -> KeelUi.ACCENT
            else -> UIUtil.getLabelForeground()
        }
        val parts = mutableListOf<Component>(
            KeelUi.muted(clock(l.at).ifBlank { "--:--" }).apply { font = JBFont.small() },
            JBLabel(mark).apply { foreground = color },
        )
        l.agent?.let { parts += KeelUi.muted(it).apply { font = JBFont.small().asBold() } }
        val path = l.path
        parts += if (path != null) {
            KeelUi.link(l.title) { if (!KeelUi.openFile(project, path, null)) KeelNotifier.info(project, "$path is not in this project folder") }
        } else {
            JBLabel(l.title).apply { foreground = color }
        }
        if (l.added > 0 || l.removed > 0) {
            parts += JBLabel("+${l.added}").apply { foreground = KeelUi.OK; font = JBFont.small() }
            parts += JBLabel("−${l.removed}").apply { foreground = KeelUi.BAD; font = JBFont.small() }
        }
        l.exit?.let { parts += KeelUi.muted("exit $it") }
        val detail = l.detail?.takeIf { it.isNotBlank() }
        if (detail != null) {
            val open = l.key in opened
            parts += KeelUi.link(if (open) "▾ hide" else "▸ ${if (l.kind == ActKind.EDIT) "diff" else "output"}") {
                if (!opened.remove(l.key)) opened += l.key
                setFilter(filter)
            }
        }
        p.add(KeelUi.row(*parts.toTypedArray(), gap = 6).full())
        if (detail != null && l.key in opened) {
            val shown = detail.lines().let { ls -> if (ls.size > 60) (ls.take(60) + "… (${ls.size - 60} more lines: Copy log has the titles; the job page has all)").joinToString("\n") else detail }
            p.add(JBTextArea(shown).apply {
                isEditable = false
                font = JBUI.Fonts.create(java.awt.Font.MONOSPACED, JBFont.small().size)
                background = KeelUi.CARD_BG
                border = JBUI.Borders.empty(4, 8)
                lineWrap = true
            }.full())
        }
        return p
    }

    private fun copyLog() {
        CopyPasteManager.getInstance().setContents(StringSelection(text()))
        KeelNotifier.info(project, "The flow's activity is on the clipboard", "${lines.size} lines")
    }

    /** The flow's recent agent calls and their steps, for a flow opened while it runs (or after). */
    private fun backlog() {
        val svc = KeelProjectService.of(project)
        svc.io({ api ->
            val jobs = api.jobs(pid, 80).filter { it.threadId == threadId }.sortedBy { it.startedAt }.takeLast(6)
            jobs.map { j -> j to runCatching { api.jobSteps(j.id).steps }.getOrDefault(emptyList()) }
        }) { r ->
            r.onSuccess { list ->
                list.forEach { (job, _) -> live.start(job) }
                list.flatMap { (job, steps) -> steps.mapNotNull { s -> activityOfStep(s, job.agent, job.id) } }
                    .sortedBy { it.at }
                    .forEach { add(it) }
                renderNow()
                toBottom()
            }
        }
    }

    override fun dispose() {
        tick.stop()
    }

    companion object {
        const val MAX = 500
    }
}
