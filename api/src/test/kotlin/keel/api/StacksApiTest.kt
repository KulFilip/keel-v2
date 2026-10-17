package keel.api

import keel.api.support.ApiTest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest

/**
 * keel 0.18.9 Stacks: where each stack comes from (keel, a keel pack, an installed pack, the marketplace, the project),
 * which ones may be removed and why not, one turned off for the project, one stack with its YAML; suggest, check, save,
 * remove and off go to the engine (runtime/stack_edit.py, here a stub that writes the files the way it does); the
 * marketplace's Stacks (search with keel's own, one stack, install, update with replace) and the MCP levels.
 */
class StacksApiTest : ApiTest() {
    private fun sha(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }

    private fun zig(v: String) = "name: zig\nlane: api\ndetect: {files: [build.zig]}\nlayers: [{id: unit, what: x ($v)}]\n"
    private val review = mapOf("lane" to "api", "detect" to mapOf("files" to listOf("build.zig")), "layers" to listOf("unit"),
        "commands" to emptyMap<String, Any>(), "tools" to emptyList<Any>(), "skills" to listOf("zig-testing"))

    private fun hit(version: String?) = mapOf(
        "name" to "zig", "kind" to "stacks", "title" to "Zig", "publisher" to "keel", "publisher_title" to "keel", "verified" to true,
        "version" to version, "summary" to "Zig with zig build.", "category" to "other", "tags" to emptyList<String>(), "review" to review,
        "requires" to emptyMap<String, Any>(), "fits" to (version != null), "refused" to null, "source" to "keel", "repo" to "",
        "latest" to (version ?: "1.0.0"), "old" to false, "why_not" to null, "trust" to "content")

    private var fetchRefusal: Pair<Int, Map<String, Any?>>? = null
    private var saveRefusal: Pair<Int, Map<String, Any?>>? = null
    private val routes = listOf("/stacks/suggest", "/stacks/check", "/stacks/save", "/stacks/remove", "/stacks/off",
        "/marketplace/stacks", "/marketplace/stacks/zig", "/marketplace/stacks/zig/fetch", "/marketplace/stacks/kotlin-spring",
        "/marketplace/stacks/django")

    @BeforeEach
    fun stub() {
        fetchRefusal = null
        saveRefusal = null
        engine.extraRoutes["/stacks/suggest"] = { _ -> 200 to mapOf("lane" to "api", "closest" to "kotlin-spring", "commands" to emptyMap<String, Any>()) }
        engine.extraRoutes["/stacks/check"] = { b ->
            val yaml = b?.path("yaml")?.asText("").orEmpty()
            val ok = yaml.contains("lane:")
            200 to mapOf("ok" to ok, "errors" to if (ok) emptyList() else listOf("its lane is None"), "warnings" to emptyList<String>(),
                "name" to Regex("name: (\\S+)").find(yaml)?.groupValues?.get(1), "review" to review, "yaml" to yaml)
        }
        // the engine's save, as runtime/stack_edit.py writes it
        engine.extraRoutes["/stacks/save"] = { b ->
            saveRefusal ?: run {
                val root = Path.of(b!!.path("root").asText())
                val yaml = b.path("yaml").asText()
                val name = Regex("name: (\\S+)").find(yaml)!!.groupValues[1]
                val f = root.resolve(".keel/stacks/$name.yml")
                val had = Files.exists(f)
                Files.createDirectories(f.parent)
                Files.writeString(f, yaml)
                if (b.path("source").asText() == "marketplace") {
                    Files.writeString(root.resolve(".keel/stacks/.installed.json"), mapper.writeValueAsString(mapOf(name to mapOf(
                        "source" to "marketplace", "version" to b.path("market").path("version").asText(),
                        "catalog" to b.path("market").path("catalog").asText(), "sha256" to sha(yaml)))))
                }
                200 to mapOf("name" to name, "path" to ".keel/stacks/$name.yml", "replaced" to had, "check" to mapOf("warnings" to listOf("w")))
            }
        }
        engine.extraRoutes["/stacks/remove"] = { b ->
            if (b?.path("name")?.asText() == "kotlin-spring") 409 to mapOf("error" to "kotlin-spring ships with keel: it cannot be removed.", "hint" to "Turn it off.")
            else 200 to mapOf("name" to b?.path("name")?.asText(), "removed" to ".keel/stacks/x.yml", "back" to null)
        }
        engine.extraRoutes["/stacks/off"] = { b -> 200 to mapOf("name" to b?.path("name")?.asText(), "off" to b?.path("off")?.asBoolean(), "all" to listOf("x")) }
        engine.extraRoutes["/marketplace/stacks"] = { _ ->
            200 to mapOf("stacks" to listOf(hit("1.1.0")), "sources" to emptyList<Any>(), "categories" to listOf("jvm", "other"))
        }
        engine.extraRoutes["/marketplace/stacks/zig"] = { _ -> 200 to (hit("1.1.0") + mapOf("versions" to emptyList<Any>(), "checks" to listOf("x"))) }
        engine.extraRoutes["/marketplace/stacks/kotlin-spring"] = { _ -> 404 to mapOf("error" to "There is no stack kotlin-spring in the catalogs keel reads.") }
        engine.extraRoutes["/marketplace/stacks/django"] = { _ -> 404 to mapOf("error" to "There is no stack django in the catalogs keel reads.") }
        engine.extraRoutes["/marketplace/stacks/zig/fetch"] = { b ->
            fetchRefusal ?: run {
                val v = b?.path("version")?.asText(null) ?: "1.1.0"
                200 to mapOf("name" to "zig", "version" to v, "title" to "Zig", "publisher" to "keel", "catalog" to "keel", "yaml" to zig(v),
                    "review" to review, "requires" to emptyMap<String, Any>(), "sha256" to "a".repeat(64), "warnings" to emptyList<String>())
            }
        }
    }

