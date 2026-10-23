package dev.keel.android.ui

import dev.keel.android.data.KeelSession
import dev.keel.android.data.MemoryKeelStore
import dev.keel.android.data.SavedKeel
import dev.keel.android.ui.inbox.InboxViewModel
import dev.keel.android.ui.pair.PairViewModel
import dev.keel.android.ui.question.QuestionViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

@OptIn(ExperimentalCoroutinesApi::class)
class ViewModelTest {
    private lateinit var server: MockWebServer
    private val routes = mutableMapOf<String, MockResponse>()
    private val seen = CopyOnWriteArrayList<Pair<String, String>>()

    @Before
    fun up() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val key = "${request.method} ${request.path?.substringBefore('?')}"
                seen += key to request.body.readUtf8()
                return routes[key] ?: MockResponse().setResponseCode(404).setBody("""{"error":"not here: $key"}""")
            }
        }
        server.start()
    }

    @After
    fun down() {
        Dispatchers.resetMain()
        runCatching { server.shutdown() }
    }

    private fun json(body: String, code: Int = 200) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    private fun pairedSession(): KeelSession {
        val store = MemoryKeelStore()
        store.save(SavedKeel("k1", "home keel", server.url("/").toString().trimEnd('/'), project = "p1"), "dev-token")
        store.setActive("k1")
        return KeelSession(store, deviceName = "Test phone")
    }

    private fun <T> StateFlow<T>.await(p: (T) -> Boolean): T = runBlocking { withTimeout(5_000) { first(p) } }

    @Test
    fun `pairing stores the keel and its token`() {
        routes["POST /api/devices/pair"] = json("""{"token":"tok-9","device":{"id":"d9","name":"Test phone","platform":"android"},"keel":{"name":"office keel","version":"0.18.45"}}""")
        val session = KeelSession(MemoryKeelStore(), deviceName = "Test phone")
        val vm = PairViewModel(session)
        assertTrue(vm.fromLink("keel://pair?u=${java.net.URLEncoder.encode(server.url("/").toString(), "UTF-8")}&c=ABC&n=office"))
        vm.ui.await { it.paired }
        val keel = session.keel!!
        assertEquals("office keel", keel.name)
        assertEquals("d9", keel.deviceId)
        assertEquals("tok-9", session.store.token(keel.id))
        assertTrue(seen.any { it.first == "POST /api/devices/pair" && it.second.contains("\"name\":\"Test phone\"") })
    }

    @Test
    fun `a refused pairing shows keel's error and hint`() {
        routes["POST /api/devices/pair"] = json("""{"error":"This pairing code is used up","hint":"Make a new one in keel's Settings › Phone."}""", 403)
        val vm = PairViewModel(KeelSession(MemoryKeelStore(), deviceName = "x"))
        vm.setUrl(server.url("/").toString())
        vm.setCode("OLD")
        vm.pair()
        val ui = vm.ui.await { !it.busy && it.error != null }
        assertEquals("This pairing code is used up", ui.error)
        assertEquals("Make a new one in keel's Settings › Phone.", ui.hint)
        assertTrue(!ui.paired)
    }

    @Test
    fun `the typed form asks for what is missing`() {
        val vm = PairViewModel(KeelSession(MemoryKeelStore(), deviceName = "x"))
        vm.pair()
        assertEquals("Type keel's address.", vm.ui.value.error)
        vm.setUrl("192.168.1.9:8080")
        vm.pair()
        assertEquals("Type the pairing code.", vm.ui.value.error)
    }

    @Test
    fun `the inbox loads the questions and the reviews`() {
        routes["GET /api/inbox"] = json("""{"items":[{"project_id":"p1","project_name":"shop","thread_id":"t1","flow":"Cart","kind":"gate","title":"Approve the spec?","id":"q1","options":["approve","reject"]},
            {"project_id":"p1","kind":"permission","title":"KeelBot asks","id":"a1","permission":{"id":"a1","session":"s","command":"npm test"}}],"count":2}""")
        routes["GET /api/projects/p1/review/prs"] = json("""{"prs":[{"number":409,"title":"Retry on 429","author":"sara.k","review_requested":true}]}""")
        routes["GET /api/projects/p1/budget/now"] = json("""{"today":{"tokens":1000,"cost_usd":1.76}}""")
        val vm = InboxViewModel(pairedSession(), null)
        val ui = vm.ui.await { !it.loading }
        assertNull(ui.error)
        assertEquals(1, ui.questions.size)
        assertEquals(1, ui.permissions.size)
        assertEquals(409, ui.reviews.single().number)
        assertEquals(1.76, ui.today!!, 0.001)
        assertEquals(3, ui.count)
    }

    @Test
    fun `the inbox says when keel cannot be reached`() {
        val session = pairedSession()
        server.shutdown()
        val vm = InboxViewModel(session, null)
        val ui = vm.ui.await { !it.loading }
        val e = ui.error as dev.keel.android.data.KeelException
        assertTrue(e.unreachable)
        assertTrue(e.hint!!.contains("keel2 start --wifi"))
    }

    @Test
    fun `answering a question sends its id, and a stale one reloads`() {
        val flow = """{"thread":{"thread_id":"t1","project_id":"p1","workflow_id":"feature","title":"Cart","status":"waiting","phase":"spec",
            "waiting":{"step":"spec-gate","kind":"gate","title":"Approve the spec?","id":"q1","options":["approve","reject"],
            "choices":["approve","change"],"choice_info":[{"name":"approve","label":"Approve","description":"","why":"none","default":true},
            {"name":"change","label":"Change it","description":"","why":"required","default":false}]}},"workflow":{"id":"feature"}}"""
        routes["GET /api/projects/p1/flows/t1"] = json(flow)
        routes["POST /api/inbox/t1/act"] = json("""{"error":"This flow now asks something else"}""", 409)
        val vm = QuestionViewModel(pairedSession(), null, "p1", "t1")
        val loaded = vm.ui.await { it.form != null }
        assertEquals("approve", loaded.form!!.picked)

        // a choice that needs a reason is not sent without one
        vm.pick("change")
        vm.send()
        assertTrue(vm.ui.value.sendError!!.message!!.startsWith("Write why first"))

        vm.setWhy("log to the audit table")
        vm.send()
        val after = vm.ui.await { !it.sending && it.sendError != null }
        assertEquals(409, (after.sendError as dev.keel.android.data.KeelException).status)
        val sent = seen.first { it.first == "POST /api/inbox/t1/act" }.second
        assertEquals("""{"decision":"approve","id":"q1","why":"log to the audit table","payload":{"choice":"change"}}""", sent)
        assertNotNull(vm.ui.value.thread)
    }

    @Test
    fun `an answer that goes through clears the form`() {
        routes["GET /api/projects/p1/flows/t2"] = json("""{"thread":{"thread_id":"t2","status":"waiting","phase":"ac-gate","waiting":{"step":"ac-gate","kind":"gate","title":"AC-1 ok?","id":"q2","options":["approve","reject"]}}}""")
        routes["POST /api/inbox/t2/act"] = json("""{"thread_id":"t2","status":"running","phase":"red"}""")
        val vm = QuestionViewModel(pairedSession(), null, "p1", "t2")
        vm.ui.await { it.form != null }
        routes["GET /api/projects/p1/flows/t2"] = json("""{"thread":{"thread_id":"t2","status":"running","phase":"red"}}""")
        vm.send()
        val ui = vm.ui.await { it.sent != null && !it.sending }
        assertTrue(ui.sent!!.startsWith("Approve"))
        assertEquals("""{"decision":"approve","id":"q2"}""", seen.first { it.first == "POST /api/inbox/t2/act" }.second)
    }
}
