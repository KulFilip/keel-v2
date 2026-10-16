"""Scenario (v0.17.4): the ludus-engine run that looped, replayed end to end on the fake model.

The real run: the spec's Plan said `**ORDER**: AC-006, AC-002, AC-007, AC-001, …`; keel ran AC-001 first; its test
author answered AMEND ("needs code from AC-006"); the amendment explorer answered "REOPEN: none — order issue"; the
approve-only gate committed nothing and sent AC-001 back to red, four times. Here: three criteria, the spec says
`**ORDER**: AC-3, AC-1, AC-2`, AC-1's test author answers AMEND while AC-3 is not done, and the explorer answers the
same as in the real run. Also the Java side of that run: a test class AC006… and Maven's -Dtest filter.
"""

import os
import re
import stat
from pathlib import Path

from conftest import decide, start, to_loop, wait
from test_flows_base import values
from test_flows_feature import by_step, spec_with
from keel_engine.models import fake as fake_mod
from keel_engine.tools import testcmd

THREE = [{"id": "AC-1", "layer": "API", "title": "Player ranks: the main case works"},
         {"id": "AC-2", "layer": "API", "title": "Player ranks: bad input is refused"},
         {"id": "AC-3", "layer": "API", "title": "Player ranks: the ranking table exists"}]
ORDER_ISSUE = "The spec already says this.\nREOPEN: none — execution-order issue, not a spec defect\nCONTRACT: no"
MAX_STEPS = 60          # agent calls for three criteria; the real run made 33 calls with 0 criteria done


def three_criteria(monkeypatch):
    real_default = fake_mod.default_acs
    monkeypatch.setattr(fake_mod, "default_acs", lambda title: [dict(a) for a in THREE])
    return real_default


def ludus(monkeypatch, explorer=ORDER_ISSUE, always=False):
    """The red agent answers AMEND for AC-1 while AC-3 is not done (always: every time); the amendment explorer
    answers `explorer` and writes nothing."""
    three_criteria(monkeypatch)
    calls, amends = [], []

    def red(req, real):
        calls.append(("red", req.ac["id"]))
        done = {a["id"] for a in req.acs if a.get("status") in ("done", "already-met", "green")}
        if req.ac["id"] == "AC-1" and (always or "AC-3" not in done):
            return None, "", "No seam to attach a compiling test.\nAMEND: AC-1 needs code from AC-3 (the ranking table)", {}
        return real(req)

    def amend(req, real):
        amends.append(req)
        return None, "", explorer, {}
    seen = by_step(monkeypatch, {"red": red, "spec amendment": amend})
    return seen, calls, amends


def run_to_end(client, tid, s, limit=40, payloads=None):
    """Approve every pause (with the payload given for a step) until the flow ends; returns (state, pauses)."""
    pauses = []
    for _ in range(limit):
        if s["status"] != "waiting":
            return s, pauses
        pauses.append(s["waiting"]["step"])
        s = decide(client, tid, payload=(payloads or {}).get(s["waiting"]["step"]))
    raise AssertionError(f"still waiting after {limit} pauses: {pauses[-10:]}")


def red_amend_red_cycles(calls: list[tuple[str, str]]) -> int:
    """How often the same criterion went red → (amendment) → red again."""
    reds = [ac for kind, ac in calls if kind == "red"]
    return max((reds.count(ac) - 1 for ac in set(reds)), default=0)


def test_the_spec_order_runs_ac3_first_and_nothing_loops(client, repo, monkeypatch):
    spec_with(monkeypatch, "**ORDER**: AC-3, AC-1, AC-2")
    seen, calls, amends = ludus(monkeypatch)
    tid = start(client, repo)
    s = to_loop(client, tid)
    assert s["ac"] == "AC-3" and [a["id"] for a in s["acs"]] == ["AC-3", "AC-1", "AC-2"]
    s, pauses = run_to_end(client, tid, s)
    assert s["status"] == "done", s
    assert [ac for kind, ac in calls] == ["AC-3", "AC-1", "AC-2"]          # built in ORDER, each once
    assert amends == [] and "amend_gate" not in pauses and "amend_loop" not in pauses
    assert len(seen) < MAX_STEPS


def test_without_the_order_line_keel_reorders_once_instead_of_looping(client, repo, monkeypatch):
    seen, calls, amends = ludus(monkeypatch)              # no ORDER in the spec: AC-1 comes first, as in the real run
    tid = start(client, repo)
    s = to_loop(client, tid)
    assert calls[0] == ("red", "AC-1") and s["ac"] == "AC-3"     # AC-1 went first, AMENDed; keel moved AC-3 before it
    s, pauses = run_to_end(client, tid, s)
    assert s["status"] == "done", s
    assert len(amends) == 1 and red_amend_red_cycles(calls) <= 1          # one amendment round, then AC-3 first
    assert [ac for kind, ac in calls] == ["AC-1", "AC-3", "AC-1", "AC-2"]
    assert "amend_gate" not in pauses                                     # no approve-only gate that commits nothing
    assert any("keel moved AC-3 before AC-1" in x for x in s["gate_log"])
    assert values(client, tid)["data"]["ac_order"]["from"] == "keel"
    assert len(seen) < MAX_STEPS