    @AfterEach
    fun after() = routes.forEach { engine.extraRoutes.remove(it) }

    @Test
    fun `each stack says where it comes from, whether it is used, and whether it can be removed`() {
        val (pid, root) = newProject("st-list", mapOf("build.gradle.kts" to "", ".keel/config.yml" to "stacks:\n  ignore: [kotlin-spring]\n"))
        Files.createDirectories(root.resolve(".keel/stacks/django"))
        Files.writeString(root.resolve(".keel/stacks/django/stack.yml"), Files.readString(contentDir.resolve("packs/django/stack.yml")))
        Files.writeString(root.resolve(".keel/stacks/mine.yml"), "name: mine\nlane: web\ndetect: {files: [x]}\nlayers: [{id: u}]\n")
        Files.writeString(root.resolve(".keel/stacks/zig.yml"), zig("1.0.0") + "# edited\n")
        Files.writeString(root.resolve(".keel/stacks/.installed.json"),
            mapper.writeValueAsString(mapOf("zig" to mapOf("source" to "marketplace", "version" to "1.0.0", "catalog" to "keel", "sha256" to sha(zig("1.0.0"))))))
        val all = get("/api/projects/$pid/stacks").andExpect(status().isOk).json().associateBy { it["name"].asText() }
        val ks = all.getValue("kotlin-spring")
        assertThat(ks["origin"].asText()).isEqualTo("keel")
        assertThat(ks["off"].asBoolean()).isTrue()
        assertThat(ks["detected"].asBoolean()).isTrue()
        assertThat(ks["removable"].asBoolean()).isFalse()
        assertThat(ks["why"].asText()).contains("Turn it off for this project instead")
        assertThat(ks["file"].isNull).isTrue()
        assertThat(all.getValue("django")["origin"].asText()).isEqualTo("pack")
        assertThat(all.getValue("django")["removable"].asBoolean()).isTrue()
        assertThat(all.getValue("django")["file"].asText()).isEqualTo(".keel/stacks/django/stack.yml")
        assertThat(all.getValue("mine")["origin"].asText()).isEqualTo("project")
        val z = all.getValue("zig")
        assertThat(z["origin"].asText()).isEqualTo("marketplace")
        assertThat(z["market"]["version"].asText()).isEqualTo("1.0.0")
        assertThat(z["market"]["edited"].asBoolean()).isTrue()
        // one stack with its YAML
        val one = get("/api/projects/$pid/stacks/mine").andExpect(status().isOk).json()
        assertThat(one["yaml"].asText()).startsWith("name: mine")
        assertThat(get("/api/projects/$pid/stacks/kotlin-spring").json()["yaml"].asText()).contains("kotlin-spring")
        get("/api/projects/$pid/stacks/nope").andExpect(status().isNotFound)
    }

