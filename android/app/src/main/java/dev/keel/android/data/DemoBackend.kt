package dev.keel.android.data

import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import java.time.Instant

/**
 * Demo mode (debug builds, like keel's KEEL_FAKE): an OkHttp interceptor that answers the app's api calls with the
 * mockup's data, so every screen runs through the real client code without a keel. Answers change the data
 * (an answered question leaves the inbox, a reply is added to its thread, KeelBot answers a message).
 */
class DemoBackend {
    private fun ago(sec: Long) = Instant.now().minusSeconds(sec).toString()
    private val pid = "app-tracking-management-system"

    private val projects = listOf(
        Project(pid, pid, "/workspace/$pid", "feature/ERPDM-1702-totals", "feature", "green", waiting = 3, running = 2),
        Project("carrier-router", "carrier-router", "/workspace/carrier-router", "main"),
    )

    private val specAcs = listOf(
        Ac("AC-1", "api", "The ETA webhook keeps the stored ETA when the payload has no ETA.", "todo"),
        Ac("AC-2", "db", "eta_updated_at changes only when the ETA changes.", "todo"),
        Ac("AC-3", "api", "A cleared ETA is logged with the carrier and the shipment.", "todo"),
        Ac("AC-4", "ui", "The tracking page shows \"last known ETA\" with its date.", "todo"),
    )

    private val threads = mutableMapOf(
        "t-1769" to ThreadState(
            threadId = "t-1769", projectId = pid, workflowId = "feature", title = "Keep the stored ETA when it is absent",
            status = "waiting", current = "spec-gate", phase = "spec", acs = specAcs,
            waiting = Waiting(
                step = "spec-gate", kind = "gate", title = "Approve the spec?", id = "q-spec-1769",
                detail = "Keep the stored ETA when Parcel Perform sends none.\n4 acceptance criteria, 2 API changes. The test step starts after you approve.",
                options = listOf("approve", "reject"),
                labels = Labels("Approve", "Change it"),
                choices = listOf("approve", "change", "stop"),
                choiceInfo = listOf(
                    ChoiceInfo("approve", "Approve", "The test step starts: an agent writes a failing test for each criterion.", "none", true),
                    ChoiceInfo("change", "Change it", "Tell keel what to change. It rewrites the spec and asks you again.", "required"),
                    ChoiceInfo("stop", "Stop the flow", "The flow ends here. The spec stays in .keel/specs."),
                ),
            ),
            usage = Usage(tokensIn = 14_000, tokensOut = 4_200, costUsd = 0.42), updatedAt = ago(720),
        ),
        "t-1771" to ThreadState(
            threadId = "t-1771", projectId = pid, workflowId = "interview", title = "Carrier ETA sync for DHL and PostNL",
            status = "waiting", current = "interview", phase = "triage",
            waiting = Waiting(
                step = "interview", kind = "clarify", title = "Which carriers should sync the ETA first?", id = "q-carriers",
                questions = listOf(
                    ClarifyQuestion(
                        "carriers", "Which carriers should sync the ETA first?", "The adapter is built per carrier.",
                        listOf(QuestionOption("DHL", recommended = true), QuestionOption("PostNL", recommended = true), QuestionOption("UPS"), QuestionOption("GLS")),
                        multiple = true,
                    ),
                ),
            ),
            usage = Usage(costUsd = 1.08), updatedAt = ago(2400),
        ),
        "t-1702" to ThreadState(
            threadId = "t-1702", projectId = pid, workflowId = "feature", title = "Tracking page totals",
            status = "waiting", current = "green", phase = "green", ac = "AC-3",
            acs = listOf(
                Ac("AC-1", "api", "totals count delivered parcels only", "done"),
                Ac("AC-2", "api", "the totals follow the date filter", "done"),
                Ac("AC-3", "api", "returned parcels are not counted twice", "red"),
            ),
            waiting = Waiting(
                step = "green__fix", kind = "fix", title = "AC-3 is still red after 3 tries. What now?", id = "q-stuck-1702",
                detail = "TotalsTest::returned_counted_once\nexpected 1284, got 1290\ntests/Unit/TotalsTest.php:48",
                choices = listOf("again", "investigate", "skip", "stop"),
                choiceInfo = listOf(
                    ChoiceInfo("again", "Try again with a note", "One more try, with your hint in the prompt.", "optional", true),
                    ChoiceInfo("investigate", "Find the cause first", "The investigator reads the failure and the code, then code tries again."),
                    ChoiceInfo("skip", "Skip AC-3", "The flow goes on without it. A reason is needed; it shows in the PR.", "required"),
                    ChoiceInfo("stop", "Stop the flow", "The commits so far stay on the branch."),
                ),
            ),
            usage = Usage(tokensIn = 33_000, tokensOut = 8_000, costUsd = 0.96), updatedAt = ago(600),
            gateLog = listOf("spec approved by you"),
        ),
    )

