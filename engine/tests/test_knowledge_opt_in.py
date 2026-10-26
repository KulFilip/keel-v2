"""keel 0.18.57 the project notes (knowledge base) are opt-in.

A real-model evaluation of 0.18.55 found that agents given only the knowledge file paths opened them twice in 46 runs
and answered no better with them than without, while building them cost about $4.60 per project. So a new project's
init builds none, agents get no knowledge paths unless the notes exist and are on, ship's knowledge step is skipped
while they are off, and the knowledge-refresh flow (the Wiki's Build them) builds them on request and turns them on.
"""

import subprocess
from pathlib import Path

import pytest
import yaml

from conftest import decide, start, wait
from keel_engine.runtime import actions, agent_knowledge, init_gates, knowledge, prompts, rules_view, ship

ALL = ["architecture", "domain", "conventions", "data", "integrations"]


def kb(root: Path, *sections: str) -> None:
    d = root / "docs" / "knowledge"
    d.mkdir(parents=True, exist_ok=True)
    for s in sections:
        (d / f"{s}.md").write_text(f"# {s}\n\nIt starts in `app.py:1`.\n")


def config(root: Path, text: str) -> Path:
    f = root / ".keel" / "config.yml"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(text)
    return f


# ------------------------------------------------------------------ the switch

def test_a_new_project_has_the_notes_off_and_one_that_has_them_keeps_them(tmp_path):
    assert knowledge.enabled(str(tmp_path)) is False
    kb(tmp_path, "data")
    assert knowledge.enabled(str(tmp_path)) is True, "notes on disk and nothing said: they stay in use"
    config(tmp_path, "knowledge:\n  build: off\n")          # YAML 1.1 reads a bare off as false
    assert knowledge.build_setting(yaml.safe_load("knowledge:\n  build: off\n")) == "off"
    assert knowledge.enabled(str(tmp_path)) is False, "turned off: the notes on disk are not used"
    config(tmp_path, "knowledge:\n  build: 'on'\n")
    assert knowledge.enabled(str(tmp_path)) is True
    # an earlier init chose sections (none written yet): an existing project, the notes stay on
    other = tmp_path / "other"
    config(other, "init:\n  knowledge_sections: [data]\n")
    assert knowledge.enabled(str(other)) is True


def test_the_switch_is_written_only_into_its_own_block(tmp_path):
    assert knowledge.set_build(str(tmp_path), True) is False, "no config yet: nothing is created"
    f = config(tmp_path, "# mine\nversion: 4\ncommands:\n  unit_tests: make test\n")
    assert knowledge.set_build(str(tmp_path), False) is True
    assert knowledge.set_build(str(tmp_path), False) is False, "already off"
    text = f.read_text()
    assert text.startswith("# mine\nversion: 4\ncommands:\n  unit_tests: make test\n")
    assert yaml.safe_load(text)["knowledge"] == {"build": "off"}
    with pytest.raises(rules_view.RulesError):
        rules_view.set_config(str(tmp_path), {"knowledge": {"build": "sometimes"}})
    with pytest.raises(rules_view.RulesError):
        rules_view.set_config(str(tmp_path), {"knowledge": {"build": "on", "more": 1}})


# ------------------------------------------------------------------ init

def test_init_recommends_no_notes_for_a_new_project_and_offers_them_with_their_cost(tmp_path):
    root = str(tmp_path)
    assert init_gates.defaults(root)["write_sections"] == []
    qs = {q["id"]: q for q in init_gates.clarify_questions(root, cost="≈$3–7")}
    k = qs["knowledge"]
    assert not any(o["recommended"] for o in k["options"])
    first = k["options"][0]
    assert first["label"] == "Build project notes (≈$3–7, recommended for large repos)"
    assert "≈$3–7" in k["why"] and "Wiki" in k["why"]
    assert init_gates.from_answers(root, {"knowledge": [first["label"]]})["write_sections"] == ALL
    assert init_gates.from_answers(root, {"knowledge": ["data"]})["write_sections"] == ["data"]
    assert init_gates.answers(root, "3 build the notes")["knowledge_sections"] == ALL
    assert "[none: off, build them later from the Wiki]" in init_gates.questions(root, cost="≈$3–7")
    assert "Project notes stay off; build them later from the Wiki (≈$3–7)" in \
        init_gates.plan(root, {**init_gates.defaults(root), "notes_cost": "≈$3–7"})


def test_init_writes_the_switch_into_a_new_config(tmp_path):
    def write(root, **init):
        a = actions.ActionInput(root=str(root), phase="setup", title="init", ac=None, acs=[], fake=True, flow="init",
                                init={"runs_on": "this machine", "services": "none", **init})
        actions.write_config(a)
        return yaml.safe_load((root / ".keel" / "config.yml").read_text())

    off = write(tmp_path / "a", knowledge_sections=[], write_sections=[], notes_cost="≈$3–7")
    assert off["knowledge"] == {"build": "off"} and "notes_cost" not in off["init"]
    on = write(tmp_path / "b", knowledge_sections=["data"], write_sections=["data"])
    assert on["knowledge"] == {"build": "on"}


