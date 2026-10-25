package keel.api.connections

import com.fasterxml.jackson.databind.JsonNode
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

data class SelectMode(val mode: String = "")
data class SecretValue(val value: String = "")
data class StartLogin(val provider: String = "")
data class LoginCode(val code: String = "")

@RestController
@RequestMapping("/api")
class ConnectionController(private val connections: ConnectionService, private val secrets: SecretService, private val logins: LoginService,
                           private val firstLogin: FirstModelLogin) {

    /** Log a CLI in from the dashboard (inside the container); the result is saved encrypted. */
    @PostMapping("/logins")
    fun startLogin(@RequestBody body: StartLogin): LoginView = logins.start(body.provider)

    @GetMapping("/logins/{id}")
    fun login(@PathVariable id: String): LoginView = logins.get(id)

    @PostMapping("/logins/{id}/code")
    fun loginCode(@PathVariable id: String, @RequestBody body: LoginCode): LoginView = logins.code(id, body.code)

    @DeleteMapping("/logins/{id}")
    fun cancelLogin(@PathVariable id: String): LoginView = logins.cancel(id)

    @GetMapping("/connections")
    fun list(): Connections = connections.connections()

    @PutMapping("/connections/{provider}")
    fun select(@PathVariable provider: String, @RequestBody body: SelectMode): Connections = connections.select(provider, body.mode)

    @PostMapping("/connections/{provider}/test")
    fun test(@PathVariable provider: String): JsonNode = connections.test(provider)

    @PutMapping("/secrets/{name}")
    fun putSecret(@PathVariable name: String, @RequestBody body: SecretValue): Map<String, String> {
        secrets.checkShape(name, body.value)
        // a pasted GitHub token is not the one "Sign in with GitHub" saved: who that was no longer applies
        if (name == GitHubLoginService.TOKEN && secrets.has(GitHubLoginService.INFO)) secrets.delete(GitHubLoginService.INFO)
        val hint = secrets.put(name, body.value)
        firstLogin.savedSecret(name)
        return mapOf("hint" to hint)
    }

    @DeleteMapping("/secrets/{name}")
    fun deleteSecret(@PathVariable name: String): Map<String, Boolean> {
        secrets.delete(name)
        if (name == GitHubLoginService.TOKEN && secrets.has(GitHubLoginService.INFO)) secrets.delete(GitHubLoginService.INFO)
        return mapOf("ok" to true)
    }
}