    private val runs = mutableListOf(
        RunRow("t-1769", "Keep the stored ETA when it is absent", "feature", "waiting", "spec", "spec-gate", "Approve the spec?", 0, 4, 18_000, "worktree", "feature/ERPDM-1769", costUsd = 0.42, updatedAt = ago(720)),
        RunRow("t-1771", "Carrier ETA sync for DHL and PostNL", "interview", "running", "green", "green", null, 2, 5, 52_000, "worktree", "feature/ERPDM-1771", costUsd = 1.08, updatedAt = ago(300)),
        RunRow("t-1702", "Tracking page totals", "feature", "waiting", "green", "green", "AC-3 is still red after 3 tries", 2, 3, 41_000, "folder", "feature/ERPDM-1702-totals", costUsd = 0.96, updatedAt = ago(600)),
        RunRow("t-fix-9", "Fix: duplicate webhook events", "fix", "running", "gate", "review", null, 1, 1, 12_000, "worktree", "fix/dup-webhooks", costUsd = 0.31, updatedAt = ago(120)),
        RunRow("t-1650", "Shipment search by reference", "feature", "done", "done", null, null, 6, 6, 88_000, "worktree", "feature/ERPDM-1650", costUsd = 2.10, updatedAt = ago(172_800)),
    )

    private val history = mapOf(
        "t-1702" to listOf(
            Checkpoint("c1", 1, "spec gate", ago(3000), "You approved the spec (3 criteria)."),
            Checkpoint("c2", 2, "red", ago(2500), "Tests written: 3 red, as expected."),
            Checkpoint("c3", 3, "AC gate", ago(1900), "AC-1 green. Reviewed: ok."),
            Checkpoint("c4", 4, "AC gate", ago(1100), "AC-2 green. Reviewed: ok."),
            Checkpoint("c5", 5, "green", ago(600), "AC-3 red after 3 tries. The flow waits for you."),
        ),
    )

    private val inboxPermission = InboxItem(
        projectId = pid, projectName = pid, threadId = "", flow = "KeelBot", kind = "permission", title = "KeelBot asks to run a command",
        detail = "vendor/bin/phpunit --filter EtaAbsent", id = "perm-1", since = ago(300),
        permission = InboxPermission("perm-1", "chat-1", "vendor/bin/phpunit --filter EtaAbsent"),
    )
    private var permissionOpen = true

    private val prs = listOf(
        PrSummary(412, "Keep the stored ETA when Parcel Perform sends none", "milad", "feature/ERPDM-1769", "main", updatedAt = ago(7200), mine = true, reviewRequested = false),
        PrSummary(409, "Carrier adapter: retry on 429 with backoff", "sara.k", "feature/ERPDM-1758", "main", updatedAt = ago(18_000), reviewRequested = true),
        PrSummary(405, "Tracking page: show the last known ETA", "j.berg", "feature/ERPDM-1744", "main", updatedAt = ago(86_400), reviewRequested = true),
        PrSummary(398, "Shipment search by reference", "milad", "feature/ERPDM-1650", "main", updatedAt = ago(172_800), mine = true),
    )

