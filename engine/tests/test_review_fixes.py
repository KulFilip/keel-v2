"""v0.17.4 review fixes: a test command that cannot start, the stall ladder, BLOCKED, failed-call usage, fewer stops,
resume after a turn limit."""

import asyncio

from conftest import decide, start, to_loop, wait
from keel_engine.runtime import actions as actions_mod
from keel_engine.runtime.actions import ActionInput, verify_green, verify_red
from test_flows_feature import by_step
from test_scenario_order_and_amend_loop import three_criteria


def missing_wrapper(tmp_path) -> ActionInput:
    root = tmp_path / "p"
    (root / ".keel").mkdir(parents=True)
    (root / ".keel/config.yml").write_text("layout: repo\ncommands:\n  api_test_ac: \"./mvnw -q test -Dtest='*{AC_ID}*'\"\n"
                                           "  api_test_module: \"./mvnw -q test\"\n")
    return ActionInput(root=str(root), phase="red", title="t", ac={"id": "AC-6", "layer": "API"}, acs=[{"id": "AC-6"}],
                       fake=False, flow="feature")


# ------------------------------------------------------------------ 2. a test command that cannot start

def test_verify_red_does_not_confirm_red_when_the_command_cannot_start(tmp_path):
    r = asyncio.run(verify_red(missing_wrapper(tmp_path)))
    assert not r.ok and "red confirmed" not in r.note and r.note == "The test command for AC-6 cannot run."
    assert r.ask["type"] == "cannot-run" and r.ask["choices"] == ["recheck", "skip", "stop"]
    assert "will not help" in r.ask["detail"] and "- skip: move AC-6 to the end" in r.ask["detail"]


def test_verify_green_asks_too_and_the_suite_has_no_skip(tmp_path):
    a = missing_wrapper(tmp_path)
    assert asyncio.run(verify_green(a)).ask["choices"] == ["recheck", "skip", "stop"]
    a.ac = None
    assert asyncio.run(verify_green(a)).ask["choices"] == ["recheck", "stop"]


def plain(monkeypatch) -> list:
    """Three criteria, every agent answers as the fake model does; returns the red calls as (\"red\", AC)."""
    three_criteria(monkeypatch)
    calls = []

    def red(req, real):
        calls.append(("red", req.ac["id"]))
        return real(req)
    by_step(monkeypatch, {"red": red})
    return calls


def cannot_start(monkeypatch, phase="red", times=99):
    """AC-1's check cannot start until left["n"] is 0 (the node re-runs its check when the answer comes back, so a
    command that still cannot start asks again, and one that was fixed just goes on)."""
    real = actions_mod.verify_red if phase == "red" else actions_mod.verify_green
    left = {"n": times}

    async def check(a):
        if (a.ac or {}).get("id") == "AC-1" and left["n"]:
            left["n"] -= 1
            return actions_mod.cannot_run(a, "./mvnw -q test", "zsh: no such file or directory: ./mvnw", phase)
        return await real(a)
    monkeypatch.setattr(actions_mod, "verify_red" if phase == "red" else "verify_green", check)
    return left


def test_cannot_start_asks_recheck_skip_stop_and_recheck_runs_the_check_again(client, repo, monkeypatch):
    calls = plain(monkeypatch)
    left = cannot_start(monkeypatch)
    tid = start(client, repo)
    s = to_loop(client, tid)
    w = s["waiting"]
    assert w["step"] == "verify_red" and w["choices"] == ["recheck", "skip", "stop"], w
    reds = len([c for c in calls if c == ("red", "AC-1")])
    s = decide(client, tid, payload={"choice": "recheck"})           # still broken: asks again, no agent call
    assert s["waiting"]["step"] == "verify_red" and s["waiting"]["choices"] == ["recheck", "skip", "stop"]
    assert any(x.startswith("cannot-run recheck") for x in s["gate_log"]), s["gate_log"]
    left["n"] = 0                                                     # the person fixed .keel/config.yml
    s = decide(client, tid, payload={"choice": "recheck"})
    assert len([c for c in calls if c == ("red", "AC-1")]) == reds        # no agent call: only the check again
    assert s["waiting"]["step"] == "ac_gate" and s["ac"] == "AC-1"           # red confirmed, green, on to its gate


def test_cannot_start_skip_moves_the_criterion_to_the_end(client, repo, monkeypatch):
    plain(monkeypatch)
    cannot_start(monkeypatch)
    tid = start(client, repo)
    s = to_loop(client, tid)
    s = decide(client, tid, payload={"choice": "skip"})
    assert [a["id"] for a in s["acs"]][-1] == "AC-1" and s["ac"] != "AC-1"


def test_cannot_start_stop_stops_and_is_never_auto_decided(client, repo, monkeypatch):
    three_criteria(monkeypatch)
    cannot_start(monkeypatch, phase="green")
    tid = start(client, repo, settings={"gates_mode": "every-ac", "cap_tokens": 0, "on_cap": "pause", "run_mode": "auto"})
    s = wait(client, tid)
    for _ in range(10):
        if s["status"] != "waiting" or s["waiting"]["step"] == "verify_green":
            break
        s = decide(client, tid)
    assert s["waiting"]["step"] == "verify_green" and s["waiting"]["choices"] == ["recheck", "skip", "stop"], s
    s = decide(client, tid, payload={"choice": "stop"}, why="fix the wrapper first")
    assert s["status"] == "stopped" and "fix the wrapper first" in s["error"]
