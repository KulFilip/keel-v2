package dev.keel.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairLinksTest {
    @Test
    fun `reads a LAN link with an encoded address and name`() {
        val link = PairLinks.parse("keel://pair?u=http%3A%2F%2F192.168.1.20%3A8088&c=7KQ-4MZ&n=my%20keel")
        assertEquals(PairLink("http://192.168.1.20:8088", "7KQ-4MZ", "my keel"), link)
    }

    @Test
    fun `keeps https and drops a path`() {
        val link = PairLinks.parse("keel://pair?u=https%3A%2F%2Fbox.tail1234.ts.net%2Fapi%2F&c=abc")
        assertEquals("https://box.tail1234.ts.net", link?.url)
        assertEquals("abc", link?.code)
        assertNull(link?.name)
    }

    @Test
    fun `accepts a tunnel address and parameters in any order`() {
        val link = PairLinks.parse("keel://pair?c=X1&n=keel&u=https://quiet-river.trycloudflare.com")
        assertEquals("https://quiet-river.trycloudflare.com", link?.url)
        assertEquals("X1", link?.code)
    }

    @Test
    fun `trims spaces around the scanned text`() {
        assertEquals("C", PairLinks.parse("  keel://pair?u=http%3A%2F%2F10.0.0.2%3A8080&c=C \n")?.code)
    }

    @Test
    fun `refuses what is not a keel pairing link`() {
        assertNull(PairLinks.parse(null))
        assertNull(PairLinks.parse(""))
        assertNull(PairLinks.parse("https://example.com/?u=http://x&c=1"))
        assertNull(PairLinks.parse("keel://open?u=http%3A%2F%2Fx%3A1&c=1"))
        assertNull(PairLinks.parse("keel://pair?c=1"))
        assertNull(PairLinks.parse("keel://pair?u=http%3A%2F%2Fx%3A1"))
        assertNull(PairLinks.parse("keel://pair?u=ftp%3A%2F%2Fx&c=1"))
        assertNull(PairLinks.parse("keel://pair?u=192.168.1.2%3A8080&c=1"))
        assertNull(PairLinks.parse("not a url at all"))
    }
}
