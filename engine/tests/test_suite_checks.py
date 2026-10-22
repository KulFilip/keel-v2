"""0.18.28 the suite outside each criterion, "already passes" reviewed, and a real way out of a failing integration.

The real run (a PHP/Symfony project): every criterion was green with its own --filter, AC-008's test committed a
carriers row in setUp and never deleted it, and the whole suite failed for the first time at integration. The
integration agent could not change tests ("Exit code 2 with no output; need details."), its gate offered approve
(= the same check again) or reject (= stop), and a send-back's reason reached nobody.
"""

import os
import stat
import subprocess
from pathlib import Path

from conftest import decide, start, wait
from test_flows_feature import by_step, to
from keel_engine import rules
from keel_engine.runtime import actions, suite_failure
from keel_engine.runtime.actions import ActionInput, ActionResult


def git(root, *args):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@localhost", *args], cwd=root,
                          capture_output=True, text=True, check=True).stdout


def repo_with(tmp_path, files: dict[str, str]) -> Path:
    root = tmp_path / "app"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    (root / "README.md").write_text("app\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "init")
    for rel, text in files.items():
        f = root / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text)
        if rel.endswith(".sh") or "/" not in rel and not rel.endswith((".yml", ".php", ".txt")):
            f.chmod(f.stat().st_mode | stat.S_IEXEC)
    rules.load_config.cache_clear() if hasattr(rules.load_config, "cache_clear") else None
    return root


POLLUTER = """<?php
final class ParcelPerformEtaConcurrentWebhooksTest extends KernelTestCase
{
    protected function setUp(): void
    {
        $this->second = DriverManager::getConnection($params);
        $this->second->executeStatement("INSERT INTO carrier_resolvers (code) VALUES ('pp')");
        $this->second->commit();
    }

    public function testAC008TwoWebhooksAtOnceKeepOneEta(): void { $this->assertSame(1, 1); }
}
"""
CLEAN = """<?php
final class TrackingTest extends KernelTestCase
{
    protected function setUp(): void { $this->em->persist(new Tracking()); $this->em->flush(); }
    protected function tearDown(): void { $this->em->getConnection()->rollBack(); }
    public function testAC002Saves(): void { $this->assertTrue(true); }
}
"""


# ------------------------------------------------------------------ suspects, alone, the output

def test_the_branchs_tests_that_write_to_the_db_without_cleanup_are_the_suspects(tmp_path):
    root = repo_with(tmp_path, {})
    base = git(root, "rev-parse", "HEAD").strip()
    git(root, "switch", "-qc", "feat/eta")
    for rel, text, msg in (("tests/Functional/TrackingTest.php", CLEAN, "test(AC-002): saves"),
                           ("tests/Functional/ParcelPerformEtaConcurrentWebhooksTest.php", POLLUTER, "test(AC-008): two webhooks")):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text)
        git(root, "add", "-A")
        git(root, "commit", "-qm", msg)
    found = suite_failure.suspects(str(root), base)
    assert [s["file"] for s in found] == ["tests/Functional/ParcelPerformEtaConcurrentWebhooksTest.php",
                                         "tests/Functional/TrackingTest.php"]
    first = found[0]
    assert first["acs"] == ["AC-008"] and first["commits"] and not first["cleanup"]
    assert "INSERT INTO carrier_resolvers" in first["writes"][0]
    assert found[1]["cleanup"]


PHPUNIT_OUT = """PHPUnit 10.5.0 by Sebastian Bergmann.

..EE.

There were 2 errors:

1) App\\Tests\\Unit\\CarrierResolverTest::testUniqueCode
Doctrine\\DBAL\\Exception\\UniqueConstraintViolationException: Duplicate entry 'pp' for key 'code'

2) App\\Tests\\Functional\\ResolverListTest::testNoExtraRow
Failed asserting that 3 matches expected 2.

ERRORS!
Tests: 5, Assertions: 4, Errors: 2.
"""


def test_the_failing_tests_and_their_report_are_read_from_phpunit():
    assert suite_failure.failing(PHPUNIT_OUT) == ["App\\Tests\\Unit\\CarrierResolverTest::testUniqueCode",
                                                 "App\\Tests\\Functional\\ResolverListTest::testNoExtraRow"]
    ex = suite_failure.excerpt(PHPUNIT_OUT)
    assert ex.startswith("There were 2 errors:") and "Duplicate entry 'pp'" in ex


