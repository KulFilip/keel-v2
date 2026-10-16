"""v0.17.4 review fixes: a test command that cannot start, the stall ladder, BLOCKED, failed-call usage, fewer stops,
resume after a turn limit."""

import asyncio

from conftest import decide, start, to_loop, wait
from keel_engine.runtime import actions as actions_mod
from keel_engine.runtime.actions import ActionInput, verify_green, verify_red
from test_flows_feature import by_step
from test_flows_base import values
from test_scenario_order_and_amend_loop import run_to_end, three_criteria


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


# ------------------------------------------------------------------ 3. the stall ladder, BLOCKED, GREEN-RESULT: stalled

def green_fails(monkeypatch, left=99):
    """AC-1's green check fails `left` times with the same assertion."""
    real = actions_mod.verify_green
    box = {"n": left}

    async def check(a):
        if (a.ac or {}).get("id") == "AC-1" and box["n"]:
            box["n"] -= 1
            return actions_mod.ActionResult(False, "AC-1 does not pass yet.", "AssertionError: expected <1> but was <2>")
        return await real(a)
    monkeypatch.setattr(actions_mod, "verify_green", check)
    return box


def agents(seen, ac="AC-1"):
    return [r.agent for r in seen if (r.ac or {}).get("id") == ac]


def test_the_ladder_same_agent_then_investigator_then_a_stronger_model_then_real_choices(client, repo, monkeypatch):
    three_criteria(monkeypatch)
    seen = by_step(monkeypatch, {})
    green_fails(monkeypatch)
    tid = start(client, repo)
    s = to_loop(client, tid)
    w = s["waiting"]
    assert w["step"] == "verify_green" and w["choices"] == ["retry", "skip", "edit", "stop"], w
    assert "AC-1 is stuck at" in w["title"]
    mine = agents(seen)
    assert mine.count("implementer") == 4 and mine.count("investigator") == 1        # 1 try + 3 rounds; one investigator
    assert mine == ["test-author", "implementer", "implementer", "investigator", "implementer", "implementer"]
    log = [x for x in s["gate_log"] if x.startswith("stall AC-1")]
    assert [x.split(":")[0] for x in log] == ["stall AC-1 round 1", "stall AC-1 round 2", "stall AC-1 round 3"], log
    assert "investigator proposed" in log[1] and "implementer" in log[2]
    third = [r for r in seen if r.agent == "implementer" and (r.ac or {}).get("id") == "AC-1"][2]
    assert "An investigator read this failure" in (third.feedback or "")
    v = values(client, tid)
    assert v["data"]["ladder_escalated"]["agent"] == "implementer" and "implementer" in v["agent_models"]
    s = decide(client, tid, payload={"choice": "skip"}, why="later")
    assert s["ac"] == "AC-2" and [a["id"] for a in s["acs"]][-1] == "AC-1"
    assert any(x.startswith("AC-1: reset: put back") for x in s["gate_log"])        # its half-done code went back
    assert s["waiting"]["step"] == "ac_gate" and s["ac"] == "AC-2"                  # so AC-2's red commit is not refused
    v = values(client, tid)
    assert "ladder_escalated" not in v["data"]
    assert "implementer" not in (v.get("agent_models") or {})   # back for AC-2


def test_retry_with_a_note_is_one_more_round_then_the_choices_again(client, repo, monkeypatch):
    three_criteria(monkeypatch)
    seen = by_step(monkeypatch, {})
    green_fails(monkeypatch)
    tid = start(client, repo)
    s = to_loop(client, tid)
    before = agents(seen).count("implementer")
    s = decide(client, tid, payload={"choice": "retry"}, why="use the existing RankService")
    assert agents(seen).count("implementer") == before + 1 and agents(seen).count("investigator") == 1
    assert "From the user: use the existing RankService" in [r for r in seen if r.agent == "implementer"][-1].feedback
    assert s["waiting"]["step"] == "verify_green" and s["waiting"]["choices"][0] == "retry"
    s = decide(client, tid, payload={"choice": "stop"})
    assert s["status"] == "stopped"


def test_a_fix_that_works_after_the_investigator_goes_on(client, repo, monkeypatch):
    three_criteria(monkeypatch)
    seen = by_step(monkeypatch, {})
    green_fails(monkeypatch, left=2)
    tid = start(client, repo)
    s = to_loop(client, tid)
    assert s["waiting"]["step"] == "ac_gate" and s["ac"] == "AC-1"
    assert agents(seen).count("investigator") == 1 and agents(seen).count("implementer") == 3


def test_blocked_naming_a_criterion_builds_that_one_first(client, repo, monkeypatch):
    three_criteria(monkeypatch)
    calls = []

    def red(req, real):
        calls.append(req.ac["id"])
        done = {a["id"] for a in req.acs if a.get("status") in ("done", "green")}
        if req.ac["id"] == "AC-1" and "AC-3" not in done:
            return None, "", "I cannot write a compiling test.\nBLOCKED: needs AC-3: the ranking table does not exist", {}
        return real(req)
    by_step(monkeypatch, {"red": red})
    tid = start(client, repo)
    s = to_loop(client, tid)
    assert s["ac"] == "AC-3"
    assert any("keel moved AC-3 before AC-1" in x for x in s["gate_log"])
    s, _ = run_to_end(client, tid, s)
    assert s["status"] == "done" and calls == ["AC-1", "AC-3", "AC-1", "AC-2"]


def test_blocked_by_tooling_asks_instead_of_retrying(client, repo, monkeypatch):
    three_criteria(monkeypatch)
    calls = []

    def red(req, real):
        calls.append(req.ac["id"])
        return None, "", "The build does not start.\nBLOCKED: tooling: ./mvnw is missing", {}
    by_step(monkeypatch, {"red": red})
    tid = start(client, repo)
    s = to_loop(client, tid)
    w = s["waiting"]
    assert w["step"] == "red_stuck" and w["choices"] == ["retry", "skip", "edit", "stop"] and "./mvnw is missing" in w["detail"]
    assert calls == ["AC-1"]                                       # no retry of the same thing
    s = decide(client, tid, payload={"choice": "skip"})
    assert s["ac"] == "AC-2"


def test_green_result_stalled_counts_as_blocked(client, repo, monkeypatch):
    three_criteria(monkeypatch)
    by_step(monkeypatch, {"green": lambda req, real: (None, "", "Tried three designs, none compiles.\nGREEN-RESULT: stalled", {})})
    tid = start(client, repo)
    s = to_loop(client, tid)
    assert s["waiting"]["step"] == "green_stuck" and "none compiles" in s["waiting"]["detail"]
    s = decide(client, tid, payload={"choice": "edit"}, why="AC-1 needs a ranking table")
    amend = values(client, tid)["data"]["amend"]
    assert amend["ac"] == "AC-1" and "AC-1 needs a ranking table" in amend["reason"]
    assert any("stuck" in x or "blocked edit" in x for x in s["gate_log"]), s["gate_log"]


def test_markers_blocked():
    from keel_engine.runtime import markers

    assert markers.blocked("x\nBLOCKED: needs AC-3: the table") == "needs AC-3: the table"
    assert markers.blocked("tried\nfailed again\nGREEN-RESULT: stalled").startswith("stalled: tried failed again")
    assert markers.blocked("GREEN-RESULT: pass") is None and markers.blocked("") is None