    private val reviewThreads = mutableListOf(
        ReviewThread(
            "th-1", "tests/Integration/Eta/EtaAbsentKeepsStoredTest.php", 52, startLine = 50,
            comments = listOf(
                ReviewComment("c1", "sara.k", "Maybe a factory would fit here?", ago(10_800)),
                ReviewComment("c2", "milad", "Fair point, thanks. Will update it.", ago(3600)),
            ),
        ),
        ReviewThread(
            "th-2", "src/Eta/EtaWebhook.php", 58,
            comments = listOf(ReviewComment("c3", "sara.k", "Should this log the carrier too (AC-3)?", ago(7000))),
        ),
        ReviewThread(
            "th-3", "migrations/Version2026.php", 12, resolved = true,
            comments = listOf(ReviewComment("c4", "j.berg", "rename eta_at to eta_updated_at", ago(20_000)), ReviewComment("c5", "milad", "Renamed in 3c1f9a2. Thanks!", ago(18_000))),
        ),
    )
    private val judges = mutableMapOf<String, AiRun>()
    private val judgeAsked = mutableMapOf<String, Int>()

    private val chatMessages = mutableListOf(
        HelperMessage(1, "user", "Why does EtaAbsentKeepsStoredTest fail? It passed yesterday.\n@tests/Integration/…/EtaAbsentKeepsStoredTest.php", at = ago(400)),
        HelperMessage(
            2, "helper",
            "**The webhook clears the ETA.** Since yesterday's change, `EtaWebhook::handle()` saves `null` when the payload has no ETA, so the stored one is lost.\n\n" +
                "- `src/Eta/EtaWebhook.php:58` writes the field without a check\n- the test is right: it matches AC-1 of the spec\n\n" +
                "```keel-questions\n{\"questions\":[{\"id\":\"fix\",\"question\":\"How should I fix it?\",\"options\":[" +
                "{\"label\":\"Fix the webhook\",\"description\":\"Keep the stored ETA when none comes. 1 file, the test stays.\",\"recommended\":true}," +
                "{\"label\":\"Fix it and log it\",\"description\":\"Also log a cleared ETA with the carrier (AC-3).\"}," +
                "{\"label\":\"Start a fix flow\",\"description\":\"Test first, then the change, then a review.\"}]}]}\n```",
            callId = "call-2", data = HelperMessageData(status = "done", provider = "copilot", model = "sonnet 5.5", effort = "high", tokensIn = 12_000, tokensOut = 2_200, costUsd = 0.09),
            at = ago(380),
        ),
    )
    private var chatMode = "ask"

    private fun session(withMessages: Boolean) = HelperSession(
        id = "chat-1", project = pid, mode = chatMode, title = "Why does the ETA test fail?",
        model = Model("copilot", "subscription", "sonnet 5.5", "high"), status = "idle",
        tokensIn = 12_000, tokensOut = 2_200, costUsd = 0.09, turns = chatMessages.count { it.role == "user" },
        updatedAt = ago(380), messages = if (withMessages) chatMessages.toList() else null,
    )

    private fun inbox(): InboxView {
        val items = threads.values.filter { it.status == "waiting" && it.waiting != null }.map { t ->
            val w = t.waiting!!
            InboxItem(
                projectId = t.projectId, projectName = t.projectId, threadId = t.threadId, flow = t.title, workflowId = t.workflowId,
                step = w.step, kind = w.kind, title = w.title, detail = w.detail, options = w.options, choices = w.choices,
                choiceInfo = w.choiceInfo, questions = w.questions, labels = w.labels, id = w.id, phase = t.phase, ac = t.ac,
                since = t.updatedAt,
            )
        } + listOfNotNull(inboxPermission.takeIf { permissionOpen })
        return InboxView(items, items.size)
    }

