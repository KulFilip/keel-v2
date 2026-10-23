package dev.keel.android.data

import java.time.Instant

/**
 * The demo's pull requests, each with its own files, diffs, threads and checks (so #409 shows the retry change, not
 * the ETA one), and the pending comments of your review.
 */
class DemoReviews {
    private fun ago(sec: Long) = Instant.now().minusSeconds(sec).toString()
    private val d = '$'

    private class DemoFile(val path: String, val status: String, val diff: String) {
        val added get() = diff.lines().count { it.startsWith("+") && !it.startsWith("+++") }
        val removed get() = diff.lines().count { it.startsWith("-") && !it.startsWith("---") }
    }

    private class DemoPr(val summary: PrSummary, val files: List<DemoFile>, val threads: MutableList<ReviewThread>, val checks: List<CheckRun>, val approved: List<String>) {
        val drafts = mutableListOf<Draft>()
    }

    val list = listOf(
        PrSummary(412, "Keep the stored ETA when Parcel Perform sends none", "milad", "feature/ERPDM-1769", "main", updatedAt = ago(7200), mine = true),
        PrSummary(409, "Carrier adapter: retry on 429 with backoff", "sara.k", "feature/ERPDM-1758", "main", updatedAt = ago(18_000), reviewRequested = true),
        PrSummary(405, "Tracking page: show the last known ETA", "j.berg", "feature/ERPDM-1744", "main", updatedAt = ago(86_400), reviewRequested = true),
        PrSummary(398, "Shipment search by reference", "milad", "feature/ERPDM-1650", "main", updatedAt = ago(172_800), mine = true),
    )

    private fun checks(n: Int, failed: String? = null) = (1..n).map { CheckRun(listOf("phpunit (8.3)", "phpstan", "php-cs-fixer", "deptrac", "composer audit", "eslint", "build", "e2e smoke", "migrations", "openapi diff", "coverage", "secrets", "docker", "sonar")[(it - 1) % 14], "success") } +
        listOfNotNull(failed?.let { CheckRun(it, "failure") })

