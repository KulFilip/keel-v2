"""KeelBot's view of keel (keel_plugin_keelbot.keelbot): the workflows it suggests, the flows it answers about, the
buttons it gives, and the workflow format only when the person wants a workflow of their own."""

import re

from keel_engine.workflows.validate import validate_yaml
from keel_plugin_keelbot import helper, keelbot

KEEL = {
    "workflows": [
        {"id": "feature", "name": "feature (keel)", "source": "keel", "steps": [{"id": "spec", "name": "spec"}],
         "last_run": {"title": "Euro prices", "status": "waiting"}},
        {"id": "demo-checks", "name": "checks", "source": "yours", "folder": "Daily", "based_on": None,
         "steps": [{"id": "lint", "kind": "code", "name": "run the linters"}, {"id": "look", "kind": "gate", "name": "look"}]},
    ],
    "flows": [
        {"thread_id": "t-1", "title": "Euro prices", "workflow": "feature", "status": "waiting",
         "waiting": {"title": "spec approval"}, "step": "g-spec", "phase": "spec", "acs_done": 1, "acs_total": 3,
         "branch": "feat/euro-prices", "where": "worktree", "tokens": 120_000},
    ],
}


def test_the_block_names_the_workflows_the_flows_and_the_buttons():
    b = keelbot.keel_block(KEEL, "How do I add a report page?")
    assert "- `feature` feature (keel): a new feature with a spec" in b and '(last run: waiting, "Euro prices")' in b
    assert "- `demo-checks` checks: yours, folder Daily; 2 steps: run the linters → look; no agents" in b
    assert ('- "Euro prices" (feature, id t-1): waiting; waits for the person at "spec approval"; step g-spec; phase spec; '
            "criteria 1/3 done; branch feat/euro-prices (own worktree); 120k tokens") in b
    assert "```keel-start" in b and "keel-workflow" in b
    # 0.18.4 the person's other buttons: decide a gate, stop flows, a run mode (KeelBot never says it cannot)
    assert "```keel-flow" in b and '"do": "stop"' in b and '"do": "mode"' in b and '"do": "approve"' in b
    assert "How a workflow is written" not in b                 # the format only when the person wants a workflow
    # 0.18.5 a new rule pack or agent: its format only when the person wants one
    assert "keel-rule" in b and "keel-agent" in b and "How a rule pack is written" not in b
    rb = keelbot.keel_block(KEEL, "write a rule that blocks edits to applied migrations")
    assert "How a rule pack is written" in rb and "How an agent is written" not in rb
    ab = keelbot.keel_block(KEEL, "create a new agent that writes the docs")
    assert "How an agent is written" in ab and "How a rule pack is written" not in ab
    assert keelbot.keel_block(None, "hi") == ""


def test_the_format_comes_with_a_question_about_a_workflow_of_ones_own():
    b = keelbot.keel_block(KEEL, "Make me a new workflow that runs the tests and the linters")
    assert "How a workflow is written" in b and "Phases: setup," in b and "- run: Runs one shell command" in b
    assert "- implementer:" in b and "- helper:" not in b        # agents to use, not KeelBot itself
    example = re.search(r"```keel-workflow\n(.*?)```", b, re.S)[1]
    assert validate_yaml(example)["ok"]                         # the example keel shows is a valid workflow


def test_the_prompt_carries_the_block(repo):
    p = helper.build_prompt(mode="ask", root=str(repo), question="Which workflow?", know={"sections": [], "code_graph": False, "memory": False}, graph=False, flow=None,
                            mentions=None, selection=None, open_file=None, transcript="", keel=KEEL)
    assert "The workflows this project can run" in p and p.endswith("Question: Which workflow?")