    @Test
    fun `suggest, check, save, remove and off go to the engine with the project's folder`() {
        val (pid, root) = newProject("st-engine", mapOf("build.zig" to ""))
        assertThat(get("/api/projects/$pid/stacks/suggest?lane=api").andExpect(status().isOk).json()["closest"].asText()).isEqualTo("kotlin-spring")
        assertThat(engine.calls.last { it.path == "/stacks/suggest" }.query).contains("lane=api")
        get("/api/projects/$pid/stacks/suggest?lane=desktop").andExpect(status().isBadRequest)
        // check: saves nothing, and names the skills this project does not have
        val checked = post("/api/projects/$pid/stacks/check", mapOf("yaml" to zig("1"))).andExpect(status().isOk).json()
        assertThat(checked["ok"].asBoolean()).isTrue()
        assertThat(checked["skills_missing"].map { it.asText() }).containsExactly("zig-testing")
        assertThat(engine.lastBody("/stacks/check")!!["root"].asText()).isEqualTo(root.toString())
        post("/api/projects/$pid/stacks/check", mapOf("form" to mapOf("name" to "zig"))).andExpect(status().isOk)
        assertThat(engine.lastBody("/stacks/check")!!["form"]["name"].asText()).isEqualTo("zig")
        assertThat(Files.exists(root.resolve(".keel/stacks"))).isFalse()
        // save: the stack as the list shows it, where it went, the warnings
        val saved = post("/api/projects/$pid/stacks/save", mapOf("yaml" to zig("1"))).andExpect(status().isOk).json()
        assertThat(saved["stack"]["name"].asText()).isEqualTo("zig")
        assertThat(saved["stack"]["origin"].asText()).isEqualTo("project")
        assertThat(saved["path"].asText()).isEqualTo(".keel/stacks/zig.yml")
        assertThat(saved["warnings"].map { it.asText() }).containsExactly("w")
        assertThat(engine.lastBody("/stacks/save")!!["source"].asText()).isEqualTo("project")
        post("/api/projects/$pid/stacks/save", mapOf("form" to mapOf("x" to 1))).andExpect(status().isBadRequest)
        // the engine's refusal keeps its errors
        saveRefusal = 422 to mapOf("error" to "keel did not save the stack: its lane is None", "errors" to listOf("its lane is None"))
        val bad = post("/api/projects/$pid/stacks/save", mapOf("yaml" to "name: x\n")).andExpect(status().isUnprocessableEntity).json()
        assertThat(bad["errors"].map { it.asText() }).containsExactly("its lane is None")
        // remove: keel's own is refused with the engine's words; off
        delete("/api/projects/$pid/stacks/zig").andExpect(status().isOk)
        assertThat(engine.lastBody("/stacks/remove")!!["name"].asText()).isEqualTo("zig")
        val refused = delete("/api/projects/$pid/stacks/kotlin-spring").andExpect(status().isConflict).json()
        assertThat(refused["hint"].asText()).isEqualTo("Turn it off.")
        delete("/api/projects/$pid/stacks/Bad_Name").andExpect(status().isBadRequest)
        assertThat(put("/api/projects/$pid/stacks/go/off", mapOf("off" to true)).andExpect(status().isOk).json()["all"][0].asText()).isEqualTo("x")
        assertThat(engine.lastBody("/stacks/off")!!["off"].asBoolean()).isTrue()
    }