FAKE_PHPUNIT = """#!/bin/sh
# a phpunit that prints nothing (as the real run's composer script did) and writes its JUnit report when asked
for a in "$@"; do
  if [ "$prev" = "--log-junit" ]; then
    printf '%s' '<testsuites><testsuite><testcase class="App\\Tests\\Unit\\CarrierResolverTest" name="testUniqueCode"><error message="Duplicate entry pp for key code"/></testcase><testcase class="A" name="ok"/></testsuite></testsuites>' > "$a"
  fi
  prev="$a"
done
case "$*" in *testUniqueCode*|*testNoExtraRow*) exit 0;; esac
exit 2
"""


async def test_a_suite_that_prints_nothing_runs_again_with_a_junit_report(tmp_path):
    root = repo_with(tmp_path, {"phpunit": FAKE_PHPUNIT, ".keel/config.yml": "commands:\n  api_test_module: ./phpunit\n"})
    a = ActionInput(root=str(root), phase="integration", title="t", ac=None, acs=[], fake=False, flow="feature")
    detail = await actions.failure_detail(a, "./phpunit", 2, "")
    assert "The command exited 2 and printed nothing (for phpunit, exit 2: an error or an exception" in detail
    assert "App\\Tests\\Unit\\CarrierResolverTest::testUniqueCode: Duplicate entry pp for key code" in detail
    assert "Exit code 2 with no output" not in detail


async def test_a_failing_test_that_passes_alone_is_pollution(tmp_path):
    root = repo_with(tmp_path, {"phpunit": FAKE_PHPUNIT, ".keel/config.yml":
                                "commands:\n  api_test_module: ./phpunit\n  api_test_ac: \"./phpunit --filter '{AC_ID}'\"\n"})
    found = suite_failure.analyse(str(root), None, PHPUNIT_OUT, dict(os.environ))
    assert found["pollution"] is True
    assert [x["command"] for x in found["alone"]] == ["./phpunit --filter 'testUniqueCode'", "./phpunit --filter 'testNoExtraRow'"]
    assert "passes alone, fails in the suite" in found["evidence"][0]


# ------------------------------------------------------------------ item 1: the tests outside a criterion

def test_after_green_runs_the_suite_every_n_criteria_and_at_the_lane_end(tmp_path):
    root = repo_with(tmp_path, {".keel/config.yml": "checks:\n  suite_every: 2\n"})
    acs = [{"id": f"AC-{n}", "layer": "API", "status": "done" if n < 2 else "todo"} for n in range(1, 5)]

    def plan(ac_id, acs=acs):
        a = ActionInput(root=str(root), phase="green", title="t", ac=next(x for x in acs if x["id"] == ac_id), acs=acs,
                        fake=False, flow="feature")
        return actions.after_green_plan(a)

    assert plan("AC-2")[0] == "suite"          # 2 of 4 done: every 2
    assert plan("AC-3", [dict(x, status="done") if x["id"] == "AC-2" else x for x in acs])[0] == "changed"
    last = [dict(x, status="done") for x in acs[:3]] + [acs[3]]
    assert plan("AC-4", last) == ("suite", "the last criterion of the api lane")
    (root / ".keel/config.yml").write_text("checks:\n  after_green: none\n")
    assert plan("AC-2")[0] == "none"


