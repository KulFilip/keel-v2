package keel.api.budget

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RestController

@RestController
class BudgetController(private val budget: BudgetService) {
    @GetMapping("/api/projects/{pid}/budget")
    fun budget(@PathVariable pid: String): Budget = budget.budget(pid)

    @GetMapping("/api/projects/{pid}/budget/now")
    fun now(@PathVariable pid: String): BudgetNow = budget.now(pid)

    @GetMapping("/api/limits")
    fun limits(): List<Limit> = budget.limits()

    @PutMapping("/api/limits")
    fun saveLimits(@RequestBody body: List<Limit>): List<Limit> = budget.saveLimits(body)
}
