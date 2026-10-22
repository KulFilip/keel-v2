package keel.api.product

import keel.api.common.BadRequest
import keel.product.TicketKeys
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class TicketKeysTest {

    private fun keys(pattern: String, text: String) = TicketKeys.find(TicketKeys.regex(pattern), text)

    @Test
    fun `a team's pattern finds its keys in branch names and commit messages, in any case, with word edges`() {
        assertThat(keys("ERPDM-\\d+", "feature/erpdm-1234-vat")).containsExactly("ERPDM-1234")
        assertThat(keys("ERPDM-\\d+", "ERPDM-1234: add VAT (see ERPDM-12, ERPDM-1234)")).containsExactly("ERPDM-1234", "ERPDM-12")
        assertThat(keys("ERPDM-\\d+", "XERPDM-1 and ERPDM-12345x")).containsExactly("ERPDM-12345")
        assertThat(keys("SW-\\d+", "ERPDM-1234 only")).isEmpty()
        assertThat(keys("(SW|WEB)-\\d+", "web-7 then SW-8")).containsExactly("WEB-7", "SW-8")
        assertThat(keys("SW-\\d+", "SW-1 " + "x".repeat(3000) + " SW-2")).containsExactly("SW-1")
    }

    @Test
    fun `a pattern is checked before it is saved`() {
        assertThat(TicketKeys.check("  ERPDM-\\d+ ")).isEqualTo("ERPDM-\\d+")
        assertThat(TicketKeys.check(" ")).isNull()
        assertThat(TicketKeys.default("SW")).isEqualTo("SW-\\d+")
        for (bad in listOf("(ERPDM-\\d+)+", "(a*)*", "ERPDM-(\\d", ".*", "x".repeat(101))) {
            assertThatThrownBy { TicketKeys.check(bad) }.isInstanceOf(BadRequest::class.java)
        }
    }
}
