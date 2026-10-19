"""0.18.19 undo / redo of a whole KeelBot answer (keel TUI's /undo and /redo with no argument), as opencode's /undo and
/redo work (from opencode (MIT), core/src/session/revert.ts): the last turn's files go back to what they were before it,
its question and answer stay stored but marked reverted, and the question comes back for the prompt; /redo puts the
turn back while no new turn was sent; a new turn makes the revert final."""

import subprocess as _sp
from pathlib import Path

import pytest

from keel_engine.models.base import AgentResult
from keel_plugin_keelbot import helper

from test_helper import ask, new_session


class ScriptRunner:
    """A model that makes the changes it is given, one plan per turn: {path: new text, or None to delete it}."""

    def __init__(self):
        self.plans: list[dict] = []
        self.prompts: list[str] = []
        self.histories: list[list] = []

    async def run(self, req, emit):
        self.prompts.append(req.prompt)
        self.histories.append(list(req.history or []))
        plan = self.plans.pop(0) if self.plans else {}
        for path, content in plan.items():
            if content is None:
                (Path(req.root) / path).unlink()
            else:
                assert not req.toolbox.write_file(path, content).startswith("REFUSED")
        return AgentResult(text=f"changed {', '.join(plan) or 'nothing'}", tokens_in=3, tokens_out=2)


@pytest.fixture
def model(monkeypatch):
    r = ScriptRunner()
    monkeypatch.setattr(helper.models, "runner_for", lambda _m: r)
    return r


def read(root, rel):
    f = Path(root) / rel
    return f.read_text() if f.is_file() else None


def _call(fn, sid, status):
    """helper.undo_turn / redo_turn as the routes answer them: the result, or {"error"} with the HelperError's status."""
    try:
        out, code = fn(sid), 200
    except helper.HelperError as exc:
        out, code = {"error": str(exc), "hint": exc.hint}, exc.status
    assert code == status, out
    return out


def undo_turn(_client, sid, status=200):
    return _call(helper.undo_turn, sid, status)


def redo_turn(_client, sid, status=200):
    return _call(helper.redo_turn, sid, status)


def two_turns(client, repo, model, mode="edit"):
    s = new_session(client, repo, mode=mode)
    readme = read(repo if mode != "side" else s["worktree"], "README.md")
    model.plans = [{"src/scores/a.py": "A = 1\n", "README.md": "# readme by turn 1\n"},
                   {"src/scores/a.py": "A = 2\n", "src/scores/b.py": "B = 1\n"}]
    ask(client, s["id"], "first: add a")
    ask(client, s["id"], "second: change a, add b")
    return s, readme


def test_undo_turn_restores_every_file_the_last_answer_changed_and_gives_the_question_back(client, repo, model):
    s, readme = two_turns(client, repo, model)
    r = undo_turn(client, s["id"])
    assert r["text"] == "second: change a, add b" and r["n"] == 3
    assert sorted(r["files"]) == ["src/scores/a.py", "src/scores/b.py"]
    assert read(repo, "src/scores/a.py") == "A = 1\n" and read(repo, "src/scores/b.py") is None
    assert read(repo, "README.md") == "# readme by turn 1\n"                 # the first turn's change stays
    msgs = client.get(f"/helper/sessions/{s['id']}").json()["messages"]
    assert len(msgs) == 4                                                     # nothing deleted
    assert [bool(m["data"].get("reverted")) for m in msgs] == [False, False, True, True]
    # a second undo: the turn before
    r = undo_turn(client, s["id"])
    assert r["text"] == "first: add a" and sorted(r["files"]) == ["README.md", "src/scores/a.py"]
    assert read(repo, "src/scores/a.py") is None and read(repo, "README.md") == readme
    assert client.get(f"/helper/sessions/{s['id']}/changes").json() == []
    assert undo_turn(client, s["id"], 409)["error"].startswith("Nothing to undo")


def test_redo_turn_puts_the_answers_back_one_at_a_time(client, repo, model):
    s, _ = two_turns(client, repo, model)
    undo_turn(client, s["id"])
    undo_turn(client, s["id"])
    r = redo_turn(client, s["id"])
    assert r["n"] == 1 and sorted(r["files"]) == ["README.md", "src/scores/a.py"]
    assert read(repo, "src/scores/a.py") == "A = 1\n" and read(repo, "src/scores/b.py") is None
    r = redo_turn(client, s["id"])
    assert r["n"] == 3 and read(repo, "src/scores/a.py") == "A = 2\n" and read(repo, "src/scores/b.py") == "B = 1\n"
    msgs = client.get(f"/helper/sessions/{s['id']}").json()["messages"]
    assert not any(m["data"].get("reverted") for m in msgs)
    assert redo_turn(client, s["id"], 409)["error"].startswith("Nothing to redo")


