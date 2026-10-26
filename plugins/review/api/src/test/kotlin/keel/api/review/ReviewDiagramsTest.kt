package keel.api.review

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Import
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import java.nio.file.Files

/**
 * The overview's diagrams (Database and System tabs): GET /review/diagrams sends the review's two commits and its
 * changed files to the engine (keel_plugin_review/diagrams reads them from git), keeps the answer per head commit, and
 * adds the Database plugin's live schema as "before" when the change touches database files and a connection answers.
 * The Database plugin is optional: here a stand-in bean named like its service gives the schema.
 */
@Import(ReviewDiagramsTest.LiveDb::class)
class ReviewDiagramsTest : ApiTest() {

    /** The Database plugin's service as the review finds it: by bean name, schema(pid, connection, agent). */
    class FakeDatabaseService {
        @Volatile var answer: JsonNode? = null
        val asked = mutableListOf<String>()
        fun schema(pid: String, connection: String?, agent: Boolean): JsonNode {
            asked += pid
            return answer ?: throw IllegalStateException("This project has no database connection")
        }
    }

    @TestConfiguration
    class LiveDb {
        @Bean("databaseService")
        fun databaseService() = FakeDatabaseService()
    }

    private val path = Regex("/plugins/review/[^/]+/diagrams")

    @AfterEach
    fun clean() {
        engine.extraRoutes.keys.removeIf { path.matches(it) }
    }

    private fun shop(name: String): Pair<String, java.nio.file.Path> {
        val (pid, root) = newProject(name, mapOf(
            "db/migration/V1__orders.sql" to "CREATE TABLE orders (id BIGINT PRIMARY KEY);\n",
            "src/Order/OrderController.php" to "<?php\nclass OrderController {}\n",
        ))
        git(root, "switch", "-q", "-c", "feat/refunds")
        Files.writeString(root.resolve("db/migration/V2__refunds.sql").also { Files.createDirectories(it.parent) },
            "CREATE TABLE refunds (id BIGINT PRIMARY KEY, order_id BIGINT NOT NULL REFERENCES orders(id));\n")
        Files.createDirectories(root.resolve("src/Refund"))
        Files.writeString(root.resolve("src/Refund/RefundController.php"), "<?php\nclass RefundController {}\n")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "refunds")
        git(root, "switch", "-q", "main")
        put("/api/projects/$pid/plugins/review", mapOf("enabled" to true)).andExpect(status().isOk)
        return pid to root
    }

    private fun answer(pid: String) {
        engine.extraRoutes["/plugins/review/$pid/diagrams"] = { body ->
            200 to mapOf("base" to body?.get("base")?.asText(), "head" to body?.get("head")?.asText(), "text" to "== System ==",
                "database" to mapOf("shown" to true, "count" to 1), "system" to mapOf("nodes" to emptyList<Any>()))
        }
    }

    @Test
    fun `the diagrams come from the engine once per head commit, with the changed files and the live schema`() {
        val (pid, root) = shop("review-diagrams-live")
        answer(pid)
        val p = "/plugins/review/$pid/diagrams"
        val live = beans().apply { asked.clear(); answer = jacksonObjectMapper().readTree("""{"connection":"local","tables":[{"name":"orders","columns":[]}]}""") }
        val d = get("/api/projects/$pid/review/diagrams?key=branch:feat/refunds").andExpect(status().isOk).json()
        assertThat(d["key"].asText()).isEqualTo("branch:feat/refunds")
        assertThat(d["database"]["shown"].asBoolean()).isTrue()
        val sent = engine.calls.filter { it.path == p }
        assertThat(sent).hasSize(1)
        val body = sent.single().body!!
        assertThat(body["root"].asText()).isEqualTo(root.toString())
        assertThat(body["head"].asText()).isEqualTo(git(root, "rev-parse", "feat/refunds").trim())
        assertThat(body["base"].asText()).isEqualTo(git(root, "rev-parse", "main").trim())
        assertThat(body["files"].map { it["path"].asText() to it["status"].asText() })
            .containsExactlyInAnyOrder("db/migration/V2__refunds.sql" to "A", "src/Refund/RefundController.php" to "A")
        assertThat(body["live"]["tables"][0]["name"].asText()).isEqualTo("orders")
        assertThat(body["live_name"].asText()).isEqualTo("local")
        assertThat(live.asked).containsExactly(pid)

        // kept per head commit: the same answer without the engine, until refresh or a new commit
        get("/api/projects/$pid/review/diagrams?key=branch:feat/refunds").andExpect(status().isOk)
        assertThat(engine.calls.count { it.path == p }).isEqualTo(1)
        get("/api/projects/$pid/review/diagrams?key=branch:feat/refunds&refresh=true").andExpect(status().isOk)
        assertThat(engine.calls.count { it.path == p }).isEqualTo(2)
        git(root, "switch", "-q", "feat/refunds")
        Files.writeString(root.resolve("src/Refund/RefundService.php"), "<?php\nclass RefundService {}\n")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "service")
        get("/api/projects/$pid/review/diagrams?key=branch:feat/refunds").andExpect(status().isOk)
        assertThat(engine.calls.count { it.path == p }).isEqualTo(3)
    }

    @Test
    fun `no database file changed or no connection means no live schema, and the plugin must be on`() {
        val (pid, root) = shop("review-diagrams-code")
        answer(pid)
        val live = beans().apply { asked.clear(); answer = null }
        git(root, "switch", "-q", "-c", "feat/code-only", "main")
        Files.createDirectories(root.resolve("src/Refund"))
        Files.writeString(root.resolve("src/Refund/RefundService.php"), "<?php\nclass RefundService {}\n")
        git(root, "add", "-A")
        git(root, "commit", "-qm", "code only")
        get("/api/projects/$pid/review/diagrams?key=branch:feat/code-only").andExpect(status().isOk)
        assertThat(engine.lastBody("/plugins/review/$pid/diagrams")!!["live"].isNull).isTrue()
        assertThat(live.asked).isEmpty()                                   // nothing in the change holds the database
        get("/api/projects/$pid/review/diagrams?key=branch:feat/refunds").andExpect(status().isOk)
        assertThat(engine.lastBody("/plugins/review/$pid/diagrams")!!["live"].isNull).isTrue()   // no connection: base migrations
        assertThat(live.asked).containsExactly(pid)
        put("/api/projects/$pid/plugins/review", mapOf("enabled" to false)).andExpect(status().isOk)
        get("/api/projects/$pid/review/diagrams?key=branch:feat/refunds").andExpect(status().isConflict)
    }

    private fun beans(): FakeDatabaseService = context.getBean("databaseService") as FakeDatabaseService

    @org.springframework.beans.factory.annotation.Autowired
    lateinit var context: org.springframework.context.ApplicationContext
}
