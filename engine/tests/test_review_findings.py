"""Blocking findings from a review step stop the flow: fix them (and review again) or go on with a reason."""
import subprocess

from conftest import decide, start, wait


def _reviewer_finds_once(monkeypatch, calls):
    from keel_engine.models import fake as fake_mod
    real = fake_mod._plan

    def plan(req):
        if req.agent == "security-auditor":
            calls.append(req.feedback)
            if len(calls) == 1:
                return None, "", ("## Review\n\n**Blocking**\n\n- `src/scores/ac_1.py:2` returns a constant, not the rank.\n\n"
                                  "**Non-blocking**\n- naming"), {}
            return None, "", "**Blocking:** none.\n\nLooks right now.", {}
        return real(req)
    monkeypatch.setattr(fake_mod, "_plan", plan)


def _to(client, tid, s, step):
    for _ in range(40):
        if s["status"] == "waiting" and s["waiting"]["step"] == step:
            return s
        assert s["status"] == "waiting", s
        s = decide(client, tid)
    raise AssertionError(f"never reached {step}")


def test_fix_them_runs_the_implementer_commits_and_reviews_again(client, repo, monkeypatch):
    calls = []
    _reviewer_finds_once(monkeypatch, calls)
    tid = start(client, repo)
    s = _to(client, tid, wait(client, tid), "security__fix")
    w = s["waiting"]
    assert w["title"] == "security auditor + dependency triager: 1 blocking finding(s)"
    assert "returns a constant, not the rank" in w["detail"] and "naming" not in w["detail"]
    assert w["labels"] == {"approve": "Fix them", "reject": "Go on anyway"}

    s = decide(client, tid, "approve")
    log = subprocess.run(["git", "log", "--format=%s"], cwd=repo, capture_output=True, text=True).stdout
    assert "fix(review): address security auditor + dependency triager findings" in log
    assert len(calls) == 2, "the review runs again after the fix"
    assert s["waiting"]["step"] != "security__fix"


def test_go_on_anyway_needs_a_reason_and_is_logged(client, repo, monkeypatch):
    calls = []
    _reviewer_finds_once(monkeypatch, calls)
    tid = start(client, repo)
    _to(client, tid, wait(client, tid), "security__fix")
    r = client.post(f"/threads/{tid}/resume", json={"decision": "reject"})
    assert r.status_code == 400
    s = decide(client, tid, "reject", why="known limitation, ticket 42")
    assert len(calls) == 1, "no second review when the findings are accepted"
    assert any("security auditor + dependency triager findings accepted: known limitation" in x for x in s["gate_log"])
    assert s["waiting"]["step"] != "security__fix"


def test_a_review_after_the_fix_commit_reviews_the_new_head_not_its_old_answer(client, repo, monkeypatch):
    # 0.18.17 the review after a fix commit continued its old session ("use what you already know") and repeated
    # the findings word for word; a new HEAD gives the reviewer a fresh look.
    from keel_engine.models import fake as fake_mod
    real = fake_mod._plan
    prompts = []

    def plan(req):
        if req.agent == "security-auditor":
            prompts.append(req.prompt)
            if len(prompts) == 1:
                return None, "", "**Blocking**\n\n- `src/scores/ac_1.py:2` returns a constant, not the rank.", {}
            return None, "", "**Blocking:** none.", {}
        return real(req)
    monkeypatch.setattr(fake_mod, "_plan", plan)
    tid = start(client, repo)
    _to(client, tid, wait(client, tid), "security__fix")
    decide(client, tid, "approve")
    assert len(prompts) == 2
    assert "returns a constant" not in prompts[1].split("Fix these blocking findings")[0]
    assert "Your last try on this step" not in prompts[1] and "earlier conversation" not in prompts[1]
