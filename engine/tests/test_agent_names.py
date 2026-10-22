"""The review agents' new names (keel_engine/agent_names.py): an old name in a workflow, a per-agent setting or an agent
file lookup still reaches the new agent, and the new name wins when both are given."""

from __future__ import annotations

from conftest import wait
from test_flows_base import answers

from keel_engine import addons, agent_names, config
from keel_engine.models import fake
from keel_engine.models.base import AgentRequest
from keel_engine.runtime import agent_knowledge, prompts
from keel_engine.runtime.state import ThreadContext
from keel_engine.workflows.model import from_dict, load_yaml
from keel_engine.workflows.validate import validate_yaml

FAKE = {"provider": "fake", "mode": "api", "model": "fake"}
OLD_FLOW = """id: mine
name: mine
keel_rules: false
steps:
  - { id: look, kind: agent, name: look, agent: reviewer, markers: [BLOCKING] }
  - { id: lanes, kind: parallel, name: lanes, lanes: [{ name: one, sub: ac-reviewer, kind: agent }] }
"""


def test_the_table_maps_each_old_name_to_its_new_one():
    assert agent_names.RENAMED == {"ac-reviewer": "criterion-reviewer", "code-reviewer": "branch-reviewer",
                                   "reviewer": "lens-reviewer", "ticket-reviewer": "pr-reviewer"}
    assert agent_names.canonical("ticket-reviewer") == "pr-reviewer"
    assert agent_names.canonical("implementer") == "implementer" and agent_names.canonical(None) is None
    # every new name is one of keel's agent files, and no old name is one any more
    stems = {f.stem for f in (config.content_dir() / "agents").glob("*.md")}
    assert set(agent_names.RENAMED.values()) <= stems and not (agent_names.OLD_NAMES & stems)


def test_a_per_agent_dict_moves_old_keys_and_the_new_name_wins():
    assert agent_names.canonical_keys({"reviewer": 1, "implementer": 2}) == {"lens-reviewer": 1, "implementer": 2}
    assert agent_names.canonical_keys({"reviewer": 1, "lens-reviewer": 3}) == {"lens-reviewer": 3}
    assert agent_names.lookup({"code-reviewer": "old"}, "branch-reviewer") == "old"
    assert agent_names.lookup({"code-reviewer": "old", "branch-reviewer": "new"}, "code-reviewer") == "new"


def test_a_workflow_step_with_an_old_name_runs_the_new_agent():
    wf = load_yaml(OLD_FLOW)
    assert wf.steps[0].agent == "lens-reviewer"
    assert wf.steps[1].lanes[0].sub == "criterion-reviewer"
    step = from_dict({"name": "x", "steps": [{"id": "a", "kind": "agent", "name": "a", "agent": "code-reviewer",
                                               "model": "ticket-reviewer"}]}).steps[0]
    assert (step.agent, step.model) == ("branch-reviewer", "pr-reviewer")     # a model that names an agent's setting


def test_validation_accepts_an_old_name_with_a_soft_note():
    r = validate_yaml(OLD_FLOW)
    assert r["ok"] and r["errors"] == []
    assert r["notes"] == ["Step 'look': agent 'reviewer' is now called 'lens-reviewer'; the old name still works.",
                          "Step 'lanes': agent 'ac-reviewer' is now called 'criterion-reviewer'; the old name still works."]
    assert "notes" not in validate_yaml(OLD_FLOW.replace("agent: reviewer", "agent: lens-reviewer")
                                        .replace("sub: ac-reviewer", "sub: criterion-reviewer"))


def test_the_validate_route_shows_the_note(client):
    r = client.post("/workflows/validate", json={"yaml": OLD_FLOW}).json()
    assert r["ok"] and len(r["notes"]) == 2


def test_an_old_name_finds_the_new_agents_file_role_and_turns():
    for old, new in agent_names.RENAMED.items():
        assert addons.agent_path(old) == config.content_dir() / "agents" / f"{new}.md"
        assert prompts.role_text(old) == prompts.role_text(new) != prompts.GENERIC_ROLE
        assert prompts.max_turns(old) == prompts.max_turns(new) is not None
    assert agent_knowledge.default_for("lens-reviewer") == agent_knowledge.for_agent("reviewer", None)


def test_old_name_settings_reach_the_new_agent_in_a_thread():
    mine = {"provider": "fake", "mode": "api", "model": "fake-strong"}
    ctx = ThreadContext(thread_id="t", project_id="p", root="/r", workflow=load_yaml(OLD_FLOW), title="t",
                        models={"default": FAKE, "reviewer": mine}, skills={"code-reviewer": "SKILL"},
                        agents={"ac-reviewer": {"knowledge": {"sections": ["data"]}}})
    assert ctx.models == {"default": FAKE, "lens-reviewer": mine}
    assert ctx.skills == {"branch-reviewer": "SKILL"}
    assert agent_knowledge.for_agent("criterion-reviewer", ctx.agents)["sections"] == ["data"]
    both = ThreadContext(thread_id="t", project_id="p", root="/r", workflow=load_yaml(OLD_FLOW), title="t",
                         models={"reviewer": FAKE, "lens-reviewer": mine})
    assert both.models == {"lens-reviewer": mine}
    assert "SKILL" in prompts.system_prompt("code-reviewer", {"code-reviewer": "SKILL"})


def test_a_flow_with_an_old_name_runs_the_new_agent_on_its_old_name_model(client, repo, monkeypatch):
    seen = answers(monkeypatch, {"lens-reviewer": lambda req: "Fine.\nBLOCKING: no"})
    strong = {"provider": "fake", "mode": "api", "model": "fake-strong"}
    body = {"project_id": "demo", "root": str(repo), "title": "old names",
            "workflow": {"id": "mine", "name": "mine", "keel_rules": False, "yaml": OLD_FLOW.split("  - { id: lanes")[0],
                         "steps": [{"id": "look", "kind": "agent", "name": "look", "agent": "reviewer", "markers": ["BLOCKING"]}]},
            "models": {"default": FAKE, "reviewer": strong},
            "settings": {"gates_mode": "every-ac", "cap_tokens": 0, "on_cap": "pause"}, "mcp": [], "skills": {}}
    r = client.post("/threads", json=body)
    assert r.status_code == 200, r.text
    s = wait(client, r.json()["thread_id"])
    assert s["status"] == "done", s
    assert [(q.agent, q.model["model"]) for q in seen] == [("lens-reviewer", "fake-strong")]


def test_the_fake_model_knows_the_new_names():
    def ask(agent: str, **kw) -> str:
        req = AgentRequest(agent=agent, phase=kw.pop("phase", "review"), step_name="x", prompt="", system="", root="",
                           model=FAKE, toolbox=None, **kw)
        return fake._plan(req)[2]
    assert "AC-REVIEW: PASS" in ask("criterion-reviewer", phase="gate", ac={"id": "AC-1", "title": "t"})
    assert "BLOCKING: no" in ask("lens-reviewer")
    assert "CODE-REVIEW: pass" in ask("branch-reviewer")
    assert "TICKET-REVIEW: done" in ask("pr-reviewer", item={"job": "check"})
