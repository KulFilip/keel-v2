"""0.18.57 the ship audit and keel's own commits (real use): "Mark as already met" and the green fix after it (its test
files opened by keel's unlock) were refused as "an implementation commit contains test files", "Approve fix" ran the
same audit on the same history again, and a local base branch behind origin made upstream commits look like the
branch's own."""

import asyncio
import subprocess
from pathlib import Path

import pytest

from conftest import decide, start, wait
from keel_engine.runtime import verdict_actions as va
from keel_engine.runtime.actions import ActionInput, commit, run_action
from keel_engine.workflows.model import from_dict


def git(root, *args):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=root, capture_output=True, text=True)


def write(root, rel, text="x\n"):
    f = Path(root) / rel
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(text)


def commit_all(root, *messages):
    git(root, "add", "-A")
    args = []
    for m in messages:
        args += ["-m", m]
    git(root, "commit", "-q", *args)


@pytest.fixture
def proj(tmp_path):
    root = tmp_path / "shop"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    write(root, "README.md")
    write(root, ".keel/config.yml", "version: 4\n")
    commit_all(root, "chore: start")
    git(root, "checkout", "-q", "-b", "feature/SHOPS-1234-euro-prices")
    return root


def ai(root, **kw):
    kw.setdefault("acs", [])
    return ActionInput(root=str(root), project="p1", phase="ship", title="Euro prices", ac=None, fake=False, flow="ship", **kw)


def audit(a):
    return asyncio.run(run_action("audit", a))


def test_the_audit_accepts_keels_own_already_met_and_unlocked_commits_and_still_refuses_others(proj):
    write(proj, "tests/test_price.py")
    commit_all(proj, "test(AC-1): prices in euros", "Keel-Path: already-met\nCo-Authored-By: KeelBot <keel.dev.bot@gmail.com>")
    write(proj, "src/price.py")
    write(proj, "tests/test_price.py", "fixed cleanup\n")
    commit_all(proj, "feat(AC-1): prices in euros", "Keel-Unlocked: tests/test_price.py")
    assert audit(ai(proj)).ok
    write(proj, "src/cart.py")
    write(proj, "tests/test_cart.py")
    commit_all(proj, "feat(AC-2): cart total")
    r = audit(ai(proj))
    assert not r.ok and "feat(AC-2): cart total: an implementation commit contains test files" in r.detail
    assert "AC-1" not in r.detail


def test_commit_marks_the_already_met_path_and_test_files_an_unlock_opened(proj):
    write(proj, "tests/test_price.py")
    r = commit(ActionInput(root=str(proj), phase="gate", title="Euro prices", ac={"id": "AC-1", "title": "prices in euros"},
                           acs=[{"id": "AC-1"}], fake=False, flow="feature", marker="already-met"))
    assert r.ok, r.note
    msg = git(proj, "log", "-1", "--format=%B").stdout
    assert msg.startswith("test(AC-1): prices in euros") and "Keel-Path: already-met" in msg
    write(proj, "src/price.py")
    write(proj, "tests/test_price.py", "with cleanup\n")
    unlocks = [{"path": "tests/test_price.py", "phase": "green", "by": "keel", "reason": "AC-1 broke tests outside it"}]
    r = commit(ActionInput(root=str(proj), phase="green", title="Euro prices", ac={"id": "AC-1", "title": "prices in euros"},
                           acs=[{"id": "AC-1"}], fake=False, flow="feature", unlocks=unlocks))
    assert r.ok, r.note
    msg = git(proj, "log", "-1", "--format=%B").stdout
    assert msg.startswith("feat(AC-1)") and "Keel-Unlocked: tests/test_price.py" in msg
    assert audit(ai(proj, unlocks=unlocks)).ok


AUDIT_ONLY = {"name": "ship-audit", "keel_rules": False, "steps": [
    {"id": "audit", "kind": "code", "name": "audit", "action": "audit", "phase": "ship", "lock": True}]}


def _bad_branch(root):
    write(root, "src/cart.py")
    write(root, "tests/test_cart.py")
    commit_all(root, "feat(AC-2): cart total")


