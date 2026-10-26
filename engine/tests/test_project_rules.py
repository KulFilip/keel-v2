"""keel 0.18.57 project standards: a repo often keeps its own instructions and skills for coding agents (AGENTS.md,
CLAUDE.md, .github/copilot-instructions.md, docs/ONBOARDING.md, .claude/skills/*/SKILL.md, .opencode/skills/*/SKILL.md,
.cursor/rules/*). init and knowledge-refresh find them, write a short "Project rules" page into the knowledge folder,
and record them in .keel/project-rules.json, where the api reads which skill goes to which agents (a doc that says
"load skill X when writing tests", or a skill whose description says it is for tests)."""

import json
import subprocess
from pathlib import Path

from keel_engine.runtime import project_rules
from keel_engine.runtime.actions import ActionInput
from keel_engine.workflows.templates import get_template


def skill(root: Path, where: str, name: str, about: str, body: str = "# Notes\n- one rule\n") -> None:
    d = root / where / name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {about}\n---\n\n{body}")


def shop(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    root.mkdir()
    (root / "AGENTS.md").write_text("# Agent guide for shop\n\nRun `make test`.\n\n"
                                    "Load the skill `shop-fixtures` when writing tests.\n")
    (root / "CLAUDE.md").write_text("Read AGENTS.md first.\n")
    (root / ".github").mkdir()
    (root / ".github/copilot-instructions.md").write_text("# Copilot rules\nUse the money type for prices.\n")
    (root / "docs").mkdir()
    (root / "docs/ONBOARDING.md").write_text("# Onboarding\n\nFor new endpoints, use skill shop-endpoints.\n")
    (root / ".cursor/rules").mkdir(parents=True)
    (root / ".cursor/rules/money.mdc").write_text("---\ndescription: prices\n---\nNever use float for money.\n")
    skill(root, ".claude/skills", "shop-fixtures", "How shop builds its test data with factories.")
    skill(root, ".opencode/skills", "shop-endpoints", "Adding an HTTP endpoint the shop way.")
    skill(root, ".opencode/skills", "shop-e2e", "Use when writing Playwright tests for the checkout.")
    skill(root, ".claude/skills", "shop-glossary", "The words the shop team uses.")
    return root


def test_discover_finds_the_docs_and_the_skills_and_what_each_skill_is_for(tmp_path):
    found = project_rules.discover(shop(tmp_path))
    assert [d["path"] for d in found["docs"]] == ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md",
                                                 "docs/ONBOARDING.md", ".cursor/rules/money.mdc"]
    assert found["docs"][0]["title"] == "Agent guide for shop"
    by = {s["name"]: s for s in found["skills"]}
    assert set(by) == {"shop-fixtures", "shop-endpoints", "shop-e2e", "shop-glossary"}
    assert by["shop-fixtures"]["path"] == ".claude/skills/shop-fixtures/SKILL.md"
    # a doc says "load the skill shop-fixtures when writing tests"
    assert by["shop-fixtures"]["use"] == "tests" and by["shop-fixtures"]["why"].startswith("AGENTS.md:")
    assert by["shop-fixtures"]["agents"] == ["test-author", "implementer"]
    # a doc names it for new endpoints: code
    assert by["shop-endpoints"]["use"] == "implementation" and by["shop-endpoints"]["agents"] == ["implementer"]
    # its own description says it is for tests
    assert by["shop-e2e"]["use"] == "tests" and by["shop-e2e"]["why"] == "its description"
    assert by["shop-e2e"]["agents"] == ["test-author", "implementer"]
    # nothing says when: listed, on no agent
    assert by["shop-glossary"]["use"] is None and by["shop-glossary"]["agents"] == []


def test_discover_ignores_keels_own_files_and_a_repo_without_rules(tmp_path):
    root = tmp_path / "bare"
    (root / ".keel/knowledge").mkdir(parents=True)
    (root / ".keel/CLAUDE.md").write_text("keel's own block\n")
    skill(root, ".keel", "not-a-skill-folder", "x")
    assert project_rules.discover(root) == {"docs": [], "skills": []}