    private val prs: Map<Int, DemoPr> = mapOf(
        412 to DemoPr(
            list[0],
            listOf(
                DemoFile(
                    "src/Eta/EtaWebhook.php", "modified",
                    """
                    @@ -52,9 +52,14 @@ final class EtaWebhook
                         public function handle(EtaPayload ${d}payload): void
                         {
                             ${d}shipment = ${d}this->shipments->byTracking(${d}payload->tracking);
                    -        ${d}shipment->setEta(${d}payload->eta);
                    +        if (${d}payload->eta === null) {
                    +            ${d}this->log->info('eta absent, kept', ['carrier' => ${d}payload->carrier]);
                    +            return;
                    +        }
                    +        ${d}shipment->setEta(${d}payload->eta);
                             ${d}shipment->touchEtaUpdatedAt(${d}this->clock->now());
                    +        ${d}this->shipments->save(${d}shipment);
                             ${d}this->events->dispatch(new EtaChanged(${d}shipment->id()));
                         }
                     }
                    """.trimIndent(),
                ),
                DemoFile(
                    "tests/Integration/Eta/EtaAbsentKeepsStoredTest.php", "added",
                    """
                    @@ -0,0 +1,26 @@
                    +<?php
                    +
                    +namespace App\Tests\Integration\Eta;
                    +
                    +use App\Eta\EtaWebhook;
                    +use App\Tests\Integration\IntegrationTestCase;
                    +
                    +final class EtaAbsentKeepsStoredTest extends IntegrationTestCase
                    +{
                    +    protected function setUp(): void
                    +    {
                    +        parent::setUp();
                    +        ${d}conn = ${d}this->connection();
                    +        ${d}conn->insert('carrier', ['id' => 7, 'name' => 'DHL']);
                    +        ${d}conn->insert('resolver', ['carrier_id' => 7, 'kind' => 'parcel-perform']);
                    +        ${d}conn->insert('shipment', ['id' => 41, 'tracking' => 'JD0001', 'eta' => '2026-10-21']);
                    +    }
                    +
                    +    public function test_absent_eta_keeps_the_stored_one(): void
                    +    {
                    +        ${d}this->webhook()->handle(${d}this->payload(tracking: 'JD0001', eta: null));
                    +
                    +        self::assertSame('2026-10-21', ${d}this->shipment(41)->eta()?->format('Y-m-d'));
                    +    }
                    +}
                    +
                    """.trimIndent(),
                ),
                DemoFile(
                    "migrations/Version20261020.php", "added",
                    """
                    @@ -0,0 +1,14 @@
                    +<?php
                    +
                    +declare(strict_types=1);
                    +
                    +namespace DoctrineMigrations;
                    +
                    +final class Version20261020 extends AbstractMigration
                    +{
                    +    public function up(Schema ${d}schema): void
                    +    {
                    +        ${d}this->addSql('ALTER TABLE shipment RENAME COLUMN eta_at TO eta_updated_at');
                    +        ${d}this->addSql('CREATE INDEX shipment_eta_updated ON shipment (eta_updated_at)');
                    +    }
                    +}
                    """.trimIndent(),
                ),
            ),
            mutableListOf(
                ReviewThread(
                    "412-1", "tests/Integration/Eta/EtaAbsentKeepsStoredTest.php", 15, startLine = 13,
                    comments = listOf(
                        ReviewComment("c1", "sara.k", "Maybe a factory would fit here?", ago(10_800)),
                        ReviewComment("c2", "milad", "Fair point, thanks. Will update it.", ago(3600)),
                    ),
                ),
                ReviewThread("412-2", "src/Eta/EtaWebhook.php", 56, comments = listOf(ReviewComment("c3", "sara.k", "Should this log the shipment too, not only the carrier (AC-3)?", ago(7000)))),
                ReviewThread(
                    "412-3", "migrations/Version20261020.php", 11, resolved = true,
                    comments = listOf(ReviewComment("c4", "j.berg", "rename eta_at to eta_updated_at", ago(20_000)), ReviewComment("c5", "milad", "Renamed in 3c1f9a2. Thanks!", ago(18_000))),
                ),
            ),
            checks(14), listOf("j.berg"),
        ),
        409 to DemoPr(
            list[1],
            listOf(
                DemoFile(
                    "src/Carrier/HttpCarrierClient.php", "modified",
                    """
                    @@ -31,12 +31,20 @@ final class HttpCarrierClient implements CarrierClient
                         public function track(string ${d}tracking): TrackingResponse
                         {
                    -        ${d}response = ${d}this->http->request('GET', ${d}this->url(${d}tracking));
                    -        if (${d}response->getStatusCode() === 429) {
                    -            throw new CarrierThrottled(${d}this->carrier);
                    +        for (${d}try = 1; ; ${d}try++) {
                    +            ${d}response = ${d}this->http->request('GET', ${d}this->url(${d}tracking));
                    +            if (${d}response->getStatusCode() !== 429) {
                    +                break;
                    +            }
                    +            if (${d}try >= ${d}this->backoff->maxTries()) {
                    +                throw new CarrierThrottled(${d}this->carrier, ${d}try);
                    +            }
                    +            ${d}this->sleeper->sleep(${d}this->backoff->delay(${d}try, ${d}response->getHeaders(false)['retry-after'][0] ?? null));
                             }

                             return TrackingResponse::fromArray(${d}response->toArray());
                         }
                    """.trimIndent(),
                ),
                DemoFile(
                    "src/Carrier/Backoff.php", "added",
                    """
                    @@ -0,0 +1,24 @@
                    +<?php
                    +
                    +namespace App\Carrier;
                    +
                    +/** Exponential backoff for a carrier that answers 429: 1 s, 2 s, 4 s, ... capped, Retry-After wins. */
                    +final class Backoff
                    +{
                    +    public function __construct(private int ${d}maxTries = 4, private int ${d}capMs = 8000) {}
                    +
                    +    public function maxTries(): int { return ${d}this->maxTries; }
                    +
                    +    public function delay(int ${d}try, ?string ${d}retryAfter): int
                    +    {
                    +        ${d}base = min(${d}this->capMs, 1000 * 2 ** (${d}try - 1));
                    +        ${d}jitter = random_int(0, intdiv(${d}base, 4));
                    +        if (${d}retryAfter !== null && ctype_digit(${d}retryAfter)) {
                    +            return min(${d}this->capMs, (int) ${d}retryAfter * 1000);
                    +        }
                    +
                    +        return ${d}base + ${d}jitter;
                    +    }
                    +}
                    +
                    +
                    """.trimIndent(),
                ),
                DemoFile(
                    "tests/Unit/Carrier/BackoffTest.php", "added",
                    """
                    @@ -0,0 +1,18 @@
                    +<?php
                    +
                    +namespace App\Tests\Unit\Carrier;
                    +
                    +use App\Carrier\Backoff;
                    +use PHPUnit\Framework\TestCase;
                    +
                    +final class BackoffTest extends TestCase
                    +{
                    +    public function test_retry_after_wins(): void
                    +    {
                    +        self::assertSame(3000, (new Backoff())->delay(1, '3'));
                    +    }
                    +
                    +    public function test_capped(): void
                    +    {
                    +        self::assertLessThanOrEqual(10000, (new Backoff())->delay(9, null));
                    +    }
                    """.trimIndent(),
                ),
            ),
            mutableListOf(
                ReviewThread(
                    "409-1", "src/Carrier/Backoff.php", 15,
                    comments = listOf(
                        ReviewComment("c6", "milad", "Should the delay have some jitter? Two workers would retry in lockstep.", ago(14_000)),
                        ReviewComment("c7", "sara.k", "Good catch: random_int jitter added, up to a quarter of the delay.", ago(5000)),
                    ),
                ),
                ReviewThread("409-2", "src/Carrier/HttpCarrierClient.php", 41, comments = listOf(ReviewComment("c8", "j.berg", "Sleeping in a web request: is this only called from the worker?", ago(4000)))),
            ),
            checks(12), emptyList(),
        ),
        405 to DemoPr(
            list[2],
            listOf(
                DemoFile(
                    "templates/tracking/show.html.twig", "modified",
                    """
                    @@ -18,7 +18,12 @@
                       <section class="eta">
                    -    <p>{{ shipment.eta|date('d M Y') }}</p>
                    +    {% if shipment.eta %}
                    +      <p>{{ shipment.eta|date('d M Y') }}</p>
                    +    {% else %}
                    +      <p class="eta-last">Last known ETA: {{ shipment.lastKnownEta|date('d M Y') }}</p>
                    +      <small>updated {{ shipment.etaUpdatedAt|ago }}</small>
                    +    {% endif %}
                       </section>
                    """.trimIndent(),
                ),
                DemoFile(
                    "assets/tracking.css", "modified",
                    """
                    @@ -40,3 +40,7 @@
                     .eta p { font-weight: 600; }
                    +.eta-last { color: var(--dim); }
                    +.eta small { display: block; font-size: 12px; }
                    """.trimIndent(),
                ),
            ),
            mutableListOf(
                ReviewThread(
                    "405-1", "templates/tracking/show.html.twig", 22,
                    comments = listOf(
                        ReviewComment("c9", "milad", "Show the date in the shipment's timezone?", ago(60_000)),
                        ReviewComment("c10", "j.berg", "It uses the reader's timezone, like the rest of the page. OK?", ago(30_000)),
                    ),
                ),
            ),
            checks(11, failed = "e2e smoke"), emptyList(),
        ),
        398 to DemoPr(
            list[3],
            listOf(
                DemoFile(
                    "src/Search/ShipmentSearch.php", "modified",
                    """
                    @@ -12,6 +12,10 @@ final class ShipmentSearch
                         public function find(string ${d}q): array
                         {
                    +        if (preg_match('/^[A-Z]{2}\d{4,}${d}/', ${d}q)) {
                    +            return ${d}this->repo->byReference(${d}q);
                    +        }
                    +
                             return ${d}this->repo->fullText(${d}q);
                         }
                    """.trimIndent(),
                ),
            ),
            mutableListOf(
                ReviewThread(
                    "398-1", "src/Search/ShipmentSearch.php", 15, resolved = true,
                    comments = listOf(ReviewComment("c11", "sara.k", "Is the reference always two letters?", ago(200_000)), ReviewComment("c12", "milad", "Yes, carrier prefix. Added a test.", ago(190_000))),
                ),
            ),
            checks(14), listOf("sara.k", "j.berg"),
        ),
    )

