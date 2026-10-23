package dev.keel.android.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class KeelApiTest {
    private lateinit var server: MockWebServer
    private var removed = 0

    @Before
    fun up() {
        server = MockWebServer()
        server.start()
        removed = 0
    }

    @After
    fun down() {
        runCatching { server.shutdown() }
    }

    private fun api(token: String? = "dev-token") = KeelApi(server.url("/").toString(), token = { token }, onRemoved = { removed++ })
    private fun json(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    @Test
    fun `pair sends the code and the device without a token`() = runBlocking {
        server.enqueue(json(200, """{"token":"tok-1","device":{"id":"d1","name":"Pixel 9","platform":"android","created_at":"2026-10-23T10:00:00Z"},"keel":{"name":"home keel","version":"0.18.45"}}"""))
        val res = api(token = "should-not-be-sent").pair(" 7KQ-4MZ ", "Pixel 9")
        assertEquals("tok-1", res.token)
        assertEquals("d1", res.device.id)
        assertEquals("home keel", res.keel.name)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/devices/pair", req.path)
        assertNull(req.getHeader("Authorization"))
        assertEquals("""{"code":"7KQ-4MZ","name":"Pixel 9","platform":"android"}""", req.body.readUtf8())
    }

    @Test
    fun `pair refused shows keel's error and hint`() = runBlocking {
        server.enqueue(json(403, """{"error":"This pairing code is not valid","hint":"Make a new one: keel2 pair."}"""))
        try {
            api(null).pair("bad", "Pixel")
            fail("expected a refusal")
        } catch (e: KeelException) {
            assertEquals(403, e.status)
            assertEquals("This pairing code is not valid", e.message)
            assertEquals("Make a new one: keel2 pair.", e.hint)
        }
        assertEquals("a refused pairing is not a removed device", 0, removed)
    }

    @Test
    fun `too many tries is a 429 with keel's words`() = runBlocking {
        server.enqueue(json(429, """{"error":"Too many pairing tries","hint":"Wait a minute."}"""))
        val e = runCatching { api(null).pair("x", "y") }.exceptionOrNull() as KeelException
        assertEquals(429, e.status)
        assertEquals("Wait a minute.", e.hint)
    }

    @Test
    fun `every call sends the device token`() = runBlocking {
        server.enqueue(json(200, """{"device":{"id":"d1","name":"Pixel 9","platform":"android"}}"""))
        val me = api().me()
        assertEquals("d1", me.device?.id)
        val req = server.takeRequest()
        assertEquals("/api/devices/me", req.path)
        assertEquals("Bearer dev-token", req.getHeader("Authorization"))
    }

    @Test
    fun `a removed device sends the app back to pairing`() = runBlocking {
        server.enqueue(json(403, """{"error":"This device was removed","hint":"Pair it again in keel's Settings › Phone."}"""))
        val e = runCatching { api().me() }.exceptionOrNull() as KeelException
        assertTrue(e.deviceRemoved)
        assertEquals(1, removed)
    }

    @Test
    fun `reads the inbox`() = runBlocking {
        server.enqueue(
            json(
                200,
                """{"items":[{"project_id":"p1","project_name":"shop","thread_id":"t1","flow":"Cart totals","workflow_id":"feature","step":"spec-gate",
                "kind":"gate","title":"Approve the spec?","detail":"4 criteria","more":false,"options":["approve","reject"],"choices":["approve","change"],
                "choice_info":[{"name":"approve","label":"Approve","description":"go on","why":"none","default":true}],"id":"q-7","phase":"spec",
                "since":"2026-10-23T10:00:00Z","something_new":{"x":1}}],"count":1,"kinds":["gate"],"projects":[]}""",
            ),
        )
        val inbox = api().inbox()
        assertEquals(1, inbox.count)
        val it = inbox.items.single()
        assertEquals("t1", it.threadId)
        assertEquals("q-7", it.id)
        assertEquals("Approve", it.choiceInfo?.single()?.label)
        assertEquals("/api/inbox", server.takeRequest().path)
    }

    @Test
    fun `an answer is bound to its question`() = runBlocking {
        server.enqueue(json(200, """{"thread_id":"t1","status":"running","phase":"red"}"""))
        val t = api().answer("t1", InboxAnswer("approve", id = "q-7", payload = JsonObject(mapOf("choice" to JsonPrimitive("approve")))))
        assertEquals("running", t.status)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/inbox/t1/act", req.path)
        assertEquals("""{"decision":"approve","id":"q-7","payload":{"choice":"approve"}}""", req.body.readUtf8())
    }

    @Test
    fun `a stale answer is a 409`() = runBlocking {
        server.enqueue(json(409, """{"error":"This flow now asks something else"}"""))
        val e = runCatching { api().answer("t1", InboxAnswer("approve", id = "old")) }.exceptionOrNull() as KeelException
        assertEquals(409, e.status)
        assertFalse(e.deviceRemoved)
    }

    @Test
    fun `keel off the network says what to check`() = runBlocking {
        val url = server.url("/").toString()
        server.shutdown()
        val e = runCatching { KeelApi(url, token = { "t" }).inbox() }.exceptionOrNull() as KeelException
        assertTrue(e.unreachable)
        assertTrue(e.hint!!.contains("same Wi-Fi") && e.hint!!.contains("keel2 start --wifi"))
    }

    @Test
    fun `normalizes typed addresses`() {
        assertEquals("http://192.168.1.5:8080/", KeelApi.normalizeBase("192.168.1.5:8080")?.toString())
        assertEquals("https://box.ts.net/", KeelApi.normalizeBase("https://box.ts.net/api/")?.toString())
        assertNull(KeelApi.normalizeBase("ftp://x"))
        assertNull(KeelApi.normalizeBase(" "))
    }
}
