"""keel 0.18.56 the address flow: "Address it" on a review thread, and any change to test code only. One agent changes
the code and its tests (phase ac: both writable), keel runs the tests (a failure goes back, 2 rounds, then keel asks),
one look at the diff, one commit. No test-first loop: a review comment on a test file has no behaviour for a RED test to
describe, and the guard's "tests are frozen in GREEN" kept putting the change back."""

import subprocess

from conftest import decide, start, wait
from test_flows_feature import by_step
from keel_engine import mcp_flows
from keel_engine.runtime import actions
from keel_engine.runtime.actions import ActionInput, ActionResult
from keel_engine.runtime import feature_actions
from keel_engine.workflows.templates import get_template

REQUEST = ("A reviewer wrote on pull request #12 (\"Order handler\"), branch feat/orders, at tests/test_scores.py:3.\n"
           "Make the change the thread asks for, and only that.\n<<<\nreviewer: maybe a factory would fit here?\n>>>")


def log(repo):
    return subprocess.run(["git", "log", "--format=%s", "--name-only"], cwd=repo, capture_output=True, text=True).stdout


def test_the_address_workflow_is_implement_then_test_with_one_look():
    t = get_template("address")
    assert [s.id for s in t.steps] == ["preflight", "change", "verify", "diff", "look", "commit", "close"]
    change = t.step("change")
    assert change.agent == "implementer" and change.phase == "ac"          # code and tests both writable
    assert "NO-BEHAVIOUR-CHANGE" in change.instructions and "reads source code as text" in change.instructions
    verify = t.step("verify")
    assert verify.action == "verify_green" and verify.back == "change" and verify.rounds == 2
    assert t.step("look").kind == "gate"
    assert not any(s.per_ac for s in t.steps) and not any(s.phase in ("red", "green") for s in t.steps)
    assert "address" in mcp_flows.ABOUT


def test_a_change_to_a_test_file_is_kept_tested_and_committed_as_a_test_change(client, repo, monkeypatch):
    def helper(req, real):
        return ("tests/test_scores.py", "def make_scores():\n    return [1, 2]\n\n\ndef test_scores():\n    assert make_scores()\n",
                "Moved the fixture into make_scores().\nNO-BEHAVIOUR-CHANGE: the fixture moved into a helper", {})
    seen = by_step(monkeypatch, {"make the change": helper})
    tid = start(client, repo, workflow="address", title="Address review: maybe a factory would fit here?", request=REQUEST)
    s = wait(client, tid)
    assert s["waiting"]["step"] == "look", s
    assert not [e for e in client.bus.of(tid, "guard.refused")]            # nothing was put back
    assert "def make_scores" in (repo / "tests/test_scores.py").read_text()
    assert [r.agent for r in seen if r.agent in ("test-author", "implementer")] == ["implementer"]
    s = decide(client, tid)
    assert s["status"] == "done", s
    assert log(repo).startswith("test: Address review: maybe a factory would fit here?\n\ntests/test_scores.py")


def test_failing_tests_go_back_to_the_agent_then_keel_asks(client, repo, monkeypatch):
    real = actions.run_action

    async def run_action(action, a):
        if action == "verify_green":
            return ActionResult(False, "the suite does not pass yet.", "FAILED tests/test_scores.py::test_scores")
        return await real(action, a)
    monkeypatch.setattr("keel_engine.runtime.compiler.run_action", run_action)
    seen = by_step(monkeypatch, {})
    tid = start(client, repo, workflow="address", title="Address review", request=REQUEST)
    s = wait(client, tid)
    assert s["waiting"]["step"] == "verify" and s["waiting"]["title"] == "run the tests keeps failing", s
    assert len([r for r in seen if r.agent == "implementer"]) == 3          # the change, then 2 fix rounds


def test_the_look_says_no_behaviour_changes_when_the_agent_says_so(tmp_path):
    root = tmp_path / "shop"
    root.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    (root / "src").mkdir()
    (root / "src/Orders.php").write_text("<?php\n")
    a = ActionInput(root=str(root), phase="ac", title="t", ac=None, acs=[], fake=False, flow="address",
                    state={"last_answer": "Renamed the helper.\nNO-BEHAVIOUR-CHANGE: renamed a private helper", "show": "DIFF"})
    r = feature_actions.test_check(a)
    assert r.note == "no test: no behaviour changes"
    assert r.update["show"].startswith("No test added or changed. The agent says no behaviour changes: renamed a private helper.")