    private fun review(number: Int): ReviewView {
        val p = prs.first { it.number == number }
        return ReviewView(
            key = "pr:$number", number = number, title = p.title, author = p.author, base = "main", branch = p.branch,
            url = "https://github.com/acme/tracking/pull/$number", state = "open",
            checks = (1..14).map { CheckRun("check $it", "success") }, approved = listOf("j.berg"),
            files = listOf(
                ChangedFile("src/Eta/EtaWebhook.php", "modified", 12, 3),
                ChangedFile("tests/Integration/Eta/EtaAbsentKeepsStoredTest.php", "added", 78, 0),
                ChangedFile("migrations/Version2026.php", "added", 20, 0),
            ),
            added = 110, removed = 3, threads = if (number == 412) reviewThreads.toList() else emptyList(),
            canPost = true, host = HostRef("github", "github.com", "acme/tracking", "https://github.com/acme/tracking"), me = "milad",
        )
    }

    private val demoDiff = """
        diff --git a/tests/Integration/Eta/EtaAbsentKeepsStoredTest.php b/tests/Integration/Eta/EtaAbsentKeepsStoredTest.php
        @@ -48,0 +48,5 @@
        +    protected function setUp(): void {
        +        parent::setUp();
        +        ${'$'}conn = ${'$'}this->connection();
        +        ${'$'}conn->insert('carrier', ['id' => 7]);
        +        ${'$'}conn->insert('resolver', [...]);
    """.trimIndent()

