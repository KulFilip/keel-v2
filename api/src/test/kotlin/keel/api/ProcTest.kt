package keel.api

import keel.api.common.Proc
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.nio.file.Files

class ProcTest {
    @Test
    fun `a command that times out is killed with the processes it started`() {
        val pidFile = Files.createTempFile("keel-pid", ".txt")
        val r = Proc.run(listOf("sh", "-c", "sleep 60 & echo \$! > $pidFile; sleep 60"), timeoutSec = 1)
        assertThat(r.timedOut).isTrue()
        val pid = Files.readString(pidFile).trim().toLong()
        var alive = true
        repeat(30) { if (alive) { alive = ProcessHandle.of(pid).map { it.isAlive }.orElse(false); if (alive) Thread.sleep(100) } }
        assertThat(alive).describedAs("the background sleep ($pid) is still running").isFalse()
        ProcessHandle.of(pid).ifPresent { it.destroyForcibly() }
    }
}
