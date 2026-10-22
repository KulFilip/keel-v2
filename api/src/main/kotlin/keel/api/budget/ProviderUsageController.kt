package keel.api.budget

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class ProviderUsageController(private val usage: ProviderUsageService) {
    @GetMapping("/api/usage/providers")
    fun list(): List<ProviderUsage> = usage.list()

    @PostMapping("/api/usage/providers/{id}/refresh")
    fun refresh(@PathVariable id: String): ProviderUsage = usage.refresh(id)
}
