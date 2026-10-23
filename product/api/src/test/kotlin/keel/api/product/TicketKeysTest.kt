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
        assertThat(keys("SHOPS-\\d+", "feature/shops-1234-vat")).containsExactly("SHOPS-1234")
        assertThat(keys("SHOPS-\\d+", "SHOPS-1234: add VAT (see SHOPS-12, SHOPS-1234)")).containsExactly("SHOPS-1234", "SHOPS-12")
        assertThat(keys("SHOPS-\\d+", "XSHOPS-1 and SHOPS-12345x")).containsExactly("SHOPS-12345")
        assertThat(keys("SW-\\d+", "SHOPS-1234 only")).isEmpty()
        assertThat(keys("(SW|WEB)-\\d+", "web-7 then SW-8")).containsExactly("WEB-7", "SW-8")
        assertThat(keys("SW-\\d+", "SW-1 " + "x".repeat(3000) + " SW-2")).containsExactly("SW-1")
    }

    @Test
    fun `a pattern is checked before it is saved`() {
        assertThat(TicketKeys.check("  SHOPS-\\d+ ")).isEqualTo("SHOPS-\\d+")
        assertThat(TicketKeys.check(" ")).isNull()
        assertThat(TicketKeys.default("SW")).isEqualTo("SW-\\d+")
        for (bad in listOf("(SHOPS-\\d+)+", "(a*)*", "SHOPS-(\\d", ".*", "x".repeat(101))) {
            assertThatThrownBy { TicketKeys.check(bad) }.isInstanceOf(BadRequest::class.java)
        }
    }
}