def test_approve_at_the_audit_gate_changes_what_it_checks(client, proj):
    _bad_branch(proj)
    tid = start(client, proj, workflow=from_dict(AUDIT_ONLY), settings={"gates_mode": "every-ac", "cap_tokens": 0,
                                                                       "on_cap": "pause", "simulate_checks": False})
    s = wait(client, tid)
    w = s["waiting"]
    assert w["kind"] == "fix" and "1 problem(s)" in w["title"]
    assert w["labels"] == {"approve": "Accept these and go on", "reject": "Stop the flow"}
    assert "running the audit again finds them again" in w["detail"]
    s = decide(client, tid, "approve", why="written before keel, reviewed in the PR")
    assert s["status"] == "done", s
    from test_flows_base import values

    accepted = values(client, tid)["data"]["audit_accepted"]
    assert list(accepted.values()) == ["written before keel, reviewed in the PR"]


def test_stop_at_the_audit_gate_stops(client, proj):
    _bad_branch(proj)
    tid = start(client, proj, workflow=from_dict(AUDIT_ONLY), settings={"gates_mode": "every-ac", "cap_tokens": 0,
                                                                       "on_cap": "pause", "simulate_checks": False})
    wait(client, tid)
    s = decide(client, tid, "reject", why="I rebase it myself")
    assert s["status"] == "stopped"


# ------------------------------------------------------------------ a stale local base


@pytest.fixture
def cloned(tmp_path):
    """origin with main; a clone whose local main is one commit behind origin/main, and a branch from origin/main
    that holds the upstream commit (a merged PR with code and tests together) plus its own clean work."""
    origin = tmp_path / "origin"
    seed = tmp_path / "seed"
    seed.mkdir()
    git(seed, "init", "-q", "-b", "main")
    write(seed, "README.md")
    write(seed, ".keel/config.yml", "version: 4\nbase_branch: main\n")
    commit_all(seed, "chore: start")
    git(tmp_path, "clone", "-q", "--bare", str(seed), str(origin))
    work = tmp_path / "work"
    git(tmp_path, "clone", "-q", str(origin), str(work))
    # upstream: a PR merged on origin (code and tests in one commit, as the team does)
    write(seed, "src/merged.py")
    write(seed, "tests/test_merged.py")
    commit_all(seed, "feat(AC-7): merged upstream")
    git(seed, "push", "-q", str(origin), "main")
    git(work, "fetch", "-q", "origin")
    git(work, "checkout", "-q", "-b", "feature/SHOPS-1234-x", "origin/main")
    write(work, "tests/test_x.py")
    commit_all(work, "test(AC-1): x")
    return work


def test_the_base_is_the_remote_tracking_ref_and_upstream_commits_are_not_the_branchs(cloned):
    cfg = {"base_branch": "main"}
    assert va.base_ref(str(cloned), cfg) == "origin/main"
    assert va.base_drift(str(cloned), cfg) == "main is 1 behind origin/main — keel compares with origin/main"
    assert va.base_ref(str(cloned), {"base_branch": "refs/heads/main"}) == "refs/heads/main"   # explicit: kept
    r = audit(ai(cloned))
    assert r.ok, r.detail


def test_an_explicit_local_base_drops_upstream_commits_and_offers_the_remote_one(cloned, monkeypatch):
    write(cloned, ".keel/config.yml", "version: 4\nbase_branch: refs/heads/main\n")
    commit_all(cloned, "chore: config")
    assert audit(ai(cloned)).ok, "the commit merged upstream is reachable from origin/main: not audited"
    real = va.audit_problems
    monkeypatch.setattr(va, "audit_problems", lambda root, cfg, base, unlocks, upstream=None:
                        real(root, cfg, base, unlocks, upstream) + ([] if base == "origin/main" else ["abc1234 x: a problem"]))
    r = audit(ai(cloned))
    assert not r.ok and r.ask["choices"] == ["remote", "accept", "stop"]
    assert r.ask["choice_info"][0]["label"] == "Compare with origin/main instead (recommended)"
    assert "main is 1 behind origin/main" in r.ask["detail"]
    assert audit(ai(cloned, data={"audit_base": "origin/main"})).ok


def test_the_ship_menu_warns_about_a_stale_local_base(cloned):
    from keel_engine.runtime import ship

    assert ship.base_warning(str(cloned)) == "main is 1 behind origin/main — keel compares with origin/main"
