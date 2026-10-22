package keel.api.common

import org.springframework.http.client.JdkClientHttpRequestFactory
import org.springframework.web.client.RestClient
import java.net.http.HttpClient
import java.time.Duration

/** The JDK-HttpClient-backed [RestClient] builder the clients share (HTTP/1.1, timeouts); callers add base url and headers. */
object RestClients {
    /** [redirect] null keeps the JDK default (no redirects are followed); pass one to set it explicitly. */
    fun builder(connectTimeout: Duration, readTimeout: Duration, redirect: HttpClient.Redirect? = null): RestClient.Builder {
        val http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).connectTimeout(connectTimeout)
            .also { if (redirect != null) it.followRedirects(redirect) }.build()
        return RestClient.builder().requestFactory(JdkClientHttpRequestFactory(http).apply { setReadTimeout(readTimeout) })
    }
}
