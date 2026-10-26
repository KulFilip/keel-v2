package keel.api

import com.fasterxml.jackson.databind.ObjectMapper
import com.sun.net.httpserver.HttpServer
import keel.api.common.KeelProperties
import keel.api.engine.EngineClient
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.net.InetAddress
import java.net.InetSocketAddress

/** Docker asks /api/health every 15 s, and each ask reached the engine through a new JDK HttpClient: one more
 *  "HttpClient-N-SelectorManager" thread each time (over 1200 in five hours on an idle keel). One client serves them all. */
class EngineHealthProbeTest {

    private fun selectorThreads(): Int =
        Thread.getAllStackTraces().keys.count { it.isAlive && it.name.matches(Regex("HttpClient-\\d+-SelectorManager")) }

    @Test
    fun `health checks reuse one http client`() {
        val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
        server.createContext("/health") { ex ->
            val body = """{"ok":true,"fake":false}""".toByteArray()
            ex.responseHeaders.add("Content-Type", "application/json")
            ex.sendResponseHeaders(200, body.size.toLong())
            ex.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            val client = EngineClient(KeelProperties(engineUrl = "http://127.0.0.1:${server.address.port}"), ObjectMapper())
            assertThat(client.health()?.get("ok")?.asBoolean()).isTrue()
            val before = selectorThreads()
            repeat(20) { assertThat(client.health()).isNotNull() }
            assertThat(selectorThreads() - before).isLessThanOrEqualTo(0)
        } finally {
            server.stop(0)
        }
    }
}