    @Test
    fun `the marketplace lists the catalogs' stacks and keel's own, and installs one into a project`() {
        val (pid, root) = newProject("st-market", mapOf("build.gradle.kts" to ""))
        val found = get("/api/marketplace/stacks?project=$pid").andExpect(status().isOk).json()
        assertThat(found["stacks"].single()["installed"].isNull).isTrue()
        val builtin = found["builtin"].associateBy { it["name"].asText() }
        assertThat(builtin.keys).containsExactlyInAnyOrder("kotlin-spring", "django")
        assertThat(builtin.getValue("kotlin-spring")["used"].asBoolean()).isTrue()
        assertThat(builtin.getValue("django")["installable"].asBoolean()).isTrue()
        assertThat(builtin.getValue("django")["yaml"]).isNull()
        assertThat(get("/api/marketplace/stacks?q=django").json()["builtin"].map { it["name"].asText() }).containsExactly("django")
        // one stack: its verified YAML and keel's check against the project
        val one = get("/api/marketplace/stacks/zig?project=$pid").andExpect(status().isOk).json()
        assertThat(one["yaml"].asText()).isEqualTo(zig("1.1.0"))
        assertThat(one["check"]["ok"].asBoolean()).isTrue()
        assertThat(one["builtin"].asBoolean()).isFalse()
        val own = get("/api/marketplace/stacks/kotlin-spring?project=$pid").andExpect(status().isOk).json()
        assertThat(own["builtin"].asBoolean()).isTrue()
        assertThat(own["yaml"].asText()).contains("name: kotlin-spring")
        assertThat(own["review"]["lane"].asText()).isEqualTo("api")
        assertThat(get("/api/marketplace/stacks/django").json()["checks"][1].asText()).contains("Install pack")
        fetchRefusal = 502 to mapOf("error" to "The signature of zig 1.1.0 does not match its publisher's key: x.")
        assertThat(get("/api/marketplace/stacks/zig").json()["fetch_error"]["error"].asText()).startsWith("The signature")
        fetchRefusal = null

        // install 1.0.0, then the search says installed + update; the same again is refused, replace updates it
        val done = post("/api/projects/$pid/stacks/market/install", mapOf("name" to "zig", "version" to "1.0.0")).andExpect(status().isOk).json()
        assertThat(done["stack"]["origin"].asText()).isEqualTo("marketplace")
        assertThat(done["market"]["version"].asText()).isEqualTo("1.0.0")
        assertThat(engine.lastBody("/stacks/save")!!["market"]["catalog"].asText()).isEqualTo("keel")
        assertThat(Files.readString(root.resolve(".keel/stacks/zig.yml"))).isEqualTo(zig("1.0.0"))
        val hit = get("/api/marketplace/stacks?project=$pid").json()["stacks"].single()
        assertThat(hit["installed"]["version"].asText()).isEqualTo("1.0.0")
        assertThat(hit["update"].asText()).isEqualTo("1.1.0")
        post("/api/projects/$pid/stacks/market/install", mapOf("name" to "zig", "version" to "1.0.0")).andExpect(status().isConflict)
        val other = post("/api/projects/$pid/stacks/market/install", mapOf("name" to "zig")).andExpect(status().isConflict).json()
        assertThat(other["hint"].asText()).contains("replace")
        val upd = post("/api/projects/$pid/stacks/market/install", mapOf("name" to "zig", "replace" to true)).andExpect(status().isOk).json()
        assertThat(upd["stack"]["market"]["version"].asText()).isEqualTo("1.1.0")
        assertThat(engine.lastBody("/stacks/save")!!["replace"].asBoolean()).isTrue()
        // the project's own stack with that name: an install says so
        Files.writeString(root.resolve(".keel/stacks/.installed.json"), "{}")
        assertThat(get("/api/marketplace/stacks?project=$pid").json()["stacks"].single()["conflict"].asText()).isEqualTo("project")
        post("/api/projects/$pid/stacks/market/install", mapOf("name" to "Bad Name")).andExpect(status().isBadRequest)
        post("/api/projects/nope/stacks/market/install", mapOf("name" to "zig")).andExpect(status().isNotFound)
    }

    @Test
    fun `a read MCP token checks stacks but changes none`() {
        val (pid, _) = newProject("st-mcp")
        val mcp = mapOf("X-Keel-Via" to "mcp", "X-Keel-Client" to "test", "X-Keel-Tool" to "t")
        post("/api/projects/$pid/stacks/check", mapOf("yaml" to zig("1")), mcp).andExpect(status().isOk)
        post("/api/projects/$pid/stacks/save", mapOf("yaml" to zig("1")), mcp).andExpect(status().isForbidden)
        post("/api/projects/$pid/stacks/market/install", mapOf("name" to "zig"), mcp).andExpect(status().isForbidden)
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete("/api/projects/$pid/stacks/zig")
            .header("X-Keel-Via", "mcp")).andExpect(status().isForbidden)
        mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put("/api/projects/$pid/stacks/go/off")
            .header("X-Keel-Via", "mcp").contentType("application/json").content("{\"off\":true}")).andExpect(status().isForbidden)
        get("/api/projects/$pid/stacks").andExpect(status().isOk)
    }
}
