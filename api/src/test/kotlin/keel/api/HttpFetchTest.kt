package keel.api

import com.sun.net.httpserver.HttpServer
import keel.api.common.BadRequest
import keel.api.common.FetchTexts
import keel.api.common.HttpFetch
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import java.net.InetAddress
import java.net.InetSocketAddress
import java.time.Duration

/** The one download helper (workflow and skill imports): no loopback, private or metadata addresses, also after a redirect. */
class HttpFetchTest {
    private val texts = FetchTexts(
        notHttp = { BadRequest("not http") }, failed = { BadRequest("failed: $it") },
        status = { BadRequest("status $it") }, tooBig = { BadRequest("too big") },
    )
    private val servers = mutableListOf<HttpServer>()

    private fun serve(path: String, status: Int = 200, body: String = "", location: String? = null, stall: Boolean = false): HttpServer {
        val s = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
        s.createContext(path) { ex ->
            if (location != null) ex.responseHeaders.add("Location", location)
            val bytes = body.toByteArray()
            ex.sendResponseHeaders(status, if (stall) 1000L else bytes.size.toLong().let { if (it == 0L) -1 else it })
            if (stall) { ex.responseBody.write("x".toByteArray()); ex.responseBody.flush(); Thread.sleep(5000) }
            else if (bytes.isNotEmpty()) ex.responseBody.write(bytes)
            ex.close()
        }
        s.start(); servers += s
        return s
    }
    private fun url(s: HttpServer, path: String) = "http://127.0.0.1:${s.address.port}$path"

    @AfterEach fun stop() { servers.forEach { it.stop(0) }; servers.clear() }

    @Test
    fun `a link to this computer is refused`() {
        val s = serve("/a", body = "name: x")
        assertThatThrownBy { HttpFetch.get(url(s, "/a"), 1000, texts) }.isInstanceOf(BadRequest::class.java).hasMessageContaining("private network")
        assertThatThrownBy { HttpFetch.get("http://localhost:${s.address.port}/a", 1000, texts) }.hasMessageContaining("private network")
        assertThatThrownBy { HttpFetch.get("http://[::1]:${s.address.port}/a", 1000, texts) }.hasMessageContaining("private network")
        assertThatThrownBy { HttpFetch.get("http://169.254.169.254/latest/meta-data", 1000, texts) }.hasMessageContaining("private network")
        assertThatThrownBy { HttpFetch.get("http://10.1.2.3/a", 1000, texts) }.hasMessageContaining("private network")
        assertThatThrownBy { HttpFetch.get("http://127.1/a", 1000, texts) }.isInstanceOf(BadRequest::class.java)   // not a host name Java accepts
        assertThatThrownBy { HttpFetch.get("file:///etc/passwd", 1000, texts) }.hasMessage("not http")
    }

    @Test
    fun `the address rules`() {
        fun b(ip: String) = HttpFetch.blocked(InetAddress.getByName(ip))
        assertThat(listOf("127.0.0.1", "10.0.0.1", "172.16.5.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1",
            "fd00::1", "fe80::1", "224.0.0.1", "::ffff:127.0.0.1")).allMatch { b(it) }
        assertThat(listOf("8.8.8.8", "93.184.216.34", "2606:4700:4700::1111")).noneMatch { b(it) }
    }

    @Test
    fun `a redirect to a private address is refused after the first hop`() {
        val s = serve("/r", status = 302, location = "http://169.254.169.254/latest/meta-data")
        assertThatThrownBy { HttpFetch.get(url(s, "/r"), 1000, texts, allowLoopback = true) }.hasMessageContaining("private network")
        val t = serve("/ok", body = "hello")
        assertThat(HttpFetch.get(url(t, "/ok"), 1000, texts, allowLoopback = true)).isEqualTo("hello")
        val loop = serve("/loop", status = 302, location = "/loop")
        assertThatThrownBy { HttpFetch.get(url(loop, "/loop"), 1000, texts, allowLoopback = true) }.hasMessageContaining("too many redirects")
    }

    @Test
    fun `a body over the cap, an error status and a stalled body are refused`() {
        val big = serve("/big", body = "x".repeat(50))
        assertThatThrownBy { HttpFetch.get(url(big, "/big"), 10, texts, allowLoopback = true) }.hasMessage("too big")
        val nf = serve("/nf", status = 404, body = "no")
        assertThatThrownBy { HttpFetch.get(url(nf, "/nf"), 10, texts, allowLoopback = true) }.hasMessage("status 404")
        val slow = serve("/slow", stall = true)
        val t0 = System.nanoTime()
        assertThatThrownBy { HttpFetch.get(url(slow, "/slow"), 100_000, texts, totalTimeout = Duration.ofSeconds(1), allowLoopback = true) }
            .hasMessageContaining("failed")
        assertThat(Duration.ofNanos(System.nanoTime() - t0)).isLessThan(Duration.ofSeconds(4))
    }
}
