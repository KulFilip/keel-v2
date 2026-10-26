"""0.18.57 a project whose PHP lives only in the docker compose service `app` (demo project "shop"): flow setup uses the
configured dependency command, a preflight checks the container before the first step, and a worktree flow is known
not to reach its tests when the container mounts only the project folder."""

import subprocess
from pathlib import Path

import pytest

from conftest import decide, start, wait
from keel_engine.runtime import container, stack_setup
from keel_engine.workflows.model import from_dict

COMPOSE_ONLY_ROOT = """services:
  app:
    image: php:8.3-cli
    working_dir: /var/www/html
    volumes:
      - ./:/var/www/html
      - vendor:/var/www/html/vendor
volumes:
  vendor: {}
"""

CONFIG = """version: 4
commands:
  api_test_module: docker compose exec -T app vendor/bin/phpunit
  api_test_ac: docker compose exec -T app vendor/bin/phpunit --filter '{AC}'
  deps_api: docker compose exec -T app composer install -n
"""


def git(root, *args):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=root, capture_output=True, text=True)


def shop(tmp_path, config=CONFIG, compose=COMPOSE_ONLY_ROOT):
    root = tmp_path / "shop"
    (root / ".keel").mkdir(parents=True)
    (root / ".keel" / "config.yml").write_text(config)
    (root / "compose.yml").write_text(compose)
    (root / "composer.json").write_text('{"name": "demo/shop"}\n')
    git(root, "init", "-q", "-b", "main")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "chore: start")
    (root / "vendor").mkdir()           # installed through the container's mount (git-ignored in a real project)
    return root


def test_exec_of_reads_the_container_part_of_a_command():
    ex = container.exec_of("docker compose -f compose.dev.yml exec -T -u www-data app php vendor/bin/phpunit --filter X")
    assert ex["service"] == "app" and ex["compose"] and ex["files"] == ["compose.dev.yml"]
    assert ex["prefix"] == "docker compose -f compose.dev.yml exec -T -u www-data app"
    assert ex["rest"][:2] == ["php", "vendor/bin/phpunit"]
    assert container.exec_of("docker exec -it shop-app-1 bin/phpunit")["service"] == "shop-app-1"
    assert container.exec_of("docker-compose run --rm app pytest")["service"] == "app"
    assert container.exec_of("vendor/bin/phpunit") is None
    assert container.exec_of("docker build .") is None


def test_the_preflight_is_configured_or_derived_from_the_test_runner(tmp_path):
    root = shop(tmp_path)
    checks = container.preflight_commands(str(root))
    assert checks == [("the container app (from commands.api_test_module)",
                       "docker compose exec -T app vendor/bin/phpunit --version", "")]
    (root / ".keel" / "config.yml").write_text(CONFIG + "  preflight: docker compose ps --status running app\n")
    assert container.preflight_commands(str(root)) == [("commands.preflight", "docker compose ps --status running app", "")]
    assert container._check_of(container.exec_of("docker compose exec app php vendor/bin/phpunit")) == \
        "docker compose exec app php vendor/bin/phpunit --version"
    assert container._check_of(container.exec_of("docker compose exec app sh -c 'make test'")) == "docker compose exec app true"


def test_a_container_that_mounts_only_the_project_folder_does_not_fit_a_worktree(tmp_path):
    root = shop(tmp_path)
    fit = container.worktree_fit(str(root))
    assert fit == {"ok": False, "service": "app", "file": "compose.yml",
                   "reason": "tests run in the container `app`, which sees only the project folder"}
    (root / "compose.yml").write_text(COMPOSE_ONLY_ROOT.replace("      - vendor:", "      - ./.keel/worktrees:/worktrees\n      - vendor:"))
    assert container.worktree_fit(str(root))["ok"] is True
    plain = tmp_path / "plain"
    plain.mkdir()
    assert container.worktree_fit(str(plain))["ok"] is True


PHP_STACK = """name: php-shop
lane: api
detect: {files: [composer.json]}
dependency_files: [composer.json]
commands: {api_test_module: vendor/bin/phpunit}
setup:
  each_worktree: ['composer install -n --no-progress']
"""


def _stack(root):
    d = root / ".keel" / "stacks"
    d.mkdir(parents=True, exist_ok=True)
    (d / "php.yml").write_text(PHP_STACK)


def test_worktree_setup_runs_the_configured_dependency_command_never_a_bare_install(tmp_path, monkeypatch):
    root = shop(tmp_path)
    _stack(root)
    (root / "vendor").rmdir()
    monkeypatch.setattr(stack_setup, "needs_approval", lambda d: False)
    jobs = stack_setup.worktree_jobs(str(root))
    assert jobs and all(j["commands"] == ["docker compose exec -T app composer install -n"] for j in jobs), jobs
    # no deps command, the tests in a container: nothing runs on keel's side
    (root / ".keel" / "config.yml").write_text(CONFIG.replace("  deps_api: docker compose exec -T app composer install -n\n", ""))
    assert stack_setup.worktree_jobs(str(root)) == []


ONE_STEP = {"name": "hello", "keel_rules": False, "steps": [
    {"id": "hello", "kind": "code", "name": "hello", "action": "run:true", "phase": "none"}]}
REAL = {"gates_mode": "every-ac", "cap_tokens": 0, "on_cap": "pause", "simulate_checks": False}


def test_a_failing_preflight_stops_at_a_plain_gate_and_retry_checks_again(client, tmp_path):
    root = shop(tmp_path, CONFIG + "  preflight: sh -c 'echo service app is not running >&2; exit 1'\n")
    tid = start(client, root, workflow=from_dict(ONE_STEP), settings=REAL)
    s = wait(client, tid)
    w = s["waiting"]
    assert w["step"] == "__preflight" and "The toolchain does not answer" in w["title"]
    assert w["choices"] == ["retry", "skip", "stop"]         # the project folder: no "run in the project folder"
    assert "What failed: commands.preflight" in w["detail"] and "service app is not running" in w["detail"]
    assert "start the container" in w["detail"]
    (root / ".keel" / "config.yml").write_text(CONFIG + "  preflight: 'true'\n")
    s = decide(client, tid, "approve", payload={"choice": "retry"})
    assert s["status"] == "done", s


def test_skip_preflight_goes_on(client, tmp_path):
    root = shop(tmp_path, CONFIG + "  preflight: 'false'\n")
    tid = start(client, root, workflow=from_dict(ONE_STEP), settings=REAL)
    assert wait(client, tid)["waiting"]["step"] == "__preflight"
    s = decide(client, tid, "approve", why="container is down, I only need the plan", payload={"choice": "skip"})
    assert s["status"] == "done", s


def test_the_start_check_endpoint(client, tmp_path):
    root = shop(tmp_path)
    r = client.get("/start-check", params={"root": str(root)})
    assert r.status_code == 200, r.text
    assert r.json()["worktree"]["ok"] is False and r.json()["base"] is None


def test_a_side_session_worktree_runs_nothing_when_the_commands_run_in_a_container(tmp_path, monkeypatch):
    root = shop(tmp_path)
    _stack(root)
    monkeypatch.setattr(stack_setup, "needs_approval", lambda d: False)
    assert stack_setup.prepare_in_background(str(root)) is None
