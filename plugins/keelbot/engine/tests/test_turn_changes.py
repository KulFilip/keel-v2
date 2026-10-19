"""0.18.20 The files one KeelBot answer changed: keel TUI's block after an answer lists only those (with their diffs),
never the folder's other uncommitted files (the person's own, or what keel init left uncommitted). The answer's stored
data says which files the turn changed ({"turn": n, "files": [...]}); GET .../changes?turn=n gives their diffs, the
file as it was before that turn against how the turn left it."""

import subprocess as _sp
from pathlib import Path

from test_helper import ask, new_session
from test_turn_undo import model  # noqa: F401  (the fixture: a model that makes the changes it is given)


def _git(repo, *args):
    return _sp.run(["git", *args], cwd=repo, capture_output=True, text=True, check=True).stdout


def init_leftovers(repo):
    """What keel init leaves uncommitted in a project: a new runbook, a new code-graph ignore file, .gitignore lines."""
    root = Path(repo)
    (root / "docs").mkdir(exist_ok=True)
    (root / "docs" / "RUNNING.md").write_text("# Running\n\nmake test\n")
    (root / ".codegraph").mkdir(exist_ok=True)
    (root / ".codegraph" / ".gitignore").write_text("*.db\n")
    gi = root / ".gitignore"
    gi.write_text((gi.read_text() if gi.is_file() else "") + "\n# keel init output\n.keel/worktrees/\n")
    assert {"docs/RUNNING.md", ".codegraph/.gitignore", ".gitignore"} <= set(
        ln[3:] for ln in _git(repo, "status", "--porcelain", "--untracked-files=all").splitlines())


def answer_data(s):
    return [m for m in s["messages"] if m["role"] == "helper"][-1]["data"]


def turn_changes(client, sid, n):
    r = client.get(f"/helper/sessions/{sid}/changes", params={"turn": n})
    assert r.status_code == 200, r.text
    return r.json()


def test_an_answer_that_changes_nothing_lists_no_file_although_init_left_files_uncommitted(client, repo, model):
    init_leftovers(repo)
    s = new_session(client, repo, mode="edit")
    model.plans = [{}]
    started, s2 = ask(client, s["id"], "What does this project do? Change nothing.")
    d = answer_data(s2)
    assert d["turn"] == started["n"] and d["files"] == []
    assert turn_changes(client, s["id"], started["n"]) == []
    # the chat as a whole: KeelBot changed nothing, so /changes lists nothing either
    assert client.get(f"/helper/sessions/{s['id']}/changes").json() == []


def test_an_answer_that_changes_one_file_lists_only_that_file(client, repo, model):
    init_leftovers(repo)
    s = new_session(client, repo, mode="edit")
    model.plans = [{"src/scores/a.py": "A = 1\n"}, {"src/scores/b.py": "B = 1\n"}]
    first, s1 = ask(client, s["id"], "add a")
    assert answer_data(s1)["files"] == ["src/scores/a.py"]
    ch = turn_changes(client, s["id"], first["n"])
    assert [(c["path"], c["status"]) for c in ch] == [("src/scores/a.py", "added")] and "+A = 1" in ch[0]["diff"]
    second, s2 = ask(client, s["id"], "add b")
    assert answer_data(s2)["files"] == ["src/scores/b.py"]
    assert [c["path"] for c in turn_changes(client, s["id"], second["n"])] == ["src/scores/b.py"]
    # /changes: everything KeelBot changed in this chat, never the files init left
    assert [c["path"] for c in client.get(f"/helper/sessions/{s['id']}/changes").json()] == ["src/scores/a.py", "src/scores/b.py"]


def test_the_turn_diff_is_the_turns_own_not_the_whole_chats(client, repo, model):
    s = new_session(client, repo, mode="edit")
    model.plans = [{"src/scores/a.py": "A = 1\n"}, {"src/scores/a.py": "A = 2\n"}]
    ask(client, s["id"], "add a")
    second, _ = ask(client, s["id"], "change a")
    ch = turn_changes(client, s["id"], second["n"])
    assert [(c["path"], c["status"], c["added"], c["removed"]) for c in ch] == [("src/scores/a.py", "modified", 1, 1)]
    assert "-A = 1" in ch[0]["diff"] and "+A = 2" in ch[0]["diff"]


def test_a_side_answer_lists_the_file_it_changed_in_its_worktree(client, repo, model):
    s = new_session(client, repo, mode="side")
    model.plans = [{"src/scores/a.py": "A = 1\n"}, {}]
    first, s1 = ask(client, s["id"], "add a")
    assert answer_data(s1)["files"] == ["src/scores/a.py"]
    assert [c["path"] for c in turn_changes(client, s["id"], first["n"])] == ["src/scores/a.py"]
    second, s2 = ask(client, s["id"], "nothing more")
    assert answer_data(s2)["files"] == [] and turn_changes(client, s["id"], second["n"]) == []


def test_an_ask_answer_says_no_file_and_an_unknown_turn_lists_nothing(client, repo, model):
    s = new_session(client, repo)
    started, s1 = ask(client, s["id"], "Where does it start?")
    assert answer_data(s1)["files"] == []
    assert turn_changes(client, s["id"], started["n"]) == [] and turn_changes(client, s["id"], 99) == []