    private fun prOf(key: String?) = prs[key.orEmpty().removePrefix("pr:").toIntOrNull() ?: 412] ?: prs.getValue(412)

    fun view(key: String?): ReviewView {
        val p = prOf(key)
        val s = p.summary
        return ReviewView(
            key = "pr:${s.number}", number = s.number, title = s.title, author = s.author, base = s.base, branch = s.branch,
            url = "https://github.com/acme/tracking/pull/${s.number}", state = "open", checks = p.checks, approved = p.approved,
            files = p.files.map { ChangedFile(it.path, it.status, it.added, it.removed) }, added = p.files.sumOf { it.added }, removed = p.files.sumOf { it.removed },
            threads = p.threads.toList(), drafts = p.drafts.toList(), canPost = true,
            host = HostRef("github", "github.com", "acme/tracking", "https://github.com/acme/tracking"), me = "milad",
        )
    }

    fun diff(key: String?, path: String): FileDiff {
        val f = prOf(key).files.firstOrNull { it.path == path } ?: return FileDiff(path, "")
        return FileDiff(path, "diff --git a/$path b/$path\n--- a/$path\n+++ b/$path\n" + f.diff)
    }

    private fun prOfThread(id: String) = prs.values.firstOrNull { p -> p.threads.any { it.id == id } }

