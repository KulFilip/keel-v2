package keel.api.review

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/**
 * keel 0.18.56 which flow "Address it" runs. A comment on a test file ("maybe a factory would fit here?") went into the
 * small flow: RED had no behaviour to test, and GREEN froze the very test file the comment was about.
 */
class ReviewAddressFlowTest {
    private val isTest = { p: String -> p.startsWith("tests/") || p.endsWith("Test.php") }
    private val all = { _: String -> true }

    @Test
    fun `a comment on a test file under a test-first default takes the address flow`() {
        assertThat(ReviewAddressService.chooseFlow(null, "small", "tests/Integration/OrderHandlerTest.php", isTest, all))
            .isEqualTo("address" to true)
        assertThat(ReviewAddressService.chooseFlow(null, "feature", "tests/Integration/OrderHandlerTest.php", isTest, all))
            .isEqualTo("address" to true)
    }

    @Test
    fun `a comment on production code keeps the configured flow`() {
        assertThat(ReviewAddressService.chooseFlow(null, "small", "src/Orders/OrderHandler.php", isTest, all)).isEqualTo("small" to false)
        assertThat(ReviewAddressService.chooseFlow(null, "small", null, isTest, all)).isEqualTo("small" to false)
    }

    @Test
    fun `the flow the person picked, a flow that is not test-first, or a project without address stay as they are`() {
        val path = "tests/Integration/OrderHandlerTest.php"
        assertThat(ReviewAddressService.chooseFlow("feature", "small", path, isTest, all)).isEqualTo("feature" to false)
        assertThat(ReviewAddressService.chooseFlow(null, "quick", path, isTest, all)).isEqualTo("quick" to false)
        assertThat(ReviewAddressService.chooseFlow(null, "small", path, isTest) { it != "address" }).isEqualTo("small" to false)
    }
}
