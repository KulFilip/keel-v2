package keel.api.notifications

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class NoticeTextTest {

    @Test
    fun `gate titles say what the person should do, with the project's name`() {
        fun t(kind: String = "gate", flow: String? = "feature", step: String, name: String? = null, phase: String? = null, ac: String? = null) =
            NoticeText.gateTitle("shop", kind, flow, step, name, phase, ac, name)
        assertThat(t(flow = "init", step = "hand_over", name = "hand over", phase = "setup")).isEqualTo("◆ shop is set up — check it")
        assertThat(t(step = "spec_gate", name = "spec approval", phase = "spec")).isEqualTo("◆ shop: approve the spec?")
        assertThat(t(kind = "clarify", step = "round_gate", name = "your answers", phase = "spec")).isEqualTo("◆ shop: your answers are needed")
        assertThat(t(step = "ac_gate", name = "AC gate", phase = "gate", ac = "AC-002")).isEqualTo("◆ shop: check AC-002")
        assertThat(t(step = "final_review", name = "final review", phase = "final-review")).isEqualTo("◆ shop: approve the final review?")
        assertThat(t(step = "look", name = "look at the change", phase = "gate")).isEqualTo("◆ shop: look at the change")
        // an older engine: only the step id
        assertThat(NoticeText.gateTitle("shop", "gate", null, "hand_over", null, null, null, "hand_over")).isEqualTo("◆ shop: hand over")
    }

    @Test
    fun `done and failed titles name the flow and a short reason`() {
        assertThat(NoticeText.doneTitle("Add CSV export")).isEqualTo("✓ Add CSV export is done")
        assertThat(NoticeText.failedTitle("Add CSV export", "ValueError: no tests found\nTraceback ...")).isEqualTo("✗ Add CSV export stopped: no tests found")
        assertThat(NoticeText.failedTitle(null, null)).isEqualTo("✗ The flow stopped")
    }

    @Test
    fun `lines never end in the middle of a word and too many become +N more`() {
        val long = "The order export writes every order of the shop as one CSV row with its customer and its total amount"
        assertThat(NoticeText.words(long, 40)).isEqualTo("The order export writes every order…")
        assertThat(NoticeText.clip(listOf("a", "b", "c", "d", "e"))).containsExactly("a", "b", "+3 more")
        assertThat(NoticeText.fromBody("## Result\n\n- **one** fact\n- `two` facts\n\n---\nthree\nfour"))
            .containsExactly("Result", "one fact", "+3 more")
    }

    @Test
    fun `a snake_case id becomes words, paths stay as they are`() {
        assertThat(NoticeText.humanize("hand_over")).isEqualTo("hand over")
        assertThat(NoticeText.humanize("edit src/my_module.py")).isEqualTo("edit src/my_module.py")
    }
}
