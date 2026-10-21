package keel.api.tasks

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

/** A pull request link can come from an agent's note: the GitHub token goes only to the host it belongs to. */
class GitHubClientTest {
    private val mapper = jacksonObjectMapper()

    @Test
    fun `the token is not sent to a host that is not the one it belongs to`() {
        val evil = PrRef.parse("https://github.evil.com/acme/app/pull/7")!!
        assertThatThrownBy { GitHubClient("tok", mapper).reviews(evil) }
            .isInstanceOf(GitHubException::class.java).hasMessageContaining("only to github.com").hasMessageContaining("github.evil.com")
        assertThatThrownBy { GitHubClient("tok", mapper).requestReviewers(evil, listOf("ana")) }.isInstanceOf(GitHubException::class.java)
        // an Enterprise token belongs to the Enterprise host, not to github.com
        assertThatThrownBy { GitHubClient("tok", mapper, tokenHost = "ghe.test").reviews(PrRef.parse("https://github.com/acme/app/pull/7")!!) }
            .hasMessageContaining("only to ghe.test")
    }

    @Test
    fun `the host the token belongs to is allowed`() {
        // nothing listens there, so the call fails on the network, not on the host rule
        assertThatThrownBy { GitHubClient("tok", mapper, tokenHost = "ghe.invalid").reviews(PrRef.parse("https://ghe.invalid/acme/app/pull/7")!!) }
            .isInstanceOf(GitHubException::class.java).satisfies({ assertThat(it.message).doesNotContain("only to") })
    }
}
