package dev.keel.jetbrains.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class IdeLogicTest {
    private fun p(id: String, name: String, root: String) = Project(id = id, name = name, root = root)

    @Test
    fun `maps the IDE folder to keel's project by path, folder, name, or a pick`() {
        val list = listOf(p("p1", "shop", "/projects/shop"), p("p2", "Billing API", "/projects/billing"))
        assertEquals("p1", ProjectMapper.match("/projects/shop/", list)?.project?.id)
        assertEquals("folder", ProjectMapper.match("/Users/ana/code/shop", list)?.how)
        assertEquals("p2", ProjectMapper.match("/Users/ana/code/billing", list)?.project?.id)
        assertEquals("p2", ProjectMapper.match("/Users/ana/work/billing-api", listOf(p("p2", "Billing API", "/w/x"), p("p3", "other", "/w/y")))?.project?.id)
        assertEquals("picked", ProjectMapper.match("/Users/ana/code/shop", list, pickedId = "p2")?.how)
        assertNull(ProjectMapper.match("/Users/ana/code/unknown", list))
        assertEquals("only", ProjectMapper.match("/Users/ana/code/unknown", list.take(1))?.how)
        assertEquals("p1", ProjectMapper.match("C:\\code\\shop", list)?.project?.id)
    }

    @Test
    fun `finds file links in KeelBot's answer`() {
        val refs = fileRefs("Done. orders.py:39 now takes page and size; see src/db/Orders.kt:12-20 and v1.2 (not a file).")
        assertEquals(listOf("orders.py" to 39, "src/db/Orders.kt" to 12), refs.map { it.path to it.line })
        assertEquals("orders.py:39", "Done. orders.py:39 now".substring(refs[0].start, refs[0].end))
    }

    @Test
    fun `changed lines of a zero-context diff`() {
        val diff = "diff --git a/o.py b/o.py\n@@ -39 +39,4 @@ def list_orders\n-x\n+a\n+b\n+c\n+d\n@@ -50,2 +53,0 @@\n-y\n-z\n@@ -60 +60 @@\n-q\n+r\n"
        assertEquals(listOf(39..42, 60..60), changedRanges(diff))
    }

    @Test
    fun `the request and title from a selection`() {
        val r = requestFromSelection("orders.py", 6, 9, "def cancel_order(order_id):\n    # TODO: refunds for paid orders\n    order = db.get(order_id)\n")
        assertTrue(r.startsWith("Refunds for paid orders\n\nCode: orders.py:6-9\n```\ndef cancel_order"))
        assertEquals("Refunds for paid orders", titleFrom(r))
        assertEquals("fix", suggestWorkflow("the total is wrong when a coupon is used", listOf("feature", "fix", "quick")))
        assertEquals("feature", suggestWorkflow("refunds for paid orders", listOf("feature", "fix")))
    }

    @Test
    fun `token caps as typed`() {
        assertEquals(300_000, parseTokens("300k"))
        assertEquals(1_500_000, parseTokens("1.5m"))
        assertEquals(0, parseTokens(""))
        assertEquals(-1, parseTokens("lots"))
    }

    @Test
    fun `device name and CI line`() {
        assertEquals("IntelliJ IDEA on laptop", deviceName("IntelliJ IDEA", "laptop.local"))
        assertEquals("CI 1/2 ✗", ciSummary(listOf(CheckRun("a", "success"), CheckRun("b", "failure"))))
        assertEquals("", ciSummary(emptyList()))
    }

    @Test
    fun `reads the key keel2 prints and never needs the PATH`() {
        val dir = Files.createTempDirectory("keel2-fake").toFile()
        val ok = File(dir, "keel2").apply {
            writeText("#!/bin/sh\n[ \"$1 $2\" = \"auth key\" ] || exit 3\necho kw_demo_key_123\n")
            setExecutable(true)
        }
        assertEquals("kw_demo_key_123", LocalKey.read(ok))
        assertEquals(ok, LocalKey.find(listOf(File(dir, "missing"), ok)))
        val bad = File(dir, "keel2-down").apply {
            writeText("#!/bin/sh\necho 'keel is not running.' >&2\necho 'Start it: keel2 start /path/to/project' >&2\nexit 1\n")
            setExecutable(true)
        }
        val e = runCatching { LocalKey.read(bad) }.exceptionOrNull() as LocalKey.Failed
        assertEquals("keel is not running.", e.message)
        assertEquals("Start it: keel2 start /path/to/project", e.hint)
        val none = runCatching { LocalKey.read(null) }.exceptionOrNull() as LocalKey.Failed
        assertTrue(none.message!!.contains("not found"))
        dir.deleteRecursively()
    }
}