    fun handle(method: String, path: String, query: Map<String, String>, body: String): Pair<Int, String> {
        val seg = path.trim('/').split('/')
        fun <T> ok(ser: KSerializer<T>, v: T) = 200 to KeelJson.encodeToString(ser, v)
        fun bodyObj() = runCatching { KeelJson.parseToJsonElement(body) as JsonObject }.getOrDefault(JsonObject(emptyMap()))
        fun JsonObject.s(k: String) = (this[k] as? JsonPrimitive)?.contentOrNull
        return when {
            path == "/api/health" -> ok(Health.serializer(), Health(true, true, "demo", true))
            path == "/api/devices/me" -> ok(DeviceMe.serializer(), DeviceMe(Device("demo", "This phone", "android")))
            path == "/api/projects" -> ok(ListSerializer(Project.serializer()), projects)
            path == "/api/inbox" -> ok(InboxView.serializer(), inbox())
            path == "/api/inbox/count" -> ok(InboxCount.serializer(), InboxCount(inbox().count))
            seg.size == 4 && seg[1] == "inbox" && seg[3] == "act" -> {
                val t = threads[seg[2]] ?: return 404 to """{"error":"No such flow"}"""
                val b = bodyObj()
                if (b.s("id") != null && b.s("id") != t.waiting?.id) return 409 to """{"error":"This flow now asks something else","hint":"Reload: the question changed."}"""
                val done = t.copy(status = "running", waiting = null, phase = if (t.phase == "spec") "red" else t.phase)
                threads[t.threadId] = done
                runs.replaceAll { if (it.threadId == t.threadId) it.copy(status = "running", waiting = null, phase = done.phase) else it }
                ok(ThreadState.serializer(), done)
            }
            seg.size == 4 && seg[1] == "approvals" -> { permissionOpen = false; 200 to "{}" }
            seg.size == 4 && seg[1] == "projects" && seg[3] == "runs" -> ok(ListSerializer(RunRow.serializer()), if (seg[2] == pid) runs else emptyList())
            seg.size == 5 && seg[1] == "projects" && seg[3] == "flows" -> {
                val t = threads[seg[4]] ?: runs.firstOrNull { it.threadId == seg[4] }?.let { r ->
                    ThreadState(r.threadId, pid, r.workflowId ?: "feature", r.title, r.status, r.current, r.phase ?: "", acs = (1..r.acsTotal).map { Ac("AC-$it", "api", "criterion $it", if (it <= r.acsDone) "done" else "todo") }, usage = Usage(costUsd = r.costUsd), updatedAt = r.updatedAt)
                }
                ok(FlowView.serializer(), FlowView(t, Workflow(t?.workflowId ?: "feature", "${t?.workflowId ?: "feature"} (keel)")))
            }
            seg.size == 4 && seg[1] == "projects" && seg[3] == "flows" && method == "POST" -> {
                val b = bodyObj()
                val r = RunRow("t-new-${runs.size}", b.s("title") ?: "New flow", b.s("workflow_id"), "running", "spec", "spec", costUsd = 0.0, updatedAt = Instant.now().toString(), where = "worktree")
                runs.add(0, r)
                ok(ThreadState.serializer(), ThreadState(r.threadId, pid, r.workflowId ?: "feature", r.title, "running", phase = "spec"))
            }
            seg.size == 4 && seg[1] == "projects" && seg[3] == "workflows" -> ok(ListSerializer(Workflow.serializer()), listOf(Workflow("feature", "feature (keel)"), Workflow("fix", "fix (keel)"), Workflow("interview", "interview (keel)")))
            seg.size == 5 && seg[1] == "projects" && seg[3] == "budget" -> ok(BudgetNow.serializer(), BudgetNow(Spend(410_000, 1.76), caps = listOf(CapLeft("d", "day", "usd", 20.0, 7.6))))
            seg.size == 4 && seg[1] == "threads" && seg[3] == "history" -> ok(ListSerializer(Checkpoint.serializer()), history[seg[2]] ?: emptyList())
            seg.size == 4 && seg[1] == "threads" && seg[3] == "stop" -> {
                val t = threads[seg[2]]?.copy(status = "stopped", waiting = null) ?: ThreadState(seg[2], status = "stopped")
                threads[seg[2]] = t
                runs.replaceAll { if (it.threadId == seg[2]) it.copy(status = "stopped", waiting = null) else it }
                ok(ThreadState.serializer(), t)
            }
            path.endsWith("/review/prs") -> {
                val f = query["filter"] ?: "review"
                val list = when (f) { "mine" -> prs.filter { it.mine }; "all" -> prs; else -> prs.filter { it.reviewRequested } }
                ok(PrList.serializer(), PrList(HostRef("github", "github.com", "acme/tracking"), "milad", list, mapOf("review" to 2, "mine" to 2, "all" to 4)))
            }
            path.endsWith("/review/view") -> ok(ReviewView.serializer(), review(query["key"].orEmpty().removePrefix("pr:").toIntOrNull() ?: 412))
            path.endsWith("/review/diff") -> ok(FileDiff.serializer(), FileDiff(query["path"].orEmpty(), if (query["path"].orEmpty().endsWith("Test.php")) demoDiff else ""))
            path.endsWith("/review/ai") -> {
                judges.replaceAll { tid, run ->
                    if (run.status == "running" && (judgeAsked.merge(tid, 1, Int::plus) ?: 0) >= 2) run.copy(status = "done", result = judgeResult(tid)) else run
                }
                ok(AiState.serializer(), AiState(judges.toMap()))
            }
            seg.size == 7 && seg[3] == "review" && seg[4] == "threads" && seg[6] == "judge" -> {
                judges[seg[5]] = AiRun("j-${seg[5]}", "judge", "running")
                judgeAsked[seg[5]] = 0
                ok(AiState.serializer(), AiState(judges.toMap()))
            }
            seg.size == 7 && seg[3] == "review" && seg[4] == "threads" && seg[6] == "reply" -> {
                val b = bodyObj()
                val i = reviewThreads.indexOfFirst { it.id == seg[5] }
                if (i >= 0) reviewThreads[i] = reviewThreads[i].copy(comments = reviewThreads[i].comments + ReviewComment("r${System.nanoTime()}", "milad", b.s("body").orEmpty(), Instant.now().toString()))
                ok(ReviewView.serializer(), review(412))
            }
            seg.size == 7 && seg[3] == "review" && seg[4] == "threads" && seg[6] == "resolve" -> {
                val i = reviewThreads.indexOfFirst { it.id == seg[5] }
                if (i >= 0) reviewThreads[i] = reviewThreads[i].copy(resolved = (bodyObj()["resolved"] as? JsonPrimitive)?.contentOrNull != "false")
                ok(ReviewView.serializer(), review(412))
            }
            seg.size == 7 && seg[3] == "review" && seg[4] == "threads" && seg[6] == "address" ->
                ok(AddressResult.serializer(), AddressResult("t-addr", "Address: factory in setUp()", "keel/address-412", "keel started a fix flow on its own branch."))
            path.endsWith("/helper/sessions") && method == "GET" -> ok(ListSerializer(HelperSession.serializer()), listOf(session(false)))
            path.endsWith("/helper/sessions") && method == "POST" -> {
                chatMessages.clear()
                chatMode = bodyObj().s("mode") ?: "ask"
                ok(HelperSession.serializer(), session(true).copy(title = "New chat"))
            }
            seg.size == 6 && seg[3] == "helper" && seg[4] == "sessions" && method == "PATCH" -> {
                chatMode = bodyObj().s("mode") ?: chatMode
                ok(HelperSession.serializer(), session(true))
            }
            seg.size == 6 && seg[3] == "helper" && seg[4] == "sessions" -> ok(HelperSession.serializer(), session(true))
            seg.size == 7 && seg[3] == "helper" && seg[6] == "turn" -> {
                val text = bodyObj().s("text").orEmpty()
                val n = (chatMessages.maxOfOrNull { it.n } ?: 0) + 1
                chatMessages += HelperMessage(n, "user", text, at = Instant.now().toString())
                chatMessages += HelperMessage(
                    n + 1, "helper",
                    if (text.startsWith(ANSWERS_PREFIX)) "Sent. I start the change in Edit mode: `src/Eta/EtaWebhook.php` keeps the stored ETA when none comes."
                    else "This is the demo keel: a real keel answers here, reading your project.",
                    callId = "call-${n + 1}", data = HelperMessageData(status = "done", provider = "copilot", model = "sonnet 5.5"), at = Instant.now().toString(),
                )
                ok(TurnStarted.serializer(), TurnStarted("chat-1", "call-${n + 1}", n))
            }
            seg.size == 7 && seg[3] == "helper" && seg[6] == "changes" -> ok(ListSerializer(HelperChange.serializer()), emptyList())
            seg.size == 4 && seg[1] == "jobs" && seg[3] == "steps" -> ok(
                JobSteps.serializer(),
                JobSteps(
                    listOf(
                        JobStep(1, kind = "tool", text = "vendor/bin/phpunit --filter EtaAbsent", ok = false),
                        JobStep(2, kind = "tool", text = "git log -1 --stat src/Eta"),
                        JobStep(3, kind = "read", path = "src/Eta/EtaWebhook.php"),
                        JobStep(4, kind = "read", path = "src/Eta/EtaRepository.php:40–72"),
                        JobStep(5, kind = "read", path = "tests/Integration/Eta/EtaAbsentKeepsStoredTest.php"),
                    ),
                ),
            )
            else -> 404 to """{"error":"The demo keel does not know $method $path","hint":"Pair with a real keel."}"""
        }
    }

