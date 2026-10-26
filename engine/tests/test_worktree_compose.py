"""0.18.57 a flow in a worktree and the project's docker compose stack (demo project "shop", service `app`).

In .keel/worktrees/<name>, `docker compose exec -T app` said "service app is not running" (the compose project there is
named after the worktree folder); the agent then ran `docker compose up --build` from the worktree, which started a
second copy of the stack per worktree, and those containers stayed running. An agent may not start containers from a
worktree, and what docker compose made there goes when the flow ends or its worktree is removed."""

import json
import subprocess
from pathlib import Path

import pytest

from conftest import start, wait
from keel_engine import hook, rules
from keel_engine.runtime import container, guard_ctx
from keel_engine.tools import worktrees
from keel_engine.tools.agent_tools import ToolBox
from keel_engine.workflows.model import from_dict


def git(root, *args):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=root, capture_output=True, text=True)


@pytest.fixture
def shop(tmp_path):
    root = tmp_path / "shop"
    root.mkdir()
    (root / "compose.yml").write_text("services:\n  app:\n    image: php:8.3-cli\n    volumes:\n      - ./:/var/www/html\n")
    git(root, "init", "-q", "-b", "main")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "chore: start")
    return root


def worktree(root: Path, name="flow-ranks-1a2b3c") -> Path:
    wt = root / ".keel" / "worktrees" / name
    wt.parent.mkdir(parents=True, exist_ok=True)
    r = git(root, "worktree", "add", "-q", "-b", f"feat/{name}", str(wt))
    assert r.returncode == 0, r.stderr
    return wt


@pytest.mark.parametrize("cmd,refused", [
    ("docker compose up --build", True),
    ("docker compose up -d app", True),
    ("docker-compose -f compose.yml up -d", True),
    ("docker compose -p shop up -d", True),
    ("cd apps && docker compose up", True),
    ("bash -c 'docker compose up -d'", True),
    ("docker compose create app", True),
    ("docker compose run app vendor/bin/phpunit", True),
    ("docker compose run --rm app vendor/bin/phpunit", False),
    ("docker compose exec -T app vendor/bin/phpunit", False),
    ("docker compose ps", False),
    ("docker compose logs app", False),
    ("echo docker compose up", False),
])
def test_starting_containers_is_refused_in_a_worktree_only(tmp_path, cmd, refused):
    wt = str(tmp_path / "shop" / ".keel" / "worktrees" / "flow-x")
    v = rules.check_bash("green", cmd, root=wt)
    assert v.ok is (not refused), (cmd, v.reason)
    if refused:
        assert "worktree" in v.reason and "project folder" in v.reason
    # the project folder itself is the person's: keel does not stop its agents from starting the stack there
    assert rules.check_bash("green", cmd, root=str(tmp_path / "shop")).ok


def test_the_guard_hook_refuses_compose_up_in_a_worktree(capsys, tmp_path, shop):
    wt = worktree(shop)
    raw = json.dumps({"tool_name": "Bash", "tool_input": {"command": "docker compose up --build -d"}, "cwd": str(wt)})
    ctx = guard_ctx.write_context(tmp_path / "ctx" / "guard.json", root=str(wt), phase="green", ac=None, lane=None,
                                  unlocks=[], agent="implementer", thread="t1")
    assert hook.pre_tool(raw, ctx) == 2
    assert "docker compose up" in capsys.readouterr().err
    ctx = guard_ctx.write_context(tmp_path / "ctx2" / "guard.json", root=str(shop), phase="green", ac=None, lane=None,
                                  unlocks=[], agent="implementer", thread="t1")
    assert hook.pre_tool(raw, ctx) == 0


def test_an_agents_run_command_refuses_compose_up_in_a_worktree(shop):
    wt = worktree(shop)
    out = ToolBox(str(wt), "green").run_command("docker compose up -d")
    assert "not allowed in a flow's worktree" in out


@pytest.fixture
def fake_docker(tmp_path, monkeypatch):
    """A `docker` on PATH that lists the containers in tmp/containers (id<TAB>project<TAB>working_dir) and logs calls."""
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    log = tmp_path / "docker.log"
    listing = tmp_path / "containers"
    listing.write_text("")
    log.write_text("")
    (bin_ / "docker").write_text(f"""#!/bin/sh
echo "$@" >> {log}
case "$1" in
  ps) cat {listing} ;;
  network) [ "$2" = ls ] && echo net-1 ;;
esac
exit 0
""")
    (bin_ / "docker").chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_}:{__import__('os').environ['PATH']}")
    return listing, log


def test_cleanup_removes_only_what_compose_made_in_the_worktree(shop, fake_docker):
    listing, log = fake_docker
    wt = worktree(shop)
    listing.write_text(f"c-wt\tflow-ranks-1a2b3c\t{wt}\nc-wt-db\tflow-ranks-1a2b3c\t{wt}/docker\nc-main\tshop\t{shop}\n")
    assert container.cleanup_worktree(str(wt)) == ["c-wt", "c-wt-db"]
    calls = log.read_text().splitlines()
    assert "rm -f -v c-wt c-wt-db" in calls
    assert not any("c-main" in c for c in calls)
    assert any(c.startswith("network rm net-1") for c in calls)
    # the project folder is never a worktree: nothing is removed there
    log.write_text("")
    assert container.cleanup_worktree(str(shop)) == []
    assert log.read_text() == ""


def test_removing_a_worktree_removes_its_containers(shop, fake_docker):
    listing, log = fake_docker
    wt = worktree(shop)
    listing.write_text(f"c-wt\tflow-ranks-1a2b3c\t{wt}\nc-main\tshop\t{shop}\n")
    worktrees.remove(str(shop), str(wt))
    assert "rm -f -v c-wt" in log.read_text().splitlines()


ONE_STEP = {"name": "hello", "keel_rules": False, "steps": [
    {"id": "hello", "kind": "code", "name": "hello", "action": "run:true", "phase": "none"}]}
REAL = {"gates_mode": "every-ac", "cap_tokens": 0, "on_cap": "pause", "simulate_checks": False}


def test_a_flow_that_ends_in_a_worktree_removes_the_containers_made_there(client, shop, fake_docker):
    listing, log = fake_docker
    wt = worktree(shop)
    listing.write_text(f"c-wt\tflow-ranks-1a2b3c\t{wt.resolve()}\nc-main\tshop\t{shop.resolve()}\n")
    tid = start(client, wt, workflow=from_dict(ONE_STEP), settings=REAL)
    assert wait(client, tid)["status"] == "done"
    calls = log.read_text().splitlines()
    assert "rm -f -v c-wt" in calls and not any("c-main" in c for c in calls)


def test_a_flow_in_the_project_folder_never_removes_containers(client, shop, fake_docker):
    listing, log = fake_docker
    listing.write_text(f"c-main\tshop\t{shop.resolve()}\n")
    tid = start(client, shop, workflow=from_dict(ONE_STEP), settings=REAL)
    assert wait(client, tid)["status"] == "done"
    assert not any(c.startswith("rm") for c in log.read_text().splitlines())
