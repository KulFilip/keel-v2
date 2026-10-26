package keel.api.skills

import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

data class NewSkill(val name: String = "", val kind: String = "knowledge", val stack: String = "any", val body: String = "")
data class SkillImport(val url: String? = null, val body: String? = null)
data class RepoSwitch(val on: Boolean = true)
data class SkillPatch(val agents: List<String>? = null, val `when`: String? = null, val body: String? = null, val enabled: Boolean? = null)

@RestController
@RequestMapping("/api")
class SkillController(private val skills: SkillService) {

    @GetMapping("/projects/{pid}/skills")
    fun list(@PathVariable pid: String): List<Skill> = skills.list(pid)

    @GetMapping("/skills/{sid}")
    fun get(@PathVariable sid: String, @RequestParam(required = false) project: String?): SkillDetail = skills.detail(sid, project)

    @PostMapping("/projects/{pid}/skills")
    fun create(@PathVariable pid: String, @RequestBody body: NewSkill): Skill =
        skills.create(pid, body.name, body.kind, body.stack, body.body)

    @PostMapping("/projects/{pid}/skills/import")
    fun import(@PathVariable pid: String, @RequestBody body: SkillImport): Skill = skills.importSkill(pid, body.url, body.body)

    @PutMapping("/projects/{pid}/skills/{sid}")
    fun update(@PathVariable pid: String, @PathVariable sid: String, @RequestBody body: SkillPatch): Skill =
        skills.update(pid, sid, body.agents, body.`when`, body.body, body.enabled)

    /** keel 0.18.57 Skills › Found in the repo: the repo's own instructions and skills (found at init and at a knowledge refresh). */
    @GetMapping("/projects/{pid}/skills/repo")
    fun repo(@PathVariable pid: String): RepoSkills = skills.repoView(pid)

    /** Loads the repo's skills for their agents (on), or for none (off): the project's setting repo_skills. */
    @PutMapping("/projects/{pid}/skills/repo")
    fun repoSwitch(@PathVariable pid: String, @RequestBody body: RepoSwitch): RepoSkills = skills.repoSwitch(pid, body.on)

    /** keel 0.18.6: remove one of the project's own skills (written here, imported, or from the marketplace). */
    @DeleteMapping("/projects/{pid}/skills/{sid}")
    fun delete(@PathVariable pid: String, @PathVariable sid: String): Map<String, Any> {
        skills.delete(pid, sid)
        return mapOf("removed" to sid)
    }
}
