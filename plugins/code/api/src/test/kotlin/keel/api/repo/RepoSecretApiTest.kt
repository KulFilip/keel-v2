package keel.api.repo

import keel.api.support.ApiTest
import org.junit.jupiter.api.Test
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/** v0.16.0 keel_read_file reads through the Code page's route (from keel's McpAdminApiTest; the route is this
 *  plugin's): a secret file is never served. */
class RepoSecretApiTest : ApiTest() {

    @Test
    fun `a secret file is never served`() {
        val (pid, _) = newProject("mcp-secret", mapOf(".env" to "TOKEN=x\n", ".env.example" to "TOKEN=\n", "deploy/id_dsa" to "k\n"))
        get("/api/projects/$pid/repo/raw?path=.env").andExpect(status().isForbidden)
        get("/api/projects/$pid/repo/raw?path=deploy/id_dsa").andExpect(status().isForbidden)
        get("/api/projects/$pid/repo/raw?path=.env.example").andExpect(status().isOk)
    }
}