    private fun judgeResult(tid: String) = JudgeResult(
        stage = "done",
        items = listOf(
            JudgeItem(
                "a factory would fit here", "unclear",
                "Lines 50–78 set up carriers, resolver and link with raw inserts; a factory would shorten them. The diff does not show whether the repo already has factories (e.g. Foundry).",
                "Use a factory in setUp() if one exists, else keep the inserts.",
            ),
        ),
        reply = if (tid == "th-1") "Good idea if the repo has factories; I checked and will switch setUp() to them, else keep the inserts." else "Yes: I will log the carrier with the cleared ETA.",
        agent = "judge", model = "copilot · sonnet 5.5", effort = "high", tokens = 2_000,
    )

    /** The interceptor: every call to the demo address is answered here. */
    fun interceptor() = Interceptor { chain ->
        val req = chain.request()
        val buf = Buffer()
        req.body?.writeTo(buf)
        val query = (0 until req.url.querySize).associate { req.url.queryParameterName(it) to (req.url.queryParameterValue(it) ?: "") }
        val (code, json) = synchronized(this) { handle(req.method, req.url.encodedPath, query, buf.readUtf8()) }
        Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(code).message(if (code < 300) "OK" else "Error")
            .header("Content-Type", "application/json")
            .body(json.toResponseBody(KeelApi.JSON)).build()
    }

    fun client(): OkHttpClient = OkHttpClient.Builder().addInterceptor(interceptor()).build()
}
