"""The spec gate must never offer a template placeholder as a criterion."""
from pathlib import Path

from keel_engine.runtime import prompts
from conftest import decide, start, wait


def test_placeholders_and_examples_are_not_criteria():
    text = """Pattern to copy:
```
## Acceptance criteria
- **AC-1** [API] <behaviour>
```
- **AC-2** [API] <what must be true>
- **AC-3** [WEB] Players see their rank next to the top 10
"""
    acs = prompts.parse_acs(text)
    assert [a["id"] for a in acs] == ["AC-3"]


def test_request_text_reaches_the_agents():
    p = prompts.task_prompt(agent="explorer", phase="spec", step_name="spec", title="ranks", root="/r", ac=None, acs=[],
                            feedback=None, request="Show each player's rank next to the top 10 list.")
    assert "What the user asked for:\nShow each player's rank" in p
    assert "If the request is too unclear" in p


def test_max_turns_comes_from_the_agent_file(tmp_path, monkeypatch):
    (tmp_path / "agents").mkdir()
    (tmp_path / "agents" / "explorer.md").write_text("---\nname: explorer\nmaxTurns: 20\n---\nYou map code.\n")
    monkeypatch.setenv("KEEL_CONTENT", str(tmp_path))
    assert prompts.max_turns("explorer") == 20
    assert prompts.max_turns("nobody") is None


def test_a_spec_gate_without_criteria_only_allows_send_back(client, repo, monkeypatch):
    # the explorer answers without criteria and writes no spec file (like a real agent given only "test")
    from keel_engine.models import fake as fake_mod
    real = fake_mod._plan

    def no_spec(req):
        if req.agent == "explorer" and req.phase == "spec" and req.step_name == "spec":
            return None, "", "No feature topic was named. Pattern: - **AC-1** [API] <behaviour>", {}
        return real(req)
    monkeypatch.setattr(fake_mod, "_plan", no_spec)
    tid = start(client, repo, acs=None)
    st = wait(client, tid)
    w = st["waiting"]
    assert w["options"] == ["reject"]
    assert "no acceptance criteria" in w["title"]
    assert "No feature topic was named" in w["detail"]
    assert st["acs"] == []
    # approving anyway is refused (it used to act as a send-back without a reason, again and again)
    r = client.post(f"/threads/{tid}/resume", json={"decision": "approve", "why": "x"})
    assert r.status_code == 400 and "does not take approve" in r.text and "reject" in r.text, r.text
    st = wait(client, tid)
    assert st["acs"] == [] and st["status"] == "waiting" and st["waiting"]["id"] == w["id"]


def test_a_criterion_wrapped_over_lines_is_read_whole():
    text = """## Acceptance criteria

- **AC-1** [API] Given players with distinct best scores, when
  `rankOf(playerId)` is called, then it returns the 1-based rank.
- **AC-2** [WEB] Short one.
    - a nested note is not part of the title
"""
    acs = prompts.parse_acs(text)
    assert acs[0]["title"] == "Given players with distinct best scores, when `rankOf(playerId)` is called, then it returns the 1-based rank."
    assert acs[1]["title"] == "Short one."


def test_logins_can_be_given_again_after_a_restart(client, repo):
    tid = start(client, repo)
    wait(client, tid)
    svc = client.app.state.engine
    svc.keys.pop(tid, None)                      # what an engine restart does
    r = client.post(f"/threads/{tid}/resume", json={"decision": "approve", "keys": {"claude_oauth": "tok-again"}})
    assert r.status_code == 200
    assert svc.keys[tid] == {"claude_oauth": "tok-again"}


def test_green_prompt_keeps_later_criteria_out(tmp_path):
    from keel_engine.runtime.prompts import task_prompt
    acs = [{"id": "AC-1", "layer": "API", "title": "a", "status": "done"},
           {"id": "AC-2", "layer": "API", "title": "b", "status": "todo"},
           {"id": "AC-3", "layer": "API", "title": "c", "status": "todo"}]
    text = task_prompt(agent="implementer", phase="green", step_name="green", title="t", root=str(tmp_path),
                       ac=acs[1], acs=acs, feedback=None)
    assert "later criteria (AC-3)" in text and "AC-1" not in text.split("later criteria")[1].split(")")[0]


def test_librarian_gets_the_templates_and_a_short_memory_brief(tmp_path, monkeypatch):
    from keel_engine.runtime.prompts import task_prompt
    monkeypatch.setenv("KEEL_CONTENT", str(tmp_path))
    text = task_prompt(agent="librarian", phase="memory", step_name="memory", title="t", root="/r", ac=None, acs=[], feedback=None)
    assert f"{tmp_path}/templates/knowledge/<section>.md" in text and "Do not read keel's own source" in text
    assert "only the knowledge sections this branch changes" in text