def test_when_keel_cannot_reorder_it_asks_with_four_choices(client, repo, monkeypatch):
    seen, calls, amends = ludus(monkeypatch, always=True)      # AC-1 says AMEND even after AC-3 is built
    tid = start(client, repo)
    s = to_loop(client, tid)
    for _ in range(12):
        if s["waiting"]["step"] == "amend_loop":
            break
        assert s["waiting"]["step"] != "amend_gate"
        s = decide(client, tid)
    w = s["waiting"]
    assert w["step"] == "amend_loop" and w["choices"] == ["first", "skip", "edit", "stop"]
    assert len(amends) == 1 and red_amend_red_cycles(calls) <= 1
    s = decide(client, tid, payload={"choice": "stop"}, why="split the spec")
    assert s["status"] == "stopped"
    assert len(seen) < MAX_STEPS


# ------------------------------------------------------------------ the Java side: AC006… and Maven's -Dtest

FAKE_MVN = r'''#!/usr/bin/env python3
"""A stand-in for `mvn -q test -Dtest=<patterns>`: Surefire's matching (glob on the class's simple name) and messages."""
import fnmatch, pathlib, sys
pats = [p for a in sys.argv if a.startswith("-Dtest=") for p in a[len("-Dtest="):].strip("'\"").split(",") if p]
classes = [f.stem for f in pathlib.Path("src/test/java").rglob("*.java")]
ran = [c for c in classes if any(fnmatch.fnmatchcase(c, p) for p in pats)] if pats else classes
if not ran:
    print('[ERROR] Failed to execute goal org.apache.maven.plugins:maven-surefire-plugin:3.2.5:test (default-test) on project '
          'ranks: No tests matching pattern "%s" were executed! (Set -Dsurefire.failIfNoSpecifiedTests=false to ignore this '
          'error.)' % ",".join(pats))
    sys.exit(1)
for c in ran:
    print("[INFO] Running demo." + c)
    print("[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0 <<< FAILURE! -- in demo." + c)
    print("[ERROR] demo.%s.topScoreRanksFirst -- org.opentest4j.AssertionFailedError: expected: <1> but was: <2>" % c)
sys.exit(1)
'''


def maven_project(tmp_path, monkeypatch, command: str) -> Path:
    root = tmp_path / "ranks"
    (root / "src/test/java/demo").mkdir(parents=True)
    (root / ".keel").mkdir()
    (root / "pom.xml").write_text("<project/>")
    (root / "src/test/java/demo/AC006PluginSubstrateRegressionTest.java").write_text("class AC006PluginSubstrateRegressionTest {}")
    (root / ".keel/config.yml").write_text(f"layout: repo\ncommands:\n  api_test_ac: \"{command}\"\n")
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    (bin_ / "mvn").write_text(FAKE_MVN)
    (bin_ / "mvn").chmod((bin_ / "mvn").stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{bin_}{os.pathsep}{os.environ['PATH']}")
    return root


def test_the_ac006_test_class_is_found_by_the_filter(tmp_path, monkeypatch):
    root = maven_project(tmp_path, monkeypatch, "mvn -q test -Dtest=*{AC}*")       # the real project's command
    cmd, rel = testcmd.located(str(root), "AC-006")
    assert cmd == "mvn -q test -Dtest=*AC-006*,*AC006*"
    code, out = testcmd.run(str(root), cmd)
    assert "Running demo.AC006PluginSubstrateRegressionTest" in out and not testcmd.ran_no_tests(out)
    # 0.17.3's filter (the dash kept) finds nothing, and keel now reads that as "no test ran", not a code failure
    code, out = testcmd.run(str(root), "mvn -q test -Dtest=*AC-006*")
    assert code == 1 and testcmd.ran_no_tests(out)


def test_ac_id_finds_it_too(tmp_path, monkeypatch):
    root = maven_project(tmp_path, monkeypatch, "mvn -q test -Dtest='*{AC_ID}*'")
    cmd, _ = testcmd.located(str(root), "AC-006")
    assert cmd == "mvn -q test -Dtest='*AC006*'"
    assert "Running demo.AC006PluginSubstrateRegressionTest" in testcmd.run(str(root), cmd)[1]


def test_surefire_no_tests_executed_is_no_test_ran():
    assert testcmd.ran_no_tests("[ERROR] No tests were executed!  (Set -DfailIfNoTests=false to ignore this error.)")
    assert not testcmd.ran_no_tests("[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0")


def test_verify_red_says_no_test_ran_for_the_dash_filter(tmp_path, monkeypatch):
    import asyncio

    from keel_engine.runtime.actions import ActionInput, verify_red

    root = maven_project(tmp_path, monkeypatch, "mvn -q test -Dtest=*AC-006*")         # a filter keel cannot widen
    a = ActionInput(root=str(root), phase="red", title="t", ac={"id": "AC-006", "layer": "API"}, acs=[], fake=False, flow="feature")
    r = asyncio.run(verify_red(a))
    assert not r.ok and r.note == "No test for AC-006 ran, so this is not a red state."
    root2 = maven_project(tmp_path / "two", monkeypatch, "mvn -q test -Dtest=*{AC}*")
    a2 = ActionInput(root=str(root2), phase="red", title="t", ac={"id": "AC-006", "layer": "API"}, acs=[{"id": "AC-006"}], fake=False, flow="feature")
    r2 = asyncio.run(verify_red(a2))
    assert r2.ok and "red confirmed" in r2.note, r2
    assert re.search(r"AC006PluginSubstrateRegressionTest", r2.detail)