    fun reply(threadId: String, body: String): ReviewView {
        val p = prOfThread(threadId) ?: prs.getValue(412)
        val i = p.threads.indexOfFirst { it.id == threadId }
        if (i >= 0) p.threads[i] = p.threads[i].copy(comments = p.threads[i].comments + ReviewComment("r${System.nanoTime()}", "milad", body, Instant.now().toString()))
        return view("pr:${p.summary.number}")
    }

    fun resolve(threadId: String, resolved: Boolean): ReviewView {
        val p = prOfThread(threadId) ?: prs.getValue(412)
        val i = p.threads.indexOfFirst { it.id == threadId }
        if (i >= 0) p.threads[i] = p.threads[i].copy(resolved = resolved)
        return view("pr:${p.summary.number}")
    }

    fun addDraft(key: String?, path: String?, line: Int?, side: String, body: String): Draft {
        val draft = Draft("d${System.nanoTime()}", path, line, side, body, Instant.now().toString())
        prOf(key).drafts += draft
        return draft
    }

    fun deleteDraft(id: String) = prs.values.forEach { p -> p.drafts.removeAll { it.id == id } }

    /** The pending comments become threads of yours on the code host. */
    fun submit(key: String?): SubmitResult {
        val p = prOf(key)
        val n = p.drafts.size
        p.drafts.forEach { dr -> p.threads += ReviewThread("new-${dr.id}", dr.path, dr.line, dr.side, comments = listOf(ReviewComment("c-${dr.id}", "milad", dr.body, Instant.now().toString()))) }
        p.drafts.clear()
        return SubmitResult(n, "COMMENT", null, view(key))
    }
}
