package keel.api.connections

import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/github")
class GitHubLoginController(private val login: GitHubLoginService) {
    @PostMapping("/login")
    fun start(@RequestBody(required = false) body: GitHubLoginStart?): GitHubLoginView = login.start(body?.host.orEmpty())

    @GetMapping("/login/{id}")
    fun get(@PathVariable id: String): GitHubLoginView = login.get(id)

    @DeleteMapping("/login/{id}")
    fun cancel(@PathVariable id: String): GitHubLoginView = login.cancel(id)

    /** Sign out: removes keel's saved token. It says plainly that GitHub is not told (revoked_at_github). */
    @DeleteMapping
    fun signOut(): Map<String, Any> {
        val r = login.signOut()
        return mapOf("ok" to true, "removed" to r.removed, "revoked_at_github" to r.revokedAtGitHub, "note" to r.note)
    }
}
