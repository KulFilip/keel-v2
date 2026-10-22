package keel.api.ui

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/ui")
class UiFocusController(private val focus: UiFocusService) {
    @GetMapping("/focus")
    fun get(): UiFocus = focus.get()

    @PutMapping("/focus")
    fun set(@RequestBody body: UiFocusPatch): UiFocus = focus.set(body)
}