def test_a_new_turn_makes_the_revert_final_and_the_model_never_sees_the_reverted_turn(client, repo, model):
    s, _ = two_turns(client, repo, model)
    undo_turn(client, s["id"])
    model.plans = [{"src/scores/c.py": "C = 1\n"}]
    ask(client, s["id"], "third: add c instead")
    assert all("second: change a" not in t for _, t in model.histories[-1])         # the reverted turn is not history
    assert redo_turn(client, s["id"], 409)["error"].startswith("Nothing to redo")
    assert read(repo, "src/scores/b.py") is None                                     # its newer files are dropped
    msgs = client.get(f"/helper/sessions/{s['id']}").json()["messages"]
    assert [m["data"].get("reverted") for m in msgs][2:4] == [True, True]            # still stored, shown as reverted
    # undo now takes the third turn, then the first: the final revert is never undone twice
    assert undo_turn(client, s["id"])["text"] == "third: add c instead"
    assert read(repo, "src/scores/c.py") is None
    assert undo_turn(client, s["id"])["text"] == "first: add a"


def test_undo_turn_refuses_when_the_person_changed_those_files_after_it_and_changes_nothing(client, repo, model):
    s, _ = two_turns(client, repo, model)
    (Path(repo) / "src/scores/b.py").write_text("B = 'mine'\n")
    r = undo_turn(client, s["id"], 409)
    assert "src/scores/b.py" in r["error"] and "src/scores/a.py" not in r["error"]
    assert read(repo, "src/scores/a.py") == "A = 2\n" and read(repo, "src/scores/b.py") == "B = 'mine'\n"
    assert not any(m["data"].get("reverted") for m in client.get(f"/helper/sessions/{s['id']}").json()["messages"])


def test_redo_turn_refuses_when_the_person_changed_the_files_after_the_undo(client, repo, model):
    s, _ = two_turns(client, repo, model)
    undo_turn(client, s["id"])
    (Path(repo) / "src/scores/a.py").write_text("A = 'mine'\n")
    r = redo_turn(client, s["id"], 409)
    assert "src/scores/a.py" in r["error"]
    assert read(repo, "src/scores/a.py") == "A = 'mine'\n" and read(repo, "src/scores/b.py") is None


def test_undo_turn_gives_back_the_persons_own_unsaved_version_and_never_touches_other_files(client, repo, model):
    (Path(repo) / "README.md").write_text("# my own unsaved readme\n")
    (Path(repo) / "NOTES.md").write_text("my notes\n")
    s = new_session(client, repo, mode="edit")
    model.plans = [{"README.md": "# readme by KeelBot\n"}]
    ask(client, s["id"], "change the readme")
    (Path(repo) / "NOTES.md").write_text("my notes, more\n")                       # not a file the turn changed
    assert undo_turn(client, s["id"])["files"] == ["README.md"]
    assert read(repo, "README.md") == "# my own unsaved readme\n"
    assert read(repo, "NOTES.md") == "my notes, more\n"


def test_undo_turn_in_a_side_session_works_in_its_worktree(client, repo, model):
    s, readme = two_turns(client, repo, model, mode="side")
    wt = s["worktree"]
    r = undo_turn(client, s["id"])
    assert sorted(r["files"]) == ["src/scores/a.py", "src/scores/b.py"]
    assert read(wt, "src/scores/a.py") == "A = 1\n" and read(wt, "src/scores/b.py") is None
    assert read(repo, "src/scores/a.py") is None and read(repo, "README.md") == readme      # the project folder: untouched
    redo_turn(client, s["id"])
    assert read(wt, "src/scores/b.py") == "B = 1\n"


def test_undo_turn_in_a_fix_chat(client, repo, model):
    from test_helper import FLOW
    s = new_session(client, repo, mode="fix", thread_id="t-gate")
    model.plans = [{"src/scores/a.py": "A = 1\n"}]
    ask(client, s["id"], "add a", flow=FLOW)
    assert undo_turn(client, s["id"])["files"] == ["src/scores/a.py"]
    assert read(repo, "src/scores/a.py") is None


