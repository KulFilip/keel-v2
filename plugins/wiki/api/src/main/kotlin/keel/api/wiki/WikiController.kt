package keel.api.wiki

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/** The Wiki page's reads: its table of contents and one page (kb:<section>, spec:<path>, wf:<id>, runbook, adr:<file>). */
@RestController
@RequestMapping("/api/projects/{pid}/wiki")
class WikiController(private val wiki: WikiService) {

    @GetMapping
    fun wiki(@PathVariable pid: String): Wiki = wiki.wiki(pid)

    @GetMapping("/page")
    fun page(@PathVariable pid: String, @RequestParam id: String): WikiPage = wiki.page(pid, id)
}
