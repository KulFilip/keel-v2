package dev.keel.jetbrains.ide

import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import dev.keel.jetbrains.api.ChangedFile
import dev.keel.jetbrains.api.ReviewComment
import dev.keel.jetbrains.api.ReviewThread
import dev.keel.jetbrains.api.prChangeRanges
import dev.keel.jetbrains.core.ReviewMode
import dev.keel.jetbrains.editor.ReviewModeMarks
import dev.keel.jetbrains.settings.KeelSettings
import dev.keel.jetbrains.ui.KeelReviewWidget
import dev.keel.jetbrains.ui.ReviewModeBanner

/** Review mode in a headless IDE: an open changed file gets the PR's gutter marks and threads; Exit removes them. */
class ReviewModeIdeTest : BasePlatformTestCase() {
    private val text = "class Prefs {\n    private val cache = mutableMapOf<String, Int>()\n    fun savePageSize(user: String, size: Int) {\n" +
        "        cache[user] = size\n    }\n    fun pageSize(user: String) = cache[user] ?: 20\n}\n"
    private val diff = "@@ -1,3 +1,7 @@\n class Prefs {\n-    fun pageSize(user: String) = 20\n+    private val cache = mutableMapOf<String, Int>()\n" +
        "+    fun savePageSize(user: String, size: Int) {\n+        cache[user] = size\n+    }\n+    fun pageSize(user: String) = cache[user] ?: 20\n }\n" +
        "@@ -9,2 +13,1 @@\n x\n-gone\n"

    override fun setUp() {
        super.setUp()
        KeelSettings.get().state.url = "http://127.0.0.1:9"
        KeelSettings.get().state.mode = KeelSettings.MODE_PAIRED
    }

    override fun tearDown() {
        try {
            ReviewMode.of(project).exit()
        } finally {
            super.tearDown()
        }
    }

    fun `test review mode marks an open file and Exit removes the marks`() {
        val file = myFixture.addFileToProject("src/Prefs.kt", text).virtualFile
        myFixture.openFileInEditor(file)
        val editor = myFixture.editor
        val mode = ReviewMode.of(project)
        val threads = listOf(
            ReviewThread("T1", "src/Prefs.kt", 2, comments = listOf(ReviewComment("c1", "bo", "A plain map: two saves can lose a write."))),
            ReviewThread("T2", "src/Prefs.kt", 9, outdated = true, comments = listOf(ReviewComment("c2", "bo", "old note"))),
        )
        mode.setForTest("pr:7", listOf(ChangedFile("src/Prefs.kt", "modified", 5, 2)), mapOf("src/Prefs.kt" to prChangeRanges(diff)), threads)
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()

        assertEquals("src/Prefs.kt", mode.relPath(file))
        val marks = ReviewModeMarks.of(project)
        assertEquals(2, marks.markCount(editor)) // the modified block and the removal at the end
        assertEquals(2, editor.inlayModel.getBlockElementsInRange(0, editor.document.textLength).size) // a thread on line 2, the outdated one on top
        assertNotNull(marks.rangeAtCaret(editor.also { it.caretModel.moveToOffset(editor.document.getLineStartOffset(3)) }, file))
        assertNotNull(ReviewModeBanner().collectNotificationData(project, file))
        assertTrue(KeelReviewWidget(project).getText().startsWith("Reviewing #7 · 1 file · 2 threads wait · Exit review mode"))

        mode.exit()
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        assertEquals(0, marks.markCount(editor))
        assertEquals(0, editor.inlayModel.getBlockElementsInRange(0, editor.document.textLength).size)
        assertNull(ReviewModeBanner().collectNotificationData(project, file))
        assertEquals("", KeelReviewWidget(project).getText())
    }
}
