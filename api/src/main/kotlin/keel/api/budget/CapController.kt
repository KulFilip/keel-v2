package keel.api.budget

import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RestController

@RestController
class CapController(private val caps: CapService) {
    @GetMapping("/api/projects/{pid}/caps")
    fun list(@PathVariable pid: String): List<Cap> = caps.list(pid)

    @PostMapping("/api/projects/{pid}/caps")
    fun create(@PathVariable pid: String, @RequestBody body: Cap): Cap = caps.create(pid, body)

    @PutMapping("/api/projects/{pid}/caps/{id}")
    fun update(@PathVariable pid: String, @PathVariable id: String, @RequestBody body: Cap): Cap = caps.update(pid, id, body)

    @DeleteMapping("/api/projects/{pid}/caps/{id}")
    fun delete(@PathVariable pid: String, @PathVariable id: String): Map<String, Boolean> {
        caps.delete(pid, id)
        return mapOf("ok" to true)
    }
}
