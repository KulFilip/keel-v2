package keel.api.review

import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/gitlab")
class GitLabConnectionController(private val gitlab: GitLabConnection) {
    @GetMapping fun get() = gitlab.view()
    @PutMapping fun save(@RequestBody b: GitLabSave) = gitlab.save(b)
    @DeleteMapping fun clear() = gitlab.clear()
}