def test_the_action_writes_the_knowledge_page_and_the_record_the_api_reads(tmp_path):
    root = shop(tmp_path)
    a = ActionInput(root=str(root), phase="setup", title="init", ac=None, acs=[], fake=True, flow="init")
    r = project_rules.project_rules_action(a)
    assert r.ok and r.note == "project rules: 5 doc(s), 4 skill(s), 3 attached"
    saved = json.loads((root / ".keel/project-rules.json").read_text())
    assert saved["skills"][0]["name"] == "shop-e2e" and "found_at" in saved
    page = (root / ".keel/knowledge/project-rules.md").read_text()
    assert page.startswith("# Project rules\n")
    assert "- `AGENTS.md`: Agent guide for shop" in page
    assert "`shop-fixtures` (`.claude/skills/shop-fixtures/SKILL.md`)" in page
    assert "for tests (AGENTS.md:" in page and "loaded by test-author, implementer" in page
    assert r.update["data"]["project_rules"]["skills"][1]["name"] == "shop-endpoints"


def test_a_repo_without_rules_gets_no_page(tmp_path):
    root = tmp_path / "bare"
    root.mkdir()
    r = project_rules.project_rules_action(ActionInput(root=str(root), phase="setup", title="t", ac=None, acs=[],
                                                       fake=True, flow="init"))
    assert r.ok and r.note == "project rules: none found"
    assert not (root / ".keel/knowledge/project-rules.md").exists()
    assert json.loads((root / ".keel/project-rules.json").read_text())["skills"] == []


def test_a_stale_page_goes_when_the_rules_are_gone(tmp_path):
    root = shop(tmp_path)
    a = ActionInput(root=str(root), phase="memory", title="t", ac=None, acs=[], fake=True, flow="knowledge-refresh")
    project_rules.project_rules_action(a)
    for p in ("AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md", "docs/ONBOARDING.md", ".cursor/rules/money.mdc"):
        (root / p).unlink()
    subprocess.run(["rm", "-rf", str(root / ".claude"), str(root / ".opencode")], check=True)
    project_rules.project_rules_action(a)
    assert not (root / ".keel/knowledge/project-rules.md").exists()


def test_init_and_knowledge_refresh_run_the_discovery():
    assert get_template("init").step("project_rules").action == "project_rules"
    ids = [s.id for s in get_template("init").steps]
    assert ids.index("write_config") < ids.index("project_rules") < ids.index("lanes")
    assert get_template("knowledge-refresh").step("project_rules").action == "project_rules"


def test_agents_get_a_pointer_to_the_project_rules(tmp_path):
    from keel_engine.runtime import prompts
    root = shop(tmp_path)
    project_rules.project_rules_action(ActionInput(root=str(root), phase="setup", title="t", ac=None, acs=[], fake=True,
                                                   flow="init"))
    p = prompts.task_prompt(agent="implementer", phase="ac", step_name="make the change", title="t", root=str(root),
                            ac=None, acs=[], feedback=None)
    assert ("This project's own rules for coding agents: AGENTS.md, CLAUDE.md, .github/copilot-instructions.md, "
            "docs/ONBOARDING.md, .cursor/rules/money.mdc (pointers: .keel/knowledge/project-rules.md).") in p
    bare = tmp_path / "bare"
    bare.mkdir()
    assert "own rules for coding agents" not in prompts.task_prompt(
        agent="implementer", phase="ac", step_name="s", title="t", root=str(bare), ac=None, acs=[], feedback=None)


def test_the_init_hand_over_says_what_was_found(tmp_path):
    from keel_engine.runtime import init_actions
    root = shop(tmp_path)
    a = ActionInput(root=str(root), phase="setup", title="init", ac=None, acs=[], fake=True, flow="init",
                    data={"project_rules": project_rules.discover(root)})
    r = init_actions._init_summary(a)
    text = r.update["data"]["hand_over_detail"]
    assert "Project rules: 5 doc(s) for coding agents (AGENTS.md, CLAUDE.md, .github/copilot-instructions.md, …)" in text
    assert "- shop-fixtures: for tests, attached to test-author, implementer" in text
    assert "- shop-glossary: found, on no agent (nothing says when to load it)" in text
    assert "Skills page" in text
