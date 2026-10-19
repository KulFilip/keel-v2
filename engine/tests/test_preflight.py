"""Preflight parity with keel v1 `keel preflight` (feature_actions.preflight_warnings): the setup ladder, Docker when the
project needs it, and the commands the flow will need, as warnings (or a stop with preflight strict)."""

import json

from test_v02 import commit_all, git, write
from keel_engine.runtime import feature_actions
from keel_engine.runtime.actions import ActionInput


def project(tmp_path, config="version: 4\ncommands: {api_test_ac: 'true', static_checks: 'true'}\n"):
    root = tmp_path / "p"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    write(root, ".keel/config.yml", config)
    write(root, "notes.txt", "no stack detects this project\n")
    commit_all(root, "init")
    return root


def run(root, fake=True, **kw):
    a = ActionInput(root=str(root), project="p", phase="preflight", title="Player ranks", ac=None, acs=[], fake=fake,
                    flow="feature", step="preflight", **kw)
    return feature_actions.preflight(a)


def ladder(root, *statuses):
    write(root, ".keel/ladder.json", json.dumps({"rungs": [{"n": n + 1, "name": f"rung {n + 1}", "status": s}
                                                           for n, s in enumerate(statuses)]}))


def test_no_keel_config_no_warnings(tmp_path):
    root = tmp_path / "p"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    write(root, "a.py", "A = 1\n")
    commit_all(root, "init")
    r = run(root)
    assert r.ok and "warning" not in r.note


def test_the_setup_ladder_never_ran_or_did_not_pass(tmp_path):
    root = project(tmp_path)
    r = run(root)
    assert r.ok and "1 warning(s): the setup ladder never ran" in r.note
    assert r.update["data"]["warnings"] == [{"step": "preflight", "text": "preflight: " + r.update["data"]["preflight_warnings"][0]}]
    ladder(root, "pass", "skipped", "fail", "waiting")
    assert "the setup ladder did not pass: rung 3 (rung 3) is fail" in run(root).note
    ladder(root, "pass", "skipped")
    assert "warning" not in run(root).note


def test_missing_commands_for_what_the_flow_needs(tmp_path):
    root = project(tmp_path, "version: 4\ncontract: {file: docs/contract/openapi.yaml}\ncommands: {api_test_ac: 'true'}\n")
    write(root, "docs/contract/openapi.yaml", "openapi: 3.0.0\npaths: {}\n")
    ladder(root, "pass")
    write(root, "e2e/.keep", "")
    note = run(root).note
    assert "commands.codegen is empty" in note and "commands.e2e is empty" in note and "commands.static_checks is empty" in note
    (tmp_path / "x").mkdir()
    root2 = project(tmp_path / "x")
    ladder(root2, "pass")
    assert "commands.e2e is empty" in run(root2, data={"needs_e2e": True}).note
    assert "commands.e2e" not in run(root2).note


def test_docker_needed_but_down(tmp_path, monkeypatch):
    root = project(tmp_path)
    ladder(root, "pass")
    write(root, "compose.yml", "services: {}\n")
    monkeypatch.setattr(feature_actions.testcmd, "command_for", lambda *a, **k: "true")
    monkeypatch.setattr(feature_actions, "_docker_up", lambda root: False)
    assert "Docker is needed" in run(root, fake=False).note
    monkeypatch.setattr(feature_actions, "_docker_up", lambda root: True)
    assert "Docker" not in run(root, fake=False).note


def test_preflight_strict_stops_the_flow(tmp_path):
    root = project(tmp_path)
    r = run(root, settings={"preflight_strict": True})
    assert not r.ok and r.note == "Not ready: 1 preflight problem(s)." and "setup ladder never ran" in r.detail
