package keel.api.plugins

import keel.api.events.EventHub
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/projects/{pid}/git")
class GitPluginController(private val git: GitPluginService, private val hub: EventHub) {
    /** The branch or the files changed: the Code page (tree, changes, branch) reads them again. */
    private fun <T> changed(pid: String, result: T): T {
        hub.publish(pid, "project.changed", mapOf("id" to pid))
        return result
    }

    @GetMapping("/status") fun status(@PathVariable pid: String) = git.status(pid)
    @GetMapping("/branches") fun branches(@PathVariable pid: String) = git.branches(pid)
    @GetMapping("/branch") fun branch(@PathVariable pid: String, @RequestParam name: String) = git.branch(pid, name)
    @GetMapping("/log") fun log(@PathVariable pid: String) = git.log(pid)
    @GetMapping("/diff") fun diff(@PathVariable pid: String, @RequestParam(required = false) path: String?) = git.diff(pid, path)
    @GetMapping("/pr") fun pr(@PathVariable pid: String) = git.pr(pid)
    @PostMapping("/switch") fun switch(@PathVariable pid: String, @RequestBody body: GitSwitchBody) = changed(pid, git.switch(pid, body))
    @PostMapping("/commit") fun commit(@PathVariable pid: String, @RequestBody body: GitCommitBody) = changed(pid, git.commit(pid, body))
    @PostMapping("/sync") fun sync(@PathVariable pid: String) = changed(pid, git.sync(pid))
    @PostMapping("/push") fun push(@PathVariable pid: String) = git.push(pid)
    @PostMapping("/pr") fun openPr(@PathVariable pid: String, @RequestBody body: GitPrBody) = git.openPr(pid, body)
    @PostMapping("/cleanup") fun cleanup(@PathVariable pid: String) = changed(pid, git.cleanup(pid))
}