def test_a_default_init_runs_no_librarian_and_offers_the_notes_at_the_end(client, repo, monkeypatch):
    from keel_engine.models import fake as fake_mod

    real, got = fake_mod._plan, []

    def plan(req):
        if req.agent == "librarian":
            got.append(req.section)
        return real(req)
    monkeypatch.setattr(fake_mod, "_plan", plan)
    tid = start(client, repo, workflow="init", title="keel init")
    s = wait(client, tid)
    while s["status"] == "waiting" and s["waiting"]["step"] != "audit_now":
        s = decide(client, tid)
    w = s["waiting"]
    assert "notes" in w["choices"] and "**notes**: build the project notes now" in w["detail"]
    assert next(c for c in w["choice_info"] if c["name"] == "notes")["label"] == "Build project notes"
    s = decide(client, tid, "approve", payload={"choice": "skip"})
    while s["status"] == "waiting":
        s = decide(client, tid)
    assert s["status"] == "done", s
    assert got == []
    cfg = yaml.safe_load((Path(repo) / ".keel" / "config.yml").read_text())
    assert cfg["knowledge"] == {"build": "off"} and cfg["init"]["knowledge_sections"] == []


# ------------------------------------------------------------------ agents' prompts

def test_agents_get_knowledge_paths_only_when_the_notes_exist_and_are_on(tmp_path):
    k = {"sections": ["data", "domain"], "code_graph": False, "memory": False, "strict": False, "hints": False}
    assert agent_knowledge.prompt_block(str(tmp_path), k, False) == "", "nothing exists: no 'none of your sections' line"
    kb(tmp_path, "data")
    assert "docs/knowledge/data.md" in agent_knowledge.prompt_block(str(tmp_path), k, False)
    config(tmp_path, "knowledge:\n  build: off\n")
    assert agent_knowledge.prompt_block(str(tmp_path), k, False) == ""
    args = dict(agent="implementer", phase="green", step_name="green", title="t", root=str(tmp_path), ac=None, acs=[],
                feedback=None)
    p = prompts.task_prompt(**args)
    assert "docs/knowledge" not in p and "keel's memory" not in p, "no agent setting: the folder is not named either"
    p = prompts.task_prompt(**{**args, "agent": "spec-writer", "phase": "spec"})
    assert "docs/knowledge" not in p


# ------------------------------------------------------------------ ship and knowledge-refresh

def _input(root):
    return actions.ActionInput(root=str(root), phase="memory", title="t", ac=None, acs=[], fake=True, flow="ship",
                               project="p-notes")


def test_ship_skips_its_knowledge_step_while_the_notes_are_off(tmp_path):
    kb(tmp_path, "data")
    config(tmp_path, "knowledge:\n  build: off\n")
    r = ship._memory_plan(_input(tmp_path))
    plan = r.update["data"]["memory_plan"]
    assert plan == {"state": "off", "ask": "no", "run": "no", "check": "no", "text": ""}
    assert r.update["data"]["memory_choice"]["choice"] == "off" and "Project notes are off" in r.note


def test_a_refresh_turns_the_notes_on(tmp_path):
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    f = config(tmp_path, "version: 4\nknowledge:\n  build: off\n")
    r = ship._knowledge_scan(_input(tmp_path))
    assert "project notes turned on" in r.note
    assert yaml.safe_load(f.read_text())["knowledge"] == {"build": "on"}


# ------------------------------------------------------------------ the cost

def test_the_cost_grows_with_the_code_the_librarians_read(client, tmp_path):
    from keel_engine import config as keel_config

    tmp_path = tmp_path / "proj"           # the engine's data folder is in tmp_path itself
    tmp_path.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    (tmp_path / "app.py").write_text("x = 1\n" * 40_000)          # ~240 KB of code
    (tmp_path / "uv.lock").write_text("x" * 50_000)               # a lock file is not read
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True)
    assert knowledge.repo_tokens(str(tmp_path)) == 240_000 // 4
    assert knowledge.librarian_read_tokens(str(tmp_path)) == knowledge.READ_BASE + 60_000
    sonnet = {"default": {"provider": "claude", "model": "sonnet", "mode": "api"}}
    est = knowledge.build_estimate(str(tmp_path), sonnet)
    assert est["cost_usd"] > 1 and est["label"].startswith("≈$")
    # the same logic as Start a flow: the estimate route with the project folder counts the same reads
    text = (keel_config.content_dir() / "workflows" / "knowledge-refresh.yaml").read_text()
    body = {"yaml": text, "acs": 0, "models": sonnet}
    bare = client.post("/workflows/estimate", json=body).json()
    real = client.post("/workflows/estimate", json={**body, "root": str(tmp_path)}).json()
    assert real["tokens"] == est["tokens"] and real["tokens"] > bare["tokens"]
    assert knowledge.cost_label({"cost_usd": 4.6}) == "≈$3–7"
    assert knowledge.cost_label({"cost_usd": 0, "low": 900_000, "high": 2_100_000}) == "≈900k–2.1M tokens"
