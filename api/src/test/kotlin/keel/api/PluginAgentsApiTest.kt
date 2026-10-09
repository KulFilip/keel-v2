package keel.api

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.ResultActions
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import java.nio.file.Files
import java.nio.file.Path

/**
 * Step 7 (docs/plugins/16-steps5-7-contract.md): the agents of the plugins a person installed show on the Agents page;
 * a plugin that came in keel's image keeps today's list (only its AgentFiles, as KeelBot's helper). Also a content-only
 * plugin (no engine, no api part) shows its workflows. The resolved.json is what keel-start would write.
 */
@SpringBootTest
@AutoConfigureMockMvc
class PluginAgentsApiTest {
    @Autowired lateinit var mvc: MockMvc
    @Autowired lateinit var mapper: ObjectMapper

    companion object {
        val dataDir: Path = Files.createTempDirectory("keel-plugin-agents")
        private val plugins: Path = Files.createTempDirectory("keel-plugin-agents-store")

        private fun agent(name: String, about: String) = "---\nname: $name\ndescription: $about\ntools: Read, Grep\n---\n\nYou are $about.\n"

        /** A plugin folder with content/agents/<file>.md for each agent. */
        private fun content(name: String, agents: Map<String, String>): Path {
            val dir = Files.createDirectories(plugins.resolve(name).resolve("1.0.0").resolve("content").resolve("agents"))
            agents.forEach { (file, text) -> Files.writeString(dir.resolve("$file.md"), text) }
            return dir.parent
        }

        private fun entry(name: String, source: String, content: Path?, engine: Boolean = false) = mapOf(
            "name" to name, "title" to name.replaceFirstChar { it.uppercase() }, "version" to "1.0.0", "source" to source,
            "dir" to plugins.resolve(name).resolve("1.0.0").toString(),
            "engine" to if (engine) mapOf("path" to plugins.resolve(name).resolve("1.0.0/engine").toString(), "package" to "keel_plugin_$name") else null,
            "api" to null, "web" to null, "content" to content?.toString(), "migrations" to null, "requires" to mapOf("sdk" to 1),
        )

        init {
            val notes = content("notes", mapOf(
                "notes-agent" to agent("notes-agent", "the notes agent"),
                "explorer" to agent("explorer", "not keel's explorer"),          // keel's file name: never shown
                "sneaky" to agent("implementer", "not keel's implementer"),      // keel's id in another file: never shown
                "contract-author" to agent("contract-author", "not keel's contract author"),   // keel's, without a file
            ))
            val tools = content("tools", mapOf("tools-helper" to agent("tools-helper", "the tools helper"),
                "notes-agent" to agent("notes-agent", "a second notes agent")))  // an earlier plugin has it
            val imaged = content("imaged", mapOf("imaged-agent" to agent("imaged-agent", "an image plugin's agent")))
            val resolved = mapOf(
                "sdk" to 1, "keel" to "0.15.6", "mode" to "on", "resolved_at" to "2026-10-09T10:00:00Z",
                "plugins" to listOf(
                    entry("imaged", "image", imaged, engine = true),
                    entry("notes", "marketplace", notes),
                    entry("tools", "file", tools, engine = true),
                ),
                "problems" to emptyList<Any>(),
            )
            val run = Files.createDirectories(dataDir.resolve("plugins").resolve("run"))
            Files.writeString(run.resolve("resolved.json"), jacksonObjectMapper().writeValueAsString(resolved))
        }

        @JvmStatic
        @DynamicPropertySource
        fun props(r: DynamicPropertyRegistry) {
            ApiTest.props(r)
            r.add("keel.data") { dataDir.toString() }
        }
    }

    private fun get(url: String): ResultActions = mvc.perform(MockMvcRequestBuilders.get(url))
    private fun ResultActions.json(): JsonNode = mapper.readTree(andReturn().response.getContentAsString(Charsets.UTF_8))

    private fun project(name: String): String {
        val root = Files.createDirectories(Files.createTempDirectory("keel-proj").resolve(name))
        for (args in listOf(listOf("init", "-q", "-b", "main"), listOf("commit", "-q", "--allow-empty", "-m", "first"))) {
            val p = ProcessBuilder(listOf("git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false") + args)
                .directory(root.toFile()).redirectErrorStream(true).start()
            p.inputStream.readAllBytes()
            assertThat(p.waitFor()).isZero()
        }
        return mvc.perform(MockMvcRequestBuilders.post("/api/projects").contentType("application/json")
            .content(mapper.writeValueAsString(mapOf("root" to root.toString())))).andExpect(status().isOk).json()["id"].asText()
    }

    @Test
    fun `installed plugins' agents show on the Agents page, an image plugin's do not, keel's names always win`() {
        val pid = project("plugin-agents")
        val agents = get("/api/projects/$pid/agents").andExpect(status().isOk).json()
        val ids = agents.map { it["id"].asText() }
        // keel's fixture agents, then the installed plugins' agents, one list in file-name order
        assertThat(ids).containsExactly("explorer", "helper", "implementer", "notes-agent", "reviewer", "test-author", "tools-helper")
        assertThat(ids).doesNotContain("imaged-agent", "contract-author")
        val notes = agents.first { it["id"].asText() == "notes-agent" }
        assertThat(notes["about"].asText()).isEqualTo("the notes agent")
        assertThat(notes["custom"].asBoolean()).isFalse()
        assertThat(notes["prompt"].asText()).isEqualTo("You are the notes agent.")
        assertThat(agents.first { it["id"].asText() == "explorer" }["about"].asText()).isEqualTo("Maps the code an acceptance criterion touches, read-only.")
        assertThat(agents.first { it["id"].asText() == "implementer" }["about"].asText()).doesNotContain("not keel's")
        // a plugin's agent can be changed per project like keel's, and is not a custom agent to delete
        mvc.perform(MockMvcRequestBuilders.put("/api/projects/$pid/agents/notes-agent").contentType("application/json")
            .content("""{"enabled": false}""")).andExpect(status().isOk)
        assertThat(get("/api/projects/$pid/agents").json().first { it["id"].asText() == "notes-agent" }["enabled"].asBoolean()).isFalse()
        mvc.perform(MockMvcRequestBuilders.delete("/api/projects/$pid/agents/notes-agent")).andExpect(status().isConflict)
    }

    @Test
    fun `a content-only plugin's workflow is listed while it is loaded`() {
        val gate = listOf(mapOf("id" to "wait", "kind" to "gate", "name" to "wait here", "phase" to "review"))
        val added = listOf(mapOf("id" to "notes-flow", "name" to "notes flow", "addon" to "notes", "keel_rules" to false, "version" to 1,
            "steps" to gate, "yaml" to ""))
        ApiTest.engine.extraTemplates += added
        try {
            val ids = get("/api/projects/${project("plugin-flows")}/workflows").andExpect(status().isOk).json().map { it["id"].asText() }
            assertThat(ids).contains("feature", "notes-flow")
        } finally {
            ApiTest.engine.extraTemplates -= added.toSet()
        }
    }
}
