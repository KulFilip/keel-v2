package keel.product

import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.time.Instant

data class ProductInfo(val version: String, val projectId: String, val root: String)
data class StartBody(val stage: String? = null)
data class PageBody(val text: String = "")
data class SuggestionBody(val accept: Boolean = false)
data class KeyTestBody(val pattern: String? = null, val text: String = "")
data class KeyTest(val pattern: String?, val keys: List<String>)

/** keel Product's endpoints: initiatives (/api/initiatives…), teams (/api/teams…). Every one needs keel Product on. */
@RestController
@RequestMapping("/api")
class ProductController(
    private val guard: ProductGuard,
    private val repo: ProductRepo,
    private val initiatives: InitiativeService,
    private val delivery: DeliveryService,
    private val decks: DeckService,
    private val followUps: FollowUps,
    private val teams: TeamService,
    private val links: TicketLinks,
    private val drafts: PlanDrafts,
    private val sender: TicketSender,
    private val ticketApproval: TicketApproval,
    private val flowMap: FlowMap,
) {
    private fun <T> on(block: () -> T): T {
        guard.on()
        return block()
    }

    @GetMapping("/product")
    fun info(): ProductInfo = on { repo.ensure().let { ProductInfo(PRODUCT_VERSION, it.id, it.root) } }

    // ---- initiatives
    @GetMapping("/initiatives")
    fun board(): List<BoardItem> = on { initiatives.board() }

    @PostMapping("/initiatives")
    fun create(@RequestBody b: NewInitiative): InitiativeDetail = on { initiatives.create(b) }

    /** The repos keel can read for an initiative, with the teams that own them. */
    @GetMapping("/initiatives/repos")
    fun repos(): List<RepoOwner> = on { teams.repoOwners() }

    @GetMapping("/initiatives/{id}")
    fun get(@PathVariable id: String): InitiativeDetail = on { initiatives.detail(id) }

    @PatchMapping("/initiatives/{id}")
    fun patch(@PathVariable id: String, @RequestBody b: InitiativePatch): InitiativeDetail = on { initiatives.patch(id, b) }

    @PostMapping("/initiatives/{id}/start")
    fun start(@PathVariable id: String, @RequestBody(required = false) b: StartBody?): InitiativeDetail = on { initiatives.start(id, b?.stage) }

    @PostMapping("/initiatives/{id}/approve")
    fun approve(@PathVariable id: String, @RequestBody(required = false) b: GateBody?): InitiativeDetail = on { initiatives.approve(id, b ?: GateBody()) }

    @PostMapping("/initiatives/{id}/send-back")
    fun sendBack(@PathVariable id: String, @RequestBody b: NoteBody): InitiativeDetail = on { initiatives.sendBack(id, b) }

    @PostMapping("/initiatives/{id}/decide")
    fun decide(@PathVariable id: String, @RequestBody b: DecideBody): InitiativeDetail = on { initiatives.decide(id, b) }

    @PostMapping("/initiatives/{id}/rerun")
    fun rerun(@PathVariable id: String, @RequestBody(required = false) b: RerunBody?): InitiativeDetail = on { initiatives.rerun(id, b ?: RerunBody()) }

    @PostMapping("/initiatives/{id}/stop")
    fun stop(@PathVariable id: String): InitiativeDetail = on { initiatives.stop(id) }

    @PostMapping("/initiatives/{id}/questions")
    fun ask(@PathVariable id: String, @RequestBody b: ClarifyBody): ProductQuestion = on { initiatives.clarify(id, b) }

    @PostMapping("/initiatives/{id}/questions/{qid}/answer")
    fun answer(@PathVariable id: String, @PathVariable qid: String, @RequestBody b: AnswerBody): ProductQuestion = on { initiatives.answer(id, qid, b) }

    @PostMapping("/initiatives/{id}/disagreements")
    fun disagree(@PathVariable id: String, @RequestBody b: DisagreeBody): Disagreement = on { initiatives.disagree(id, b) }

    @PostMapping("/initiatives/{id}/disagreements/{did}/settle")
    fun settle(@PathVariable id: String, @PathVariable did: String, @RequestBody b: SettleBody): Disagreement = on { initiatives.settle(id, did, b) }

    @PostMapping("/initiatives/{id}/disagreements/{did}/rerun")
    fun rerunWithObjection(@PathVariable id: String, @PathVariable did: String): InitiativeDetail = on { initiatives.rerunWithObjection(id, did) }

    @PostMapping("/initiatives/{id}/follow-ups")
    fun addFollowUp(@PathVariable id: String, @RequestBody b: FollowUpBody): FollowUp = on { initiatives.addFollowUp(id, b) }

    @PostMapping("/initiatives/{id}/follow-ups/{fid}/done")
    fun doneFollowUp(@PathVariable id: String, @PathVariable fid: String): FollowUp = on { initiatives.doneFollowUp(id, fid) }

    @PostMapping("/initiatives/{id}/park")
    fun park(@PathVariable id: String, @RequestBody(required = false) b: ParkBody?): InitiativeDetail = on { initiatives.park(id, b ?: ParkBody()) }

    @PostMapping("/initiatives/{id}/unpark")
    fun unpark(@PathVariable id: String): InitiativeDetail = on { initiatives.unpark(id) }

    @PostMapping("/initiatives/{id}/released")
    fun released(@PathVariable id: String): InitiativeDetail = on { initiatives.released(id) }

    @PostMapping("/initiatives/{id}/outcome")
    fun outcome(@PathVariable id: String, @RequestBody b: MetricBody): InitiativeDetail = on { initiatives.outcome(id, b) }

    @PostMapping("/initiatives/{id}/handoff")
    fun handoff(@PathVariable id: String, @RequestBody b: HandoffBody): HandoffResult = on { delivery.handoff(initiatives.require(id), b) }

    // ---- the plan as drafts, and its tickets in Jira

    @PatchMapping("/initiatives/{id}/plan/stories/{sid}")
    fun editStory(@PathVariable id: String, @PathVariable sid: String, @RequestBody b: StoryEdit): InitiativeDetail = on {
        drafts.editStory(initiatives.require(id), sid, b)
        initiatives.detail(id)
    }

    @PostMapping("/initiatives/{id}/plan/stories")
    fun addStory(@PathVariable id: String, @RequestBody b: StoryEdit): InitiativeDetail = on {
        drafts.addStory(initiatives.require(id), b)
        initiatives.detail(id)
    }

    @DeleteMapping("/initiatives/{id}/plan/stories/{sid}")
    fun deleteStory(@PathVariable id: String, @PathVariable sid: String): InitiativeDetail = on {
        drafts.deleteStory(initiatives.require(id), sid)
        initiatives.detail(id)
    }

    @PatchMapping("/initiatives/{id}/plan/epics/{eid}")
    fun editEpic(@PathVariable id: String, @PathVariable eid: String, @RequestBody b: EpicEdit): InitiativeDetail = on {
        drafts.editEpic(initiatives.require(id), eid, b)
        initiatives.detail(id)
    }

    @PostMapping("/initiatives/{id}/plan/epics")
    fun addEpic(@PathVariable id: String, @RequestBody b: EpicEdit): InitiativeDetail = on {
        drafts.addEpic(initiatives.require(id), b)
        initiatives.detail(id)
    }

    @DeleteMapping("/initiatives/{id}/plan/epics/{eid}")
    fun deleteEpic(@PathVariable id: String, @PathVariable eid: String): InitiativeDetail = on {
        drafts.deleteEpic(initiatives.require(id), eid)
        initiatives.detail(id)
    }

    /** What a send would make in Jira, where, and every problem first. Nothing is sent. */
    @GetMapping("/initiatives/{id}/tickets/preview")
    fun ticketPreview(@PathVariable id: String, @RequestParam(required = false) stories: List<String>?): TicketPreview =
        on { sender.preview(initiatives.require(id), stories.orEmpty()) }

    /** Sends the stories (all that are left, or these) to Jira: the initiative, the epics, the stories and their sub-tasks. */
    @PostMapping("/initiatives/{id}/tickets/send")
    fun ticketSend(@PathVariable id: String, @RequestBody(required = false) b: AskSendBody?): SendResult =
        on { sender.send(initiatives.require(id), b?.stories.orEmpty()) }

    /** An agent asks to send: an approval in the Inbox, sent when the product manager approves. */
    @PostMapping("/initiatives/{id}/tickets/ask")
    fun ticketAsk(@PathVariable id: String, @RequestBody(required = false) b: AskSendBody?): keel.api.approvals.Approval =
        on { ticketApproval.ask(initiatives.require(id), b ?: AskSendBody()) }

    /** Where an initiative's own Jira ticket goes (unset: no initiative ticket; its id is a label on every ticket). */
    @GetMapping("/product/jira")
    fun initiativeJira(): InitiativeJira = on { sender.initiativeJira() }

    /** B5: the Jira connections a team or the initiatives can use, which are connected, and the default when keel-wide has none. */
    @GetMapping("/product/jira/connections")
    fun jiraConnections(): JiraConnections = on { sender.connections() }

    @PutMapping("/product/jira")
    fun saveInitiativeJira(@RequestBody b: InitiativeJira): InitiativeJira = on { sender.saveInitiativeJira(b) }

    @GetMapping("/initiatives/{id}/docs/{kind}/{version}")
    fun doc(@PathVariable id: String, @PathVariable kind: String, @PathVariable version: Int): ProductDoc = on { initiatives.doc(id, kind, version) }

    /** The presentation as a page of its own (opens in a new tab; it has no scripts). */
    @GetMapping("/initiatives/{id}/deck")
    fun deck(@PathVariable id: String, @RequestParam(required = false) version: Int?): ResponseEntity<String> = on {
        ResponseEntity.ok().contentType(MediaType.TEXT_HTML)
            .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:")
            .body(decks.html(id, version))
    }

    @PostMapping("/initiatives/{id}/deck")
    fun rebuildDeck(@PathVariable id: String): ProductDoc = on { decks.rebuild(initiatives.require(id)) }

    /** The follow-ups that are due now become notifications (the scheduler does this by itself every few minutes). */
    @PostMapping("/product/follow-ups/check")
    fun checkFollowUps(@RequestParam(required = false) at: String?): FollowUpCheck = on {
        followUps.check(at?.let { Instant.parse(it) } ?: Instant.now())
    }

    // ---- teams
    @GetMapping("/teams")
    fun teamList(): List<Team> = on { teams.list() }

    @PostMapping("/teams")
    fun teamCreate(@RequestBody b: TeamBody): Team = on { teams.create(b) }

    @PostMapping("/teams/import-codeowners")
    fun importCodeowners(): ImportResult = on { teams.importCodeowners() }

    @GetMapping("/teams/{id}")
    fun team(@PathVariable id: String): TeamKnowledge = on { teams.knowledge(id) }

    @PatchMapping("/teams/{id}")
    fun teamUpdate(@PathVariable id: String, @RequestBody b: TeamBody): Team = on { teams.update(id, b) }

    @DeleteMapping("/teams/{id}")
    fun teamDelete(@PathVariable id: String): Map<String, Boolean> = on {
        teams.delete(id)
        mapOf("ok" to true)
    }

    @PutMapping("/teams/{id}/pages/{page}")
    fun savePage(@PathVariable id: String, @PathVariable page: String, @RequestBody b: PageBody): TeamPage = on { teams.savePage(id, page, b.text) }

    /** The Product map: teams, their repos' business flows, the tickets and work found in git. */
    @GetMapping("/product/map")
    fun productMap(@RequestParam(required = false) team: String?): ProductMap = on { flowMap.map(team) }

    /** Finds the business flows again (every team project, or these), read only: one flow analyst per repo. */
    @PostMapping("/product/flows/run")
    fun findFlows(@RequestBody(required = false) b: FlowsBody?): FlowRun = on { flowMap.start(b ?: FlowsBody()) }

    @PatchMapping("/product/flows/{pid}/{fid}")
    fun editFlow(@PathVariable pid: String, @PathVariable fid: String, @RequestBody b: FlowEdit): FlowView = on { flowMap.edit(pid, fid, b) }

    /** Reads the branches and commits of every team project (or of one project) and links them to ticket keys. */
    @PostMapping("/product/tickets/scan")
    fun scanTickets(@RequestParam(required = false) project: String?): ScanResult = on {
        if (project != null) ScanResult(listOf(links.scan(project))) else links.scanAll()
    }

    /** The ticket keys found in git (of one team, or of all), with their branches and commits, and what has no key. */
    @GetMapping("/product/tickets")
    fun tickets(@RequestParam(required = false) team: String?): TeamTickets = on { links.tickets(team) }

    @PutMapping("/teams/{id}/projects/{pid}")
    fun teamAddProject(@PathVariable id: String, @PathVariable pid: String): Team = on { teams.addProject(id, pid) }

    @DeleteMapping("/teams/{id}/projects/{pid}")
    fun teamRemoveProject(@PathVariable id: String, @PathVariable pid: String): Team = on { teams.removeProject(id, pid) }

    /** Tries a ticket-key pattern on a text (a branch name, a commit message) before the team saves it. */
    @PostMapping("/teams/key-pattern/test")
    fun testKeyPattern(@RequestBody b: KeyTestBody): KeyTest = on {
        val p = TicketKeys.check(b.pattern)
        KeyTest(p, p?.let { TicketKeys.find(TicketKeys.regex(it), b.text) }.orEmpty())
    }

    @PostMapping("/teams/{id}/suggestions/{sid}")
    fun decideSuggestion(@PathVariable id: String, @PathVariable sid: String, @RequestBody b: SuggestionBody): TeamKnowledge =
        on { teams.decide(id, sid, b.accept) }
}