async def test_after_green_says_which_tests_the_criterion_broke_and_opens_its_test(tmp_path):
    suite = "#!/bin/sh\necho 'FAILED tests/test_old.py::test_unique_code - IntegrityError: duplicate'\nexit 1\n"
    root = repo_with(tmp_path, {"suite.sh": suite, ".keel/config.yml": "commands:\n  api_test_module: ./suite.sh\n"
                                "checks:\n  after_green: suite\n"})
    base = git(root, "rev-parse", "HEAD").strip()
    (root / "tests").mkdir()
    (root / "tests/test_ac8.py").write_text("def test_ac_8():\n    db.execute('INSERT INTO carriers VALUES (1)')\n    conn.commit()\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "test(AC-8): two webhooks")
    ac = {"id": "AC-8", "layer": "API", "status": "green"}
    a = ActionInput(root=str(root), phase="green", title="t", ac=ac, acs=[ac], fake=False, flow="feature", base=base)
    r = await actions.verify_after_green(a)
    assert not r.ok
    assert r.note == "AC-8's change broke tests outside it: tests/test_old.py::test_unique_code"
    assert "IntegrityError: duplicate" in r.detail
    assert r.update["unlocks"] == [{"path": "tests/test_ac8.py", "phase": "green", "by": "keel", "reason": "AC-8 broke tests outside it"}]
    assert r.update["data"]["after_green"]["AC-8"]["ok"] is False


def test_in_the_flow_a_broken_suite_after_green_goes_back_to_that_criterions_green(client, repo, monkeypatch):
    real = actions.run_action
    calls = {"n": 0}

    async def run_action(action, a):
        if action == "verify_after_green" and (a.ac or {}).get("id") == "AC-1" and calls["n"] == 0:
            calls["n"] += 1
            return ActionResult(False, "AC-1's change broke tests outside it: tests/test_old.py::test_rank",
                                "FAILED tests/test_old.py::test_rank", {"unlocks": [{"path": "tests/test_ac_1.py", "phase": "green"}]})
        return await real(action, a)
    monkeypatch.setattr("keel_engine.runtime.compiler.run_action", run_action)
    seen = by_step(monkeypatch, {})
    tid = start(client, repo)
    s = to(client, tid, wait(client, tid), "ac_gate")
    assert s["ac"] == "AC-1"
    started = [(e["step"], e["data"].get("ac")) for e in client.bus.of(tid, "step.started")]
    assert started.count(("green", "AC-1")) == 2 and started.count(("ac_suite", "AC-1")) == 2
    again = [r for r in seen if r.agent == "implementer" and r.feedback]
    assert again and "broke tests outside it: tests/test_old.py::test_rank" in again[0].feedback
    assert any(u["path"] == "tests/test_ac_1.py" and u["phase"] == "green" for u in s["unlocks"])
    assert "Outside this criterion" in s["waiting"]["detail"]


# ------------------------------------------------------------------ item 2: "already passes" is reviewed

def already_met_on(monkeypatch, ac_id="AC-1"):
    real = actions.run_action

    async def run_action(action, a):
        if action == "verify_red" and (a.ac or {}).get("id") == ac_id:
            return ActionResult(False, f"{ac_id} already passes.", "$ pytest\n1 passed", ask={
                "type": "already-met", "kind": "gate", "title": f"{ac_id} already passes", "detail": "it passed"})
        return await real(action, a)
    monkeypatch.setattr("keel_engine.runtime.compiler.run_action", run_action)


def test_already_passes_in_auto_mode_still_runs_the_ac_reviewer_on_the_test(client, repo, monkeypatch):
    already_met_on(monkeypatch)
    seen = by_step(monkeypatch, {})
    tid = start(client, repo, settings={"gates_mode": "every-ac", "cap_tokens": 0, "on_cap": "pause", "run_mode": "auto"})
    s = wait(client, tid)
    while s["status"] == "waiting" and s["waiting"]["step"] not in ("ship_final_review",):
        s = decide(client, tid)
    reviews = [r for r in seen if r.agent == "criterion-reviewer" and (r.ac or {}).get("id") == "AC-1"]
    assert len(reviews) == 1 and "isolation" in reviews[0].prompt and "cleanup" in reviews[0].prompt
    suites = [e for e in client.bus.of(tid, "step.started") if e["step"] == "ac_suite" and e["data"].get("ac") == "AC-1"]
    assert suites
    full = [r for r in seen if r.agent == "branch-reviewer"]
    assert full and "Not reviewed per AC" in full[0].prompt and "AC-1" in full[0].prompt
    assert "approved by the run mode; the criterion-reviewer read its test" in full[0].prompt
    assert next(a for a in s["acs"] if a["id"] == "AC-1")["status"] == "already-met"


def test_already_passes_approved_by_a_person_is_listed_for_the_full_diff_review(client, repo, monkeypatch):
    already_met_on(monkeypatch)
    seen = by_step(monkeypatch, {})
    tid = start(client, repo)
    s = to(client, tid, wait(client, tid), "verify_red")
    assert s["waiting"]["title"] == "AC-1 already passes"
    s = decide(client, tid)
    assert s["waiting"]["step"] == "ac_gate" and s["ac"] == "AC-2"        # AC-1: no per-AC review, no second stop
    assert not [r for r in seen if r.agent == "criterion-reviewer" and (r.ac or {}).get("id") == "AC-1"]
    assert [e for e in client.bus.of(tid, "step.started") if e["step"] == "ac_suite" and e["data"].get("ac") == "AC-1"]
    s = to(client, tid, s, "ready_gate")
    full = [r for r in seen if r.agent == "branch-reviewer"]
    assert full and "AC-1" in full[-1].prompt and "approved by a person; no per-AC review" in full[-1].prompt


# ------------------------------------------------------------------ item 4: a real way out of a failing integration

FOUND = {"failing": ["App\\Tests\\Unit\\CarrierResolverTest::testUniqueCode"],
         "alone": [{"name": "App\\Tests\\Unit\\CarrierResolverTest::testUniqueCode", "command": "./phpunit --filter testUniqueCode",
                    "passed": True, "ran": True}],
         "pollution": True, "likely_ac": "AC-1", "layer": "API", "command": "./phpunit",
         "suspects": [{"file": "tests/test_ac_1.py", "acs": ["AC-1"], "writes": ["INSERT INTO carriers"], "commits": True,
                       "cleanup": False}],
         "evidence": ["passes alone, fails in the suite: App\\Tests\\Unit\\CarrierResolverTest::testUniqueCode",
                      "tests/test_ac_1.py (AC-1) writes to the database on its own committed connection and never cleans up"]}


def failing_integration(monkeypatch, times=1):
    real = actions.verify_green
    left = {"n": times}

    async def verify_green(a):
        if not a.ac and a.phase == "integration" and left["n"] > 0:
            left["n"] -= 1
            return ActionResult(False, "The api suite does not pass yet.", "$ ./phpunit\nexit 2\n" + PHPUNIT_OUT,
                                {"suite_failure": dict(FOUND)})
        return await real(a)
    monkeypatch.setattr(actions, "verify_green", verify_green)


def test_the_integration_gate_offers_real_choices_and_a_plain_send_back_reopens_the_likely_criterion(client, repo, monkeypatch):
    failing_integration(monkeypatch, times=2)          # the check runs again when the answer resumes it
    seen = by_step(monkeypatch, {})
    tid = start(client, repo)
    s = to(client, tid, wait(client, tid), "integration_commit")
    w = s["waiting"]
    assert w["title"] == "verify the suite + commit: the suite fails (likely AC-1's test)"
    assert w["choices"] == ["send_back_ac", "retry", "stop"]                 # no KeelBot part loaded here
    info = {c["name"]: c for c in w["choice_info"]}
    assert info["send_back_ac"]["default"] and info["send_back_ac"]["label"] == "Send back to AC-1"
    assert "its test files may change" in info["send_back_ac"]["description"]
    assert info["retry"]["description"] == "run the suite again (after you fixed it yourself)"
    assert w["plain"]["reject"]["choice"] == "send_back_ac"                  # never a silent stop
    assert "passes alone, fails in the suite" in w["detail"] and "Duplicate entry 'pp'" in w["detail"]
    s = decide(client, tid, "reject", why="the AC-1 test leaks a carriers row")
    assert s["status"] == "waiting" and s["waiting"]["step"] == "ac_gate" and s["ac"] == "AC-1"
    fixed = [r for r in seen if r.agent == "implementer" and (r.ac or {}).get("id") == "AC-1" and r.feedback]
    assert fixed and "the likely cause of the suite failure" in fixed[-1].feedback
    assert "From the person: the AC-1 test leaks a carriers row" in fixed[-1].feedback
    assert any(u["path"] == "tests/test_ac_1.py" and u["phase"] == "green" for u in s["unlocks"])
    s = to(client, tid, s, "integration_gate")                               # the suite passes now
    assert any(x.startswith("suite integration_commit send_back_ac") for x in s["gate_log"])


def test_retry_checks_again_and_stop_stops_with_the_reason(client, repo, monkeypatch):
    failing_integration(monkeypatch, times=3)
    tid = start(client, repo)
    s = to(client, tid, wait(client, tid), "integration_commit")
    s = decide(client, tid, payload={"choice": "retry"})
    assert s["waiting"]["step"] == "integration_commit"                    # failed once more
    s = decide(client, tid, payload={"choice": "retry"})
    assert s["waiting"]["step"] == "integration_gate"
    failing_integration(monkeypatch, times=2)
    tid = start(client, repo, title="again")
    s = to(client, tid, wait(client, tid), "integration_commit")
    s = decide(client, tid, payload={"choice": "stop"}, why="I fix the DB first")
    assert s["status"] == "stopped" and "I fix the DB first" in s["error"]
