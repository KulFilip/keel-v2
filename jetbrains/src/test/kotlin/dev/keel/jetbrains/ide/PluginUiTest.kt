package dev.keel.jetbrains.ide

import com.intellij.openapi.editor.ex.EditorEx
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import dev.keel.jetbrains.api.ChoiceInfo
import dev.keel.jetbrains.api.ClarifyQuestion
import dev.keel.jetbrains.api.GateForm
import dev.keel.jetbrains.api.QuestionOption
import dev.keel.jetbrains.api.ReviewComment
import dev.keel.jetbrains.api.ReviewThread
import dev.keel.jetbrains.api.Waiting
import dev.keel.jetbrains.core.KeelProjectService
import dev.keel.jetbrains.editor.ComponentInlays
import dev.keel.jetbrains.editor.ThreadComponent
import dev.keel.jetbrains.settings.KeelConfigurable
import dev.keel.jetbrains.settings.KeelSettings
import dev.keel.jetbrains.ui.FlowsPanel
import dev.keel.jetbrains.ui.GatePanel
import dev.keel.jetbrains.ui.KeelBotPanel
import dev.keel.jetbrains.ui.ReviewPanel
import dev.keel.jetbrains.ui.StartFlowDialog

/**
 * The plugin inside a headless IDE: its services and extensions load from plugin.xml, the panels build, a gate form
 * renders keel's choices, and a review thread sits between the lines of an editor. keel itself is not reached (the
 * address is a closed port).
 */
class PluginUiTest : BasePlatformTestCase() {
    override fun setUp() {
        super.setUp()
        KeelSettings.get().state.url = "http://127.0.0.1:9"
        KeelSettings.get().state.mode = KeelSettings.MODE_PAIRED
    }

    fun `test the tool window panels build without keel`() {
        val d = Disposer.newDisposable()
        try {
            FlowsPanel(project, d)
            ReviewPanel(project, d)
            KeelBotPanel(project, d)
            KeelProjectService.of(project).start()
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        } finally {
            Disposer.dispose(d)
        }
    }

    fun `test a gate shows keel's named choices and the clarify questions`() {
        val w = Waiting(
            title = "Approve the spec?",
            id = "q-1",
            choices = listOf("approve", "change"),
            choiceInfo = listOf(
                ChoiceInfo("approve", "Approve", "The test step starts.", "none", true),
                ChoiceInfo("change", "Change it", "keel rewrites the spec and asks again.", "required"),
            ),
            questions = listOf(ClarifyQuestion("q1", "Partial refunds too?", options = listOf(QuestionOption("Yes", recommended = true), QuestionOption("No")))),
        )
        val panel = GatePanel(project, GateForm.of("t1", w)) {}
        panel.setSize(500, 800)
        panel.doLayout()
        assertTrue(panel.preferredSize.height > 100)
    }

    fun `test a review thread sits between the lines of an editor`() {
        myFixture.configureByText("Prefs.kt", "class Prefs {\n    private val cache = mutableMapOf<String, Int>()\n}\n")
        val editor = myFixture.editor as EditorEx
        val d = Disposer.newDisposable()
        try {
            val inlays = ComponentInlays(editor, d)
            val t = ReviewThread("T1", "src/Prefs.kt", 2, comments = listOf(ReviewComment("c1", "bo", "This is a plain map. Should it be a ConcurrentHashMap?")))
            val c = ThreadComponent(project, t) { inlays.relayout(it) }
            assertNotNull(inlays.add(editor.document.getLineEndOffset(1), c))
            assertEquals(1, editor.inlayModel.getBlockElementsInRange(0, editor.document.textLength).size)
            assertSame(editor.contentComponent, c.parent)
            inlays.clear()
            assertEquals(0, editor.inlayModel.getBlockElementsInRange(0, editor.document.textLength).size)
        } finally {
            Disposer.dispose(d)
        }
    }

    fun `test the Start a flow dialog and the settings page build`() {
        val dialog = StartFlowDialog(project, StartFlowDialog.Prefill("Refunds for paid orders\n\nCode: orders.py:6-9", "the selection in orders.py"))
        try {
            assertNotNull(dialog.preferredFocusedComponent) // init() built the form without a DSL error
            assertEquals("Start a keel flow", dialog.title)
        } finally {
            Disposer.dispose(dialog.disposable)
        }
        val page = KeelConfigurable(project)
        assertNotNull(page.createComponent())
        assertFalse(page.isModified)
        page.disposeUIResources()
    }
}
