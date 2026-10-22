package keel.api.supervisor

import keel.api.pluginhost.PluginsReloaded
import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.context.ApplicationEventPublisher
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/** The Supervisor's switches in keel's settings: keel-wide (off until turned on), per project (else it follows), the
 *  plugin's own per project; each change goes to the engine at once. */
class SupervisorSwitchApiTest : ApiTest() {
    @Autowired lateinit var events: ApplicationEventPublisher

    private val sent = mutableListOf<Map<String, Any?>>()

    @Suppress("UNCHECKED_CAST")
    @BeforeEach
    fun engineListens() {
        sent.clear()
        engine.extraRoutes["/supervisor/switch"] = { body ->
            body?.let { sent += mapper.convertValue(it, Map::class.java) as Map<String, Any?> }
            200 to mapOf("keel" to (body?.path("keel")?.asBoolean() ?: false))
        }
        post("/api/supervisor/switch", mapOf("on" to false)).andExpect(status().isOk)
        sent.clear()
    }

    @AfterEach
    fun done() {
        engine.extraRoutes.remove("/supervisor/switch")
        engine.extraRoutes.remove("/plugins")
        events.publishEvent(PluginsReloaded(emptyList()))
    }

    @Suppress("UNCHECKED_CAST")
    private fun projectSent(pid: String) = (sent.last()["projects"] as Map<String, Map<String, Any?>>)[pid]

    @Test
    fun `it is off keel-wide until the person turns it on, and the engine hears each change`() {
        val (pid, _) = newProject("sup-switch-keel")
        assertThat(get("/api/supervisor/switch").json()["on"].asBoolean()).isFalse()
        assertThat(get("/api/projects/$pid/supervisor/switch").json()["on"].asBoolean()).isFalse()
        post("/api/supervisor/switch", mapOf("on" to true)).andExpect(status().isOk)
        assertThat(sent.last()["keel"]).isEqualTo(true)
        assertThat(projectSent(pid)!!["on"]).isEqualTo(true)              // the project follows General
        post("/api/supervisor/switch", mapOf("on" to false)).andExpect(status().isOk)
        assertThat(sent.last()["keel"]).isEqualTo(false)
        assertThat(get("/api/supervisor/switch").json()["on"].asBoolean()).isFalse()
    }

    @Test
    fun `the status reads as one sentence - off or on here, why, and the command that changes it`() {
        val (pid, _) = newProject("sup-switch-text")
        val off = get("/api/projects/$pid/supervisor/switch").json()["text"].asText()
        assertThat(off).startsWith("Supervisor: off here, ").doesNotContain("false").doesNotContain("(own: )")
        assertThat(get("/api/supervisor/switch").json()["text"].asText()).startsWith("Supervisor keel-wide: off")
        post("/api/projects/$pid/supervisor/switch", mapOf("on" to false))
        assertThat(get("/api/projects/$pid/supervisor/switch").json()["text"].asText())
            .contains("project off (this project's own choice)")
        post("/api/supervisor/switch", mapOf("on" to true))
        assertThat(get("/api/supervisor/switch").json()["text"].asText()).startsWith("Supervisor keel-wide: on")
    }

    @Test
    fun `a project's own switch wins over General, and null follows it again`() {
        val (pid, _) = newProject("sup-switch-project")
        post("/api/supervisor/switch", mapOf("on" to true))
        post("/api/projects/$pid/supervisor/switch", mapOf("on" to false)).andExpect(status().isOk).json().let {
            assertThat(it["own"].asBoolean()).isFalse()
            assertThat(it["project"].asBoolean()).isFalse()
            assertThat(it["keel"].asBoolean()).isTrue()
        }
        assertThat(sent.last()["keel"]).isEqualTo(true)
        assertThat(projectSent(pid)!!["on"]).isEqualTo(false)
        post("/api/projects/$pid/supervisor/switch", mapOf("on" to null)).andExpect(status().isOk).json().let {
            assertThat(it["own"].isNull).isTrue()
            assertThat(it["project"].asBoolean()).isTrue()
        }
        assertThat(projectSent(pid)!!["on"]).isEqualTo(true)
    }

    @Test
    fun `turning the plugin off for a project tells the engine at once`() {
        engine.extraRoutes["/plugins"] = { _ -> 200 to listOf(mapOf("name" to "supervisor", "title" to "Supervisor",
            "installable" to true, "per_project" to true, "actions" to emptyList<Any>())) }
        events.publishEvent(PluginsReloaded(listOf("supervisor")))
        val (pid, _) = newProject("sup-switch-plugin")
        put("/api/projects/$pid/plugins/supervisor", mapOf("enabled" to true)).andExpect(status().isOk)
        assertThat(projectSent(pid)!!["plugin"]).isEqualTo(true)
        assertThat(get("/api/projects/$pid/supervisor/switch").json()["plugin"].asBoolean()).isTrue()
        put("/api/projects/$pid/plugins/supervisor", mapOf("enabled" to false)).andExpect(status().isOk)
        assertThat(projectSent(pid)!!["plugin"]).isEqualTo(false)
        assertThat(get("/api/projects/$pid/supervisor/switch").json()["on"].asBoolean()).isFalse()
    }
}