def test_ask_mode_has_nothing_to_undo(client, repo):
    s = new_session(client, repo)
    ask(client, s["id"], "Where does it start?")
    r = undo_turn(client, s["id"], 400)
    assert "Ask mode changes nothing" in r["error"]
    assert redo_turn(client, s["id"], 400)["error"].startswith("Ask mode changes nothing")


def test_an_answer_with_no_file_change_is_undone_too(client, repo, model):
    s = new_session(client, repo, mode="edit")
    model.plans = [{}]
    ask(client, s["id"], "just explain")
    r = undo_turn(client, s["id"])
    assert r["files"] == [] and r["text"] == "just explain"


def test_a_kept_answer_cannot_be_undone(client, repo, model):
    s = new_session(client, repo, mode="edit")
    model.plans = [{"src/scores/a.py": "A = 1\n"}]
    ask(client, s["id"], "add a")
    assert client.post(f"/helper/sessions/{s['id']}/done", json={"flow": {}}).json()["ok"] is True
    r = undo_turn(client, s["id"], 409)
    assert "src/scores/a.py" in r["error"] and "kept" in r["error"]
    assert read(repo, "src/scores/a.py") == "A = 1\n"
    head = _sp.run(["git", "status", "--porcelain"], cwd=repo, capture_output=True, text=True).stdout
    assert "a.py" not in head


def test_a_file_undone_on_its_own_is_left_alone_by_undo_turn(client, repo, model):
    s, _ = two_turns(client, repo, model)
    assert client.post(f"/helper/sessions/{s['id']}/undo", json={"path": "src/scores/b.py"}).status_code == 200
    r = undo_turn(client, s["id"])
    assert r["files"] == ["src/scores/a.py"]
    assert read(repo, "src/scores/a.py") == "A = 1\n" and read(repo, "src/scores/b.py") is None


def test_undo_turn_and_redo_turn_need_a_known_chat():
    assert _call(helper.undo_turn, "nope", 404)["error"].startswith("No KeelBot session")
    assert _call(helper.redo_turn, "nope", 404)["error"].startswith("No KeelBot session")


def test_deleting_a_chat_drops_its_turn_records(client, repo, model):
    s, _ = two_turns(client, repo, model)
    assert client.delete(f"/helper/sessions/{s['id']}").status_code == 200
    from keel_engine.runtime import db
    with db.connect() as conn:
        helper._turn_table(conn)
        assert conn.execute("select count(*) from helper_turn_files where session_id = ?", (s["id"],)).fetchone()[0] == 0


def test_a_final_revert_starts_a_fresh_cli_session_without_the_undone_turn(client, repo, model):
    # claude and codex continue their own session, which still holds the undone turn: the next turn starts a new one
    s, _ = two_turns(client, repo, model)
    helper.update(s["id"], engine_session="cli-session-1")
    undo_turn(client, s["id"])
    assert helper.get(s["id"], messages=False)["engine_session"] == "cli-session-1"     # /redo may still come
    assert helper.finalize_reverts(s["id"]) == 1
    assert helper.get(s["id"], messages=False)["engine_session"] is None
    assert helper.finalize_reverts(s["id"]) == 0


# ------------------------------------------------------------------ the routes keel TUI's /undo and /redo call

def test_the_undo_turn_and_redo_turn_routes(client, repo, model):
    s, _ = two_turns(client, repo, model)
    r = client.post(f"/helper/sessions/{s['id']}/undo-turn")
    assert r.status_code == 200 and r.json()["text"] == "second: change a, add b" and len(r.json()["files"]) == 2
    r = client.post(f"/helper/sessions/{s['id']}/redo-turn")
    assert r.status_code == 200 and r.json()["n"] == 3
    r = client.post(f"/helper/sessions/{s['id']}/redo-turn")
    assert r.status_code == 409 and r.json()["error"].startswith("Nothing to redo")
    assert client.post("/helper/sessions/nope/undo-turn").status_code == 404
    assert client.post("/helper/sessions/nope/redo-turn").status_code == 404
    a = new_session(client, repo)
    assert client.post(f"/helper/sessions/{a['id']}/undo-turn").status_code == 400
