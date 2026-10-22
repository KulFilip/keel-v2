package keel.api.common

import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** The texts a caller shows when a download fails (each caller keeps its own wording). */
class FetchTexts(
    val notHttp: () -> BadRequest,
    val invalidUrl: () -> BadRequest = notHttp,
    val failed: (String?) -> BadRequest,
    val status: (Int) -> BadRequest,
    val tooBig: () -> BadRequest,
)

/**
 * The one way keel downloads a text file for a person-given link (a workflow, a skill). It only does http and https,
 * resolves the host and refuses this computer and private networks (loopback, link-local such as the cloud metadata
 * address 169.254.169.254, private, multicast), follows redirects itself and checks every hop the same way, caps the
 * size, and puts a time limit on the whole download (headers and body).
 */
object HttpFetch {
    /** A JVM property for tests that serve a file from 127.0.0.1; nothing sets it in keel (the rest of the rules stay on). */
    const val ALLOW_LOOPBACK_PROPERTY = "keel.test.fetch-allow-loopback"
    private const val MAX_HOPS = 5
    private val REDIRECTS = setOf(301, 302, 303, 307, 308)

    fun refusedAddress(): BadRequest = BadRequest("That link points to this computer or a private network",
        "Use a public http or https link.")

    /** True for an address a link may not point to. */
    fun blocked(a: InetAddress): Boolean {
        if (a.isAnyLocalAddress || a.isLoopbackAddress || a.isLinkLocalAddress || a.isSiteLocalAddress || a.isMulticastAddress) return true
        val b = a.address
        return when (a) {
            is Inet4Address -> (b[0].toInt() and 0xff == 100 && b[1].toInt() and 0xc0 == 64) ||   // 100.64.0.0/10 shared address space
                b[0].toInt() == 0                                                                  // 0.0.0.0/8
            is Inet6Address -> b[0].toInt() and 0xfe == 0xfc                                      // fc00::/7 unique local
            else -> false
        }
    }

    /**
     * Downloads [url] as text. [allowLoopback] is for tests only (a local server); every other rule stays.
     */
    fun get(
        url: String, maxBytes: Int, texts: FetchTexts,
        connectTimeout: Duration = Duration.ofSeconds(5), totalTimeout: Duration = Duration.ofSeconds(20),
        allowLoopback: Boolean = System.getProperty(ALLOW_LOOPBACK_PROPERTY) == "true",
    ): String {
        var uri = parse(url, texts)
        val deadline = System.nanoTime() + totalTimeout.toNanos()
        val client = HttpClient.newBuilder().connectTimeout(connectTimeout).followRedirects(HttpClient.Redirect.NEVER).build()
        for (hop in 0..MAX_HOPS) {
            checkHost(uri, allowLoopback)
            val left = Duration.ofNanos((deadline - System.nanoTime()).coerceAtLeast(1_000_000))
            val req = HttpRequest.newBuilder(uri).timeout(left).GET().build()
            val res = try {
                client.send(req, HttpResponse.BodyHandlers.ofInputStream())
            } catch (e: Exception) {
                throw texts.failed(e.message?.take(200))
            }
            val code = res.statusCode()
            if (code in REDIRECTS) {
                res.body().close()
                val next = res.headers().firstValue("Location").orElse(null) ?: throw texts.status(code)
                uri = parse(runCatching { uri.resolve(next).toString() }.getOrElse { throw texts.invalidUrl() }, texts)
                continue
            }
            if (code !in 200..299) { res.body().close(); throw texts.status(code) }
            val bytes = readWithin(res.body(), maxBytes + 1, Duration.ofNanos((deadline - System.nanoTime()).coerceAtLeast(1_000_000)), texts)
            if (bytes.size > maxBytes) throw texts.tooBig()
            return String(bytes, Charsets.UTF_8)
        }
        throw texts.failed("too many redirects")
    }

    private fun parse(url: String, texts: FetchTexts): URI {
        val uri = try { URI(url) } catch (e: Exception) { throw texts.invalidUrl() }
        if (uri.scheme?.lowercase() !in setOf("http", "https") || uri.host.isNullOrBlank()) throw texts.notHttp()
        return uri
    }

    private fun checkHost(uri: URI, allowLoopback: Boolean) {
        val addresses = try { InetAddress.getAllByName(uri.host) } catch (e: Exception) { throw BadRequest("Could not find that host", uri.host) }
        if (addresses.any { blocked(it) && !(allowLoopback && it.isLoopbackAddress) }) throw refusedAddress()
    }

    /** Reads at most [max] bytes and gives up when the body is slower than [within] (a server that stops sending). */
    private fun readWithin(input: java.io.InputStream, max: Int, within: Duration, texts: FetchTexts): ByteArray {
        val job = CompletableFuture.supplyAsync { input.use { it.readNBytes(max) } }
        return try {
            job.get(within.toMillis().coerceAtLeast(1), TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            runCatching { input.close() }; job.cancel(true)
            throw texts.failed("the server stopped sending")
        } catch (e: Exception) {
            runCatching { input.close() }
            throw texts.failed((e.cause ?: e).message?.take(200))
        }
    }
}
