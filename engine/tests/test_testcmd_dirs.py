"""v0.17.3 keel v1's rule: a test command from .keel/config.yml runs inside its part's folder (backend.dir /
frontend.dir), so a keel v1 project's "../mvnw -f .." works; a command that cannot start is said plainly."""

import asyncio
import os
import stat
import subprocess
from pathlib import Path

from keel_engine.runtime import ladder
from keel_engine.runtime.actions import ActionInput, verify_green
from keel_engine.tools import testcmd

CONFIG = """backend:
  dir: engine
frontend:
  dir: web
commands:
  api_test_ac: '../check.sh {AC}'
  api_test_module: '../check.sh all'
  web_test_ac: 'cat package.json > /dev/null && echo {AC} passed'
  api_compile: 'test -f ../pom.xml'
"""


def _project(tmp_path: Path, config: str = CONFIG) -> Path:
    root = tmp_path / "ludus"
    (root / ".keel").mkdir(parents=True)
    (root / ".keel" / "config.yml").write_text(config)
    (root / "engine").mkdir()
    (root / "web").mkdir()
    (root / "web" / "package.json").write_text("{}")
    (root / "pom.xml").write_text("<project/>")
    script = root / "check.sh"   # like mvnw: at the repo root, reached as ../ from backend.dir
    script.write_text('#!/bin/sh\necho "$1 passed"\n')
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    return root


def _green(root: Path, ac_id: str, layer: str = "API"):
    a = ActionInput(root=str(root), phase="green", title="t", ac={"id": ac_id, "layer": layer},
                    acs=[{"id": ac_id, "layer": layer, "status": "red"}], fake=False, flow="feature")
    return asyncio.run(verify_green(a))


def test_a_configured_command_runs_in_backend_dir(tmp_path):
    root = _project(tmp_path)
    assert testcmd.located(str(root), "AC-6") == ("../check.sh AC-6", "engine")
    assert testcmd.shown("../check.sh AC-6", "engine") == "cd engine && ../check.sh AC-6"
    res = _green(root, "AC-6")
    assert res.ok, res.note
    assert "cd engine && ../check.sh AC-6" in res.detail and "AC-6 passed" in res.detail


def test_a_web_command_runs_in_frontend_dir(tmp_path):
    root = _project(tmp_path)
    assert testcmd.located(str(root), "AC-2", "WEB")[1] == "web"
    assert _green(root, "AC-2", "WEB").ok


def test_a_detected_command_and_a_missing_folder_run_at_the_root(tmp_path):
    root = _project(tmp_path, CONFIG.replace("dir: engine", "dir: nowhere"))
    assert testcmd.located(str(root), "AC-1")[1] == ""          # backend.dir that does not exist: the root
    bare = tmp_path / "py"
    bare.mkdir()
    (bare / "pyproject.toml").write_text("[project]\nname='x'\n")
    assert testcmd.located(str(bare), "AC-1") == ("python -m pytest -q -k ac_1", "")


def test_a_command_that_cannot_start_says_so_instead_of_does_not_pass(tmp_path):
    root = _project(tmp_path, CONFIG.replace("'../check.sh {AC}'", "'../mvnw -q test -Dtest=*{AC}*'"))
    res = _green(root, "AC-6")
    assert not res.ok
    assert res.note == "The test command for AC-6 cannot run."
    assert "Retrying will not help" in res.detail and "backend.dir" in res.detail
    assert testcmd.cannot_run(127, "")
    assert testcmd.cannot_run(1, "/bin/sh: 1: ../mvnw: not found\n")
    assert not testcmd.cannot_run(1, "FAILED tests/test_x.py::AC-6 - AssertionError")


def test_the_ladder_runs_configured_commands_in_their_folder(tmp_path):
    root = _project(tmp_path)
    seen = {}

    def runner(cwd, cmd):
        seen[cmd] = os.path.relpath(cwd, root)
        p = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True)
        return p.returncode, p.stdout + p.stderr

    ok, rungs = ladder.run(str(root), False, runner)
    st = {r["n"]: r["status"] for r in rungs}
    assert seen["test -f ../pom.xml"] == "engine" and st[4] == "pass"   # api_compile, from backend.dir
    assert seen["../check.sh all"] == "engine" and st[6] == "pass"       # the unit-tests rung: api_test_module