def test_skill_references_get_full_paths(tmp_path, monkeypatch):
    from keel_engine.runtime import prompts
    ref = tmp_path / "skills" / "spec-writing" / "references"
    ref.mkdir(parents=True)
    (ref / "acceptance-criteria.md").write_text("# AC")
    monkeypatch.setenv("KEEL_CONTENT", str(tmp_path))
    out = prompts.system_prompt("explorer", {"explorer": "Read `references/acceptance-criteria.md` and references/nope.md"})
    assert f"{ref}/acceptance-criteria.md" in out and "references/nope.md" in out
    assert f"Skill files are under {tmp_path}/skills/;" in out and "never search the disk" in out
    # a name two skills share stays as written: the agent must not be sent to the wrong one
    other = tmp_path / "skills" / "web-implementation" / "references"
    other.mkdir(parents=True)
    (other / "acceptance-criteria.md").write_text("# other")
    assert "Read references/acceptance-criteria.md" in prompts.system_prompt("explorer", {"explorer": "Read references/acceptance-criteria.md"})


def test_a_sent_back_spec_is_changed_not_rewritten_from_scratch():
    from keel_engine.runtime.prompts import task_prompt
    p = task_prompt(agent="explorer", phase="spec", step_name="spec", title="t", root="/r", ac=None, acs=[],
                    feedback="1 entity types first", spec="docs/specs/x.md")
    assert "The spec docs/specs/x.md exists from the last try" in p and "do not explore the project again" in p


VISITS_SPEC = """# Visit count per pet

## Acceptance criteria
- **AC-1** [WEB] Given an owner whose pet has n >= 2 visits (e.g. 2, 3,
  12), when /owners/{id} is rendered, then the pet row shows "n visits".
- **AC-2** [WEB] Given a pet with exactly 1 visit, when /owners/{id} is rendered,
  then the pet row shows "1 visit".
- **AC-3** [WEB] Given a pet with no visits, when /owners/{id} is rendered, then the pet row shows "no visits".
"""


def hidden_layout(repo):
    """layout keel: the specs live in .keel/specs, which git ignores (a CLI agent's spec there is never dirty)."""
    from keel_engine import layout
    (Path(repo) / ".keel").mkdir(exist_ok=True)
    (Path(repo) / ".keel" / "config.yml").write_text("layout: keel\n")
    assert layout.hide(repo)


def cli_explorer(monkeypatch, where: str, answer: str):
    """The spec explorer writes its spec with its own tools (straight to disk, keel's ToolBox sees no write) and its
    answer has no criteria lines, like the Claude Code CLI in the e2e."""
    from keel_engine.models import fake as fake_mod
    real = fake_mod._plan

    def plan(req):
        if req.agent == "explorer" and req.phase == "spec" and req.step_name == "spec":
            p = Path(req.root) / where
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(VISITS_SPEC)
            return None, "", answer, {}
        return real(req)
    monkeypatch.setattr(fake_mod, "_plan", plan)


def test_a_spec_written_outside_keels_tools_into_a_git_ignored_folder_reaches_the_gate(client, repo, monkeypatch):
    import subprocess
    hidden_layout(repo)
    cli_explorer(monkeypatch, ".keel/specs/visit-count-per-pet.md", "The spec is ready for review.")
    # the title is not the file's name: spec_sync's look-up by the title's slug does not find it either
    tid = start(client, repo, acs=None, title="Show how many visits each pet had")
    st = wait(client, tid)
    assert "visit-count-per-pet" not in subprocess.run(["git", "status", "--porcelain"], cwd=repo, capture_output=True,
                                                       text=True).stdout, "the spec folder is git-ignored"
    w = st["waiting"]
    assert w["step"] == "spec_gate" and "no acceptance criteria" not in w["title"], w
    assert "approve" in w["options"]
    assert [a["id"] for a in st["acs"]] == ["AC-1", "AC-2", "AC-3"]
    assert st["acs"][0]["title"].startswith("Given an owner whose pet has n >= 2 visits (e.g. 2, 3, 12)")
    assert st["spec"] == ".keel/specs/visit-count-per-pet.md"
    st = decide(client, tid, "approve", payload={"choice": "approve"})
    assert st["status"] in ("waiting", "done") and st["waiting"]["step"] != "spec_gate", st


def test_a_spec_the_answer_names_is_read(client, repo, monkeypatch):
    hidden_layout(repo)        # git-ignored and outside the spec folder: only the answer says where it is
    cli_explorer(monkeypatch, ".keel/drafts/spec-visits.md", "I wrote the spec to `.keel/drafts/spec-visits.md`.")
    tid = start(client, repo, acs=None, title="Show how many visits each pet had")
    st = wait(client, tid)
    assert len(st["acs"]) == 3 and st["spec"] == ".keel/drafts/spec-visits.md", st
