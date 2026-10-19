"""keel 0.18.12 the small flows: quick (one agent, the tests, one look, a commit), implement (the code, then its tests;
pass → commit and done, fail → fix and run again) and small (a short plan, test-first per criterion, one review, one
look; no ship). All run on the fake model in a real git repo."""

from conftest import decide, start, wait
from test_flows_base import answers
from test_v02 import configure, log
from keel_engine.models import fake as fake_mod
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


PLAN_WITHOUT_AC_LINES = ("Plan:\n- add a visits count to the pet list response\n- show it on the pets page\n\n"
                         "Acceptance criteria:\n1. The pet list returns each pet's visit count.\n"
                         "2. The pets page shows the count next to the name.")


def test_small_takes_the_criteria_lines_of_the_request_when_the_plan_has_none(client, repo, monkeypatch):
    # 0.18.17 the plan gate said "no acceptance criteria yet" although the request listed them as AC lines
    answers(monkeypatch, {"explorer": lambda r: PLAN_WITHOUT_AC_LINES})
    request = ("Show the visits per pet.\nAC-1 [API] The pet list returns each pet's visit count\n"
               "AC-2 [WEB] The pets page shows the count next to the name")
    tid = start(client, repo, workflow="small", title="Show the visits per pet", request=request)
    s = wait(client, tid)
    assert s["waiting"]["step"] == "plan_gate" and "no acceptance criteria" not in s["waiting"]["title"], s["waiting"]
    assert [(a["id"], a["layer"]) for a in s["acs"]] == [("AC-1", "API"), ("AC-2", "WEB")] or \
        [a["id"] for a in s["acs"]] == ["AC-1", "AC-2"], s["acs"]
    assert s["acs"][0]["title"] == "The pet list returns each pet's visit count"


def test_small_plan_prompt_asks_for_the_ac_lines_keel_reads(client, repo, monkeypatch):
    seen = answers(monkeypatch, {"explorer": lambda r: PLAN_WITHOUT_AC_LINES})
    tid = start(client, repo, workflow="small", title="Show the visits per pet")
    s = wait(client, tid)
    assert "no acceptance criteria yet" in s["waiting"]["title"]          # no AC lines anywhere: nothing to approve
    plan = next(r for r in seen if r.agent == "explorer").prompt
    assert "numbered acceptance criteria" not in plan
    assert "- **AC-1** [API]" in plan and "[WEB]" in plan.split("a short plan")[-1]


def test_criteria_lines_with_a_colon_or_a_dash_after_the_id_are_read():
    from keel_engine.runtime import prompts
    text = "- **AC-1:** [API] The list returns visits\nAC-2 - [WEB] The page shows them\nAC-3 [API] Plain one"
    assert [(a["id"], a["layer"], a["title"]) for a in prompts.parse_acs(text)] == [
        ("AC-1", "API", "The list returns visits"), ("AC-2", "WEB", "The page shows them"), ("AC-3", "API", "Plain one")]


# ------------------------------------------------------------------ size triggers (keel v1 change: must triggers)

def test_quick_migration_asks_to_escalate(client, repo, monkeypatch):
    real = fake_mod._plan

    def plan(req):
        if req.agent == "implementer":
            return "db/migration/V9__visits.sql", "alter table pets add column visits int;\n", "Done.\nUNTESTABLE: a schema change", {}
        return real(req)
    monkeypatch.setattr(fake_mod, "_plan", plan)
    tid = start(client, repo, workflow="quick", title="Count the visits")
    s = wait(client, tid)
    assert s["waiting"]["step"] == "look", s
    assert "cannot be tested: a schema change" in s["waiting"]["detail"]
    s = decide(client, tid)
    assert s["waiting"]["title"] == "Escalate to a feature flow?" and "a migration was added or changed" in s["waiting"]["detail"], s
    assert "stop this quick flow" in s["waiting"]["detail"]
    s = decide(client, tid, "approve")
    assert s["status"] == "done" and [c["workflow"] for c in s["children"]] == ["feature"], s
    assert not any(x.startswith("feat") for x in log(repo))


def test_small_auth_path_asks_to_escalate(client, repo, monkeypatch):
    configure(repo, "change: {auth_paths: ['src/scores/**']}\n")
    answers(monkeypatch, {})
    tid = start(client, repo, workflow="small", title="Show the visits per pet")
    s = wait(client, tid)
    assert s["waiting"]["step"] == "plan_gate", s
    s = decide(client, tid)
    assert s["waiting"]["title"] == "Escalate to a feature flow?" and "auth or security code changed" in s["waiting"]["detail"], s
    # stay small with a reason: recorded per trigger, and the same trigger does not ask again
    s = decide(client, tid, "reject", why="a helper next to the auth code, not auth itself")
    assert s["waiting"]["step"] == "look", s
    assert "escalation-override [auth]: a helper next to the auth code, not auth itself" in s["gate_log"]


def test_quick_without_a_test_or_a_reason_warns_at_the_look(client, repo, monkeypatch):
    answers(monkeypatch, {})
    tid = start(client, repo, workflow="quick", title="Fix the owner page title")
    s = wait(client, tid)
    assert s["waiting"]["step"] == "look" and s["waiting"]["detail"].startswith("NO TEST: no test was added or changed"), s
    seen = answers(monkeypatch, {})
    s = decide(client, tid, "reject", why="add a test")
    assert "Test first" in seen[-1].prompt and "UNTESTABLE:" in seen[-1].prompt
