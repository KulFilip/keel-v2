"""A review comment on a TEST file ("a factory would fit here": move setUp()'s inline inserts into a helper) went into a
small flow with RED/GREEN. RED had no behaviour to test, so the test-author committed a test that read the target test's
source text with a regex. GREEN froze test files, so keel's guard put the implementer's edit to that test back three
rounds running (same agent, an investigator's proposal, a stronger model), then asked retry / skip / stop: none could work.

Here: refactor criteria have no RED test (the existing tests before and after are their proof), a RED test that reads
source code as text is sent back, the implementer is told up front which named files its phase freezes, and the guard
putting the same named file back twice (or the agent saying FROZEN:) opens a gate whose first answer allows the file.
"""

import asyncio
import subprocess
from pathlib import Path

from conftest import decide, start, wait
from test_flows_feature import by_step, text
from keel_engine import rules
from keel_engine.runtime import actions, prompts, test_scope
from keel_engine.runtime.actions import ActionInput, ActionResult

ROOT = Path(__file__).resolve().parents[2]


def git(root, *args):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@localhost", *args], cwd=root,
                          capture_output=True, text=True, check=True).stdout


def repo_with(tmp_path, files: dict[str, str]) -> Path:
    root = tmp_path / "shop"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    for rel, body in files.items():
        f = root / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(body)
        if rel.endswith(".sh"):
            f.chmod(0o755)
    (root / "README.md").write_text("shop\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "init")
    return root


# ------------------------------------------------------------------ what a change targets

def test_named_files_and_test_only():
    text = ("A reviewer wrote at tests/Integration/OrderHandlerTest.php:42: maybe a factory would fit here? "
            "See also OrderFactory.php and src/Orders/OrderHandler.php.")
    assert test_scope.named_files(text) == ["tests/Integration/OrderHandlerTest.php", "OrderFactory.php",
                                            "src/Orders/OrderHandler.php"]
    cfg = rules.make_config()
    assert test_scope.test_only(cfg, ["tests/Integration/OrderHandlerTest.php", "web/src/cart.test.ts"])
    assert not test_scope.test_only(cfg, ["tests/Integration/OrderHandlerTest.php", "src/Orders/OrderHandler.php"])
    assert not test_scope.test_only(cfg, [])


def test_refactor_criteria_are_marked():
    assert test_scope.is_refactor({"title": "[refactor] setUp() builds its orders through a private helper"})
    assert test_scope.is_refactor({"title": "Extract the order fixtures into a helper, no behaviour change"})
    assert test_scope.is_refactor({"title": "Rename OrderHandler::run to handle"})
    assert test_scope.is_refactor({"kind": "refactor", "title": "anything"})
    assert not test_scope.is_refactor({"title": "Extract the zip code and return it in the order response"})
    assert not test_scope.is_refactor({"title": "The order list shows each order's total"})
    acs = prompts.parse_acs("- **AC-1** [API] [refactor] setUp() uses a helper\n- **AC-2** [API] The list returns totals\n")
    assert acs[0]["kind"] == "refactor" and "kind" not in acs[1]


# ------------------------------------------------------------------ item 3: no source-inspecting tests

META_TEST = """<?php
final class OrderHandlerSetupTest extends TestCase
{
    public function testAC1SetUpUsesAHelper(): void
    {
        $source = file_get_contents((new \\ReflectionClass(OrderHandlerTest::class))->getFileName());
        $this->assertDoesNotMatchRegularExpression('/->insert\\(/', $source);
    }
}
"""
BEHAVIOUR_TEST = """<?php
final class OrderTotalTest extends TestCase
{
    public function testAC1TotalsTheLines(): void
    {
        $fixture = file_get_contents(__DIR__ . '/fixtures/order.json');
        $this->assertSame(30, (new OrderTotal())->of(json_decode($fixture, true)));
    }
}
"""


def test_a_red_test_that_reads_source_code_as_text_is_sent_back(tmp_path):
    root = repo_with(tmp_path, {"tests/Integration/OrderHandlerTest.php": "<?php // old\n"})
    (root / "tests/Integration/OrderHandlerSetupTest.php").write_text(META_TEST)
    hits = test_scope.source_reads(str(root), ["tests/Integration/OrderHandlerSetupTest.php"])
    assert [h["line"] for h in hits] == [6]
    ac = {"id": "AC-1", "layer": "API", "title": "setUp() builds its orders through a helper", "status": "todo"}
    a = ActionInput(root=str(root), phase="red", title="t", ac=ac, acs=[ac], fake=False, flow="small")
    r = asyncio.run(actions.verify_red(a))
    assert not r.ok
    assert "reads source code as text (tests/Integration/OrderHandlerSetupTest.php:6)" in r.note
    assert "A test must check behaviour" in r.detail and "file_get_contents" in r.detail


def test_a_fixture_read_is_not_a_source_read_and_a_lint_request_may_read_source(tmp_path):
    root = repo_with(tmp_path, {})
    (root / "tests").mkdir()
    (root / "tests/OrderTotalTest.php").write_text(BEHAVIOUR_TEST)
    assert test_scope.source_reads(str(root), ["tests/OrderTotalTest.php"]) == []
    assert test_scope.asks_for_source_check("Add an architecture test: no file under src/Domain may import Doctrine")
    assert not test_scope.asks_for_source_check("maybe a factory would fit here?")


def test_the_prompts_and_reviewers_forbid_source_inspecting_tests(tmp_path):
    ac = {"id": "AC-1", "layer": "API", "title": "The order list shows totals"}
    red = prompts.task_prompt(agent="test-author", phase="red", step_name="red", title="t", root=str(tmp_path), ac=ac,
                              acs=[ac], feedback=None)
    assert prompts.SOURCE_TEST_RULE in red and "never the source code's text" in red
    author = (ROOT / "content/agents/test-author.md").read_text()
    assert "Never test the source code's text" in author and "lint-like check" in author
    assert "changes no behaviour" in author
    assert "reads source code as text" in (ROOT / "content/agents/lens-reviewer.md").read_text()
    assert "reads the source code as text" in (ROOT / "content/agents/criterion-reviewer.md").read_text()


# ------------------------------------------------------------------ item 2: refactor criteria

def test_a_refactor_criterion_is_proved_by_the_existing_tests_before_and_after(tmp_path):
    root = repo_with(tmp_path, {"suite.sh": "#!/bin/sh\necho '12 passed'\n",
                                ".keel/config.yml": "commands:\n  api_test_module: ./suite.sh\n"})
    ac = {"id": "AC-1", "layer": "API", "title": "[refactor] setUp() builds its orders through a helper", "status": "todo"}
    a = ActionInput(root=str(root), phase="red", title="t", ac=ac, acs=[ac], fake=False, flow="small")
    r = asyncio.run(actions.verify_red(a))
    assert r.ok and r.note == "AC-1 is a refactor: no red test; the existing tests pass before the change."
    assert r.update["data"]["refactor_baseline"]["AC-1"]["ok"] is True
    g = asyncio.run(actions.verify_green(ActionInput(root=str(root), phase="green", title="t", ac=ac, acs=[ac], fake=False,
                                                     flow="small")))
    assert g.ok and g.note == "AC-1 (refactor): the existing tests pass after the change too."
    assert g.update["acs"][0]["status"] == "green"


def test_a_refactor_whose_tests_fail_before_the_change_asks(tmp_path):
    root = repo_with(tmp_path, {"suite.sh": "#!/bin/sh\necho 'FAILED tests/test_x.py::test_a'\nexit 1\n",
                                ".keel/config.yml": "commands:\n  api_test_module: ./suite.sh\n"})
    ac = {"id": "AC-1", "layer": "API", "title": "[refactor] rename the helper", "status": "todo"}
    r = asyncio.run(actions.verify_red(ActionInput(root=str(root), phase="red", title="t", ac=ac, acs=[ac], fake=False,
                                                   flow="small")))
    assert not r.ok and r.ask["type"] == "refactor-baseline" and r.ask["choices"] == ["recheck", "skip", "stop"]
    assert "cannot prove that nothing changed" in r.ask["detail"]


def test_the_green_prompt_of_a_refactor_says_its_proof(tmp_path):
    ac = {"id": "AC-1", "layer": "API", "title": "[refactor] setUp() uses a helper"}
    green = prompts.task_prompt(agent="implementer", phase="green", step_name="green", title="t", root=str(tmp_path),
                                ac=ac, acs=[ac], feedback=None)
    assert "AC-1 is a refactor: no behaviour changes" in green and "existing tests pass before the change" in green
    assert "makes the current criterion's test pass" not in green


PLAN = "Plan: one helper for the fixtures.\n- **AC-1** [API] [refactor] tests/test_scores.py builds its fixtures through one helper\n"


def test_in_a_small_flow_a_refactor_criterion_skips_the_red_agent(client, repo, monkeypatch):
    seen = by_step(monkeypatch, {"a short plan": text(PLAN)})
    tid = start(client, repo, workflow="small", title="Use a helper for the fixtures")
    s = wait(client, tid)
    assert s["waiting"]["step"] == "plan_gate" and s["acs"][0]["kind"] == "refactor", s
    s = decide(client, tid)
    assert not [r for r in seen if r.agent == "test-author"]
    skipped = [e for e in client.bus.of(tid, "step.finished") if e["step"] == "red" and e["data"].get("skipped")]
    assert skipped and "AC-1 is a refactor: no new test" in skipped[0]["data"]["note"]
    impl = [r for r in seen if r.agent == "implementer" and r.phase == "green"]
    assert impl and "AC-1 is a refactor" in impl[0].prompt


# ------------------------------------------------------------------ item 4: the guard keeps putting a named file back

FROZEN_PLAN = "Plan: one helper.\n- **AC-1** [API] tests/test_scores.py builds its fixtures through one helper\n"


def guard_loop_flow(client, repo, monkeypatch, green):
    """A small flow whose AC-1 needs tests/test_scores.py changed: its check passes only once that file holds the helper."""
    real = actions.run_action

    async def run_action(action, a):
        if action == "verify_green" and (a.ac or {}).get("id") == "AC-1":
            if "def make_fixtures" not in (Path(a.root) / "tests/test_scores.py").read_text():
                return ActionResult(False, "AC-1 does not pass yet.", "FAILED tests/test_ac_1.py::test_helper")
        return await real(action, a)
    monkeypatch.setattr("keel_engine.runtime.compiler.run_action", run_action)
    seen = by_step(monkeypatch, {"a short plan": text(FROZEN_PLAN), "green": green})
    tid = start(client, repo, workflow="small", title="Use a helper for the fixtures")
    s = wait(client, tid)
    assert s["waiting"]["step"] == "plan_gate", s
    return tid, seen, decide(client, tid)


def edits_the_test(req, real):
    return "tests/test_scores.py", "def make_fixtures():\n    return []\n", "GREEN: the helper is in.", {}


def test_the_same_file_put_back_twice_asks_to_allow_it_and_allow_runs_the_round_again(client, repo, monkeypatch):
    tid, seen, s = guard_loop_flow(client, repo, monkeypatch, edits_the_test)
    w = s["waiting"]
    assert w["step"] == "verify_green", s
    assert w["title"] == "keel's rules block `tests/test_scores.py` in green"
    assert w["choices"] == ["allow", "skip", "stop"]
    info = {c["name"]: c for c in w["choice_info"]}
    assert info["allow"]["label"] == "Allow `tests/test_scores.py` in this phase (recommended)" and info["allow"]["default"]
    assert info["skip"]["label"] == "Skip this criterion" and info["stop"]["label"] == "Stop the flow"
    assert ("keel's rule for this phase blocks changes to `tests/test_scores.py` (test code is frozen while making tests "
            "pass); the change needs that file.") in w["detail"]
    greens = [r for r in seen if r.agent == "implementer" and r.phase == "green"]
    assert len(greens) == 2                                     # two rounds, no investigator and no stronger model
    assert not [r for r in seen if r.agent == "investigator"]
    assert "Heads-up: this criterion names `tests/test_scores.py`" in greens[0].prompt
    s = decide(client, tid, payload={"choice": "allow"})
    assert any(u["path"] == "tests/test_scores.py" and u["phase"] == "green" for u in s["unlocks"])
    greens = [r for r in seen if r.agent == "implementer" and r.phase == "green"]
    assert len(greens) == 3 and "The person allowed tests/test_scores.py in phase green" in greens[-1].feedback
    assert "def make_fixtures" in (repo / "tests/test_scores.py").read_text()
    assert s["waiting"]["step"] == "look", s                   # the green commit carries the allowed test file
    log = git(repo, "log", "--format=%s", "--name-only")
    assert "feat(AC-1): tests/test_scores.py builds its fixtures through one helper\n\ntests/test_scores.py" in log


def test_an_agent_that_says_frozen_gets_the_gate_after_one_round(client, repo, monkeypatch):
    said = lambda req, real: (None, "", "setUp() must change and it is frozen here.\nFROZEN: tests/test_scores.py", {})
    tid, seen, s = guard_loop_flow(client, repo, monkeypatch, said)
    assert s["waiting"]["step"] == "verify_green" and s["waiting"]["choices"][0] == "allow", s
    assert len([r for r in seen if r.agent == "implementer" and r.phase == "green"]) == 1
    s = decide(client, tid, "reject")                           # a plain reject is the way out: stop
    assert s["status"] == "stopped", s


def test_the_heads_up_names_only_frozen_files(tmp_path):
    root = repo_with(tmp_path, {"tests/Integration/OrderHandlerTest.php": "<?php\n", "src/Orders/OrderHandler.php": "<?php\n"})
    texts = ["setUp() of OrderHandlerTest.php builds its orders through a helper; src/Orders/OrderHandler.php stays"]
    frozen = test_scope.frozen_named(str(root), "green", texts, [])
    assert [f["path"] for f in frozen] == ["tests/Integration/OrderHandlerTest.php"]
    assert frozen[0]["why"] == "test code is frozen while making tests pass"
    assert test_scope.frozen_named(str(root), "green", texts, [{"path": "tests/Integration/OrderHandlerTest.php",
                                                                "phase": "green"}]) == []
    note = test_scope.frozen_note(frozen, "green")
    assert note.startswith("Heads-up: this criterion names `tests/Integration/OrderHandlerTest.php`, which keel's rules "
                           "freeze in phase green (test code is frozen while making tests pass).")
    assert "`FROZEN: <file>`" in note


def test_a_refused_read_does_not_count_as_a_frozen_file():
    from keel_engine.runtime import compiler_agent
    assert compiler_agent.READ_TOOLS.match("read_file") and compiler_agent.READ_TOOLS.match("Read")
    assert not compiler_agent.READ_TOOLS.match("write_file") and not compiler_agent.READ_TOOLS.match("Edit")


def test_production_code_frozen_in_red_is_never_offered_to_allow(tmp_path):
    root = repo_with(tmp_path, {"tests/Integration/OrderHandlerTest.php": "<?php\n", "src/Orders/OrderHandler.php": "<?php\n"})
    texts = ["OrderHandler.php returns the total; see tests/Integration/OrderHandlerTest.php"]
    assert test_scope.frozen_named(str(root), "red", texts, []) == []      # RED may change the test, never the code
    cfg = rules.load_config(str(root))
    assert not test_scope.unlockable("red", "src/Orders/OrderHandler.php", cfg)
    assert test_scope.unlockable("green", "tests/Integration/OrderHandlerTest.php", cfg)
