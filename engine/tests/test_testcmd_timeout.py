"""A test command that times out takes its children with it (gradle's JVM was left running)."""
import os
import time

from keel_engine.tools import testcmd


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def test_timeout_kills_the_children_too(tmp_path):
    pidfile = tmp_path / "child.pid"
    code, out = testcmd.run(str(tmp_path), f"sleep 30 & echo $! > {pidfile}; wait", timeout=1)
    assert code == 124 and "timed out" in out
    pid = int(pidfile.read_text())
    deadline = time.time() + 3
    while alive(pid) and time.time() < deadline:
        time.sleep(0.1)
    assert not alive(pid), "the child of the shell is still running"


def test_a_normal_run_returns_its_output(tmp_path):
    assert testcmd.run(str(tmp_path), "echo hi; echo err >&2; exit 3") == (3, "hi\nerr\n")
