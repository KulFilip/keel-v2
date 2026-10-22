package keel.api.repo

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/projects/{pid}/repo")
class RepoLogController(private val log: RepoLog) {

    /** v0.15.2 Code › Source control › Log: the branch list. */
    @GetMapping("/refs")
    fun refs(@PathVariable pid: String): RefsView = log.refs(pid)

    /** v0.15.2 The Git log: `branch` (blank = the current one) or `all`, filtered by author, text (or a commit id) and path. */
    @GetMapping("/log")
    fun log(
        @PathVariable pid: String,
        @RequestParam(required = false) branch: String?,
        @RequestParam(defaultValue = "false") all: Boolean,
        @RequestParam(required = false) author: String?,
        @RequestParam(required = false) q: String?,
        @RequestParam(required = false) path: String?,
        @RequestParam(defaultValue = "100") limit: Int,
        @RequestParam(defaultValue = "0") skip: Int,
    ): GitLog = log.log(pid, branch, all, author, q, path, limit, skip)
}
