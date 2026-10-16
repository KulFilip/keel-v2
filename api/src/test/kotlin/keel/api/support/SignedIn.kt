package keel.api.support

import jakarta.servlet.Filter
import org.springframework.boot.test.autoconfigure.web.servlet.MockMvcBuilderCustomizer
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders
import org.springframework.test.web.servlet.setup.DefaultMockMvcBuilder
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.web.context.WebApplicationContext

/**
 * v0.18.1 keel's api proves every caller (auth/LocalAuth). The tests call it as keel's own engine does: every MockMvc
 * request carries the internal token unless the test sends its own credential header (a request's own header wins).
 * The sign-in tests use [bare] instead: the same app with no credential at all.
 */
@Configuration
class SignedIn {
    @Bean
    fun signedInMockMvc(): MockMvcBuilderCustomizer = MockMvcBuilderCustomizer { b ->
        b.defaultRequest(MockMvcRequestBuilders.get("/").header("X-Keel-Token", TOKEN))
    }

    companion object {
        const val TOKEN = "test-token"

        /** The app with its filters and no default credential: what a caller that never signed in gets. */
        fun bare(wac: WebApplicationContext, filters: List<Filter>): MockMvc =
            MockMvcBuilders.webAppContextSetup(wac).addFilters<DefaultMockMvcBuilder>(*filters.toTypedArray()).build()
    }
}
