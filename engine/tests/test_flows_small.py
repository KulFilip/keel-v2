"""keel 0.18.12 the small flows: quick (one agent, the tests, one look, a commit), implement (the code, then its tests;
pass → commit and done, fail → fix and run again) and small (a short plan, test-first per criterion, one review, one
look; no ship). All run on the fake model in a real git repo."""

from conftest import decide, start, wait
from test_flows_base import answers
from test_v02 import log
from keel_engine.runtime import actions as actions_mod


def fail_tests(monkeypatch, phase: str, times: int):
    """verify_green fails `times` times in `phase` (the tests do not pass yet), then runs for real."""
    real = actions_mod.verify_green
    left = {"n": times}

    async def verify_green(a):
        if a.phase == phase and left["n"]:
            left["n"] -= 1
            return actions_mod.ActionResult(False, "1 test fails: test_visits", "AssertionError: expected 2, got 0")
        return await real(a)
    monkeypatch.setattr(actions_mod, "verify_green", verify_green)


# ------------------------------------------------------------------ quick

def test_quick_is_one_agent_the_tests_one_look_and_one_commit(client, repo, monkeypatch):
    seen = answers(monkeypatch, {})
    tid = start(client, repo, workflow="quick", title="Fix the owner page title")
    s = wait(client, tid)
    assert s["waiting"]["step"] == "look" and s["status"] == "waiting"
    assert "approve" in s["waiting"]["options"] and "reject" in s["waiting"]["options"]
    s = decide(client, tid)
    assert s["status"] == "done", s
    assert [r.agent for r in seen] == ["implementer"]                 # no spec, no test author, no reviewer
    assert log(repo)[0] == "feat: Fix the owner page title"


def test_quick_sent_back_runs_the_agent_again_with_the_reason(client, repo, monkeypatch):
    seen = answers(monkeypatch, {})
    tid = start(client, repo, workflow="quick", title="Fix the owner page title")
    wait(client, tid)
    s = decide(client, tid, "reject", why="keep the old wording for pets")
    assert s["waiting"]["step"] == "look"
    assert [r.agent for r in seen] == ["implementer", "implementer"]
    assert "keep the old wording for pets" in seen[-1].prompt


def test_quick_tests_that_fail_go_back_to_the_agent_before_the_look(client, repo, monkeypatch):
    seen = answers(monkeypatch, {})
    fail_tests(monkeypatch, "ac", 1)
    tid = start(client, repo, workflow="quick", title="Fix the owner page title")
    s = wait(client, tid)
    assert s["waiting"]["step"] == "look"
    assert [r.agent for r in seen] == ["implementer", "implementer"]
    assert "1 test fails: test_visits" in seen[-1].prompt


# ------------------------------------------------------------------ implement

def test_implement_writes_the_code_then_its_tests_and_is_done_when_they_pass(client, repo, monkeypatch):
    seen = answers(monkeypatch, {})
    tid = start(client, repo, workflow="implement", title="Show the visits per pet")
    s = wait(client, tid)
    assert s["status"] == "done", s                                    # no gate: tests pass → done
    assert [r.agent for r in seen] == ["implementer", "test-author"]   # the code first, then the tests
    assert log(repo)[0] == "feat: Show the visits per pet"            # code and tests in one commit


def test_implement_fixes_what_fails_and_runs_the_tests_again(client, repo, monkeypatch):
    seen = answers(monkeypatch, {})
    fail_tests(monkeypatch, "ac", 1)
    tid = start(client, repo, workflow="implement", title="Show the visits per pet")
    s = wait(client, tid)
    assert s["status"] == "done", s
    agents = [r.agent for r in seen]
    assert agents == ["implementer", "test-author", "implementer"]    # the fix step, after the failing run
    assert "1 test fails: test_visits" in seen[-1].prompt


def test_implement_asks_when_the_tests_keep_failing(client, repo, monkeypatch):
    answers(monkeypatch, {})
    fail_tests(monkeypatch, "ac", 10)
    tid = start(client, repo, workflow="implement", title="Show the visits per pet")
    s = wait(client, tid)
    assert s["status"] == "waiting" and s["waiting"]["step"] == "verify", s   # 2 fix rounds, then keel asks


# ------------------------------------------------------------------ small

def test_small_plans_then_runs_test_first_per_criterion_one_review_and_one_look(client, repo, monkeypatch):
    seen = answers(monkeypatch, {})
    tid = start(client, repo, workflow="small", title="Show the visits per pet")
    s = wait(client, tid)
    assert s["waiting"]["step"] == "plan_gate" and s["acs"], s         # the plan's criteria are there to approve
    n = len(s["acs"])
    s = decide(client, tid)
    assert s["waiting"]["step"] == "look", s                           # no gate per criterion, no ship
    s = decide(client, tid)
    assert s["status"] == "done", s
    agents = [r.agent for r in seen]
    assert agents.count("test-author") == n and agents.count("implementer") == n and "code-reviewer" in agents
    commits = [c.split(":")[0] for c in log(repo)]
    assert "test(AC-1)" in commits and "feat(AC-1)" in commits
    assert not any(a in agents for a in ("e2e-author", "security-auditor", "librarian"))   # nothing of ship


def test_quick_runs_every_module_suite_not_only_the_backend(tmp_path):
    # 0.18.17 quick reached its look step with 2 failing frontend tests: its verify step ran only the api suite
    import asyncio
    import subprocess
    root = tmp_path / "p"
    (root / ".keel").mkdir(parents=True)
    (root / "web").mkdir()
    (root / ".keel/config.yml").write_text(
        "commands:\n  api_test_module: \"echo api 3 passed\"\n"
        "  web_test_module: \"echo '2 failed' && echo $PWD && false\"\nfrontend: {dir: web}\n")
    subprocess.run(["git", "init", "-q"], cwd=root)
    a = actions_mod.ActionInput(root=str(root), phase="ac", title="t", ac=None, acs=[], fake=False, flow="quick")
    r = asyncio.run(actions_mod.verify_green(a))
    assert not r.ok and "web" in r.note, r.note
    assert "2 failed" in r.detail and str(root / "web") in r.detail
    (root / ".keel/config.yml").write_text(
        "commands:\n  api_test_module: \"echo api 3 passed\"\n  web_test_module: \"echo web 2 passed\"\nfrontend: {dir: web}\n")
    r = asyncio.run(actions_mod.verify_green(a))
    assert r.ok and "api 3 passed" in r.detail and "web 2 passed" in r.detail, r.detail
