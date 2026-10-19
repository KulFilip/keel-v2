"""keel 0.18.18 KeelBot when something fails (the person's report: "checkout the main and update" with uncommitted work;
`git checkout main` failed, KeelBot ran it again on every "fix it", offered no way out and ended with "I cannot").

The model is scripted (FakeRunner.run replaced): each turn runs real commands through the turn's own ToolBox, as the
API-key runner does, in a real git folder. What keel does around it is real: the prompt, the guard, the person's OK
(the permission cards, answered here through /helper/permissions), the repeat guard and what the next turn is told.
"""

import asyncio
import subprocess
import threading
import time
from pathlib import Path

import pytest

from keel_engine.models import fake as fake_mod
from keel_engine.models.base import AgentResult
from keel_plugin_keelbot import helper

FAKE = {"provider": "fake", "mode": "api", "model": "fake"}

QUESTIONS = """The checkout failed: your folder has uncommitted changes in README.md that main would overwrite.

```keel-questions
[{"id": "changes", "question": "What should I do with your uncommitted changes?", "why": "git cannot check out main over them",
  "options": [{"label": "Stash them, check out main, pull, then stash pop", "description": "nothing is lost", "recommended": true},
              {"label": "Commit them first on this branch"},
              {"label": "Discard them", "description": "git checkout -- README.md: they are lost"},
              {"label": "Leave it as it is"}]}]
```"""


def git(root, *args, check=True):
    r = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True)
    if check:
        assert r.returncode == 0, r.stderr
    return r.stdout.strip()


@pytest.fixture
def blocked(repo, tmp_path):
    """The person's folder: branch `work` with uncommitted changes in README.md, which main changed too; main has a
    remote (origin) with one commit more than the local main."""
    root = Path(repo)
    origin = tmp_path / "origin.git"
    git(tmp_path, "clone", "-q", "--bare", str(root), str(origin))
    git(root, "remote", "add", "origin", str(origin))
    git(root, "fetch", "-q", "origin")
    git(root, "branch", "-q", "-u", "origin/main", "main")
    other = tmp_path / "other"
    git(tmp_path, "clone", "-q", str(origin), str(other))
    body = "".join(f"line {i}\n" for i in range(1, 21))
    (root / "README.md").write_text("# Scores\n" + body)
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "a longer readme")
    git(root, "push", "-q", "origin", "main")
    git(other, "pull", "-q")
    (other / "CHANGELOG.md").write_text("- ranks\n")
    git(other, "add", "CHANGELOG.md")
    git(other, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "changelog")
    git(other, "push", "-q", "origin", "main")
    git(root, "checkout", "-q", "-b", "work")
    (root / "README.md").write_text("# Scores on the work branch\n" + body)
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "work")
    # the person's own unsaved line, far from the work branch's change: stash pop on main applies it cleanly
    (root / "README.md").write_text("# Scores on the work branch\n" + body + "the person's own unsaved line\n")
    return root


class Script:
    """The model, scripted: turn k runs `turns[k](req, emit)`."""

    def __init__(self, monkeypatch, *turns):
        self.turns, self.reqs = list(turns), []

        async def run(_self, req, emit):
            self.reqs.append(req)
            return await self.turns[len(self.reqs) - 1](req, emit)
        monkeypatch.setattr(fake_mod.FakeRunner, "run", run)


async def sh(req, emit, command):
    """A shell command through the turn's ToolBox, in a worker thread (as the API-key runner runs its tools)."""
    out = await asyncio.to_thread(req.toolbox.run_command, command)
    if not out.startswith("REFUSED"):
        emit("tool", command, tool="Bash", output=out, ok=out.startswith("exit 0"))
    return out


class Person:
    """Answers KeelBot's permission cards (what keel TUI and the dashboard show) and keeps what each card said."""

    def __init__(self, client, answer="once"):
        self.client, self.answer, self.cards, self.stop = client, answer, [], False
        self.t = threading.Thread(target=self.loop, daemon=True)
        self.t.start()

    def loop(self):
        while not self.stop:
            for q in self.client.get("/helper/permissions", params={"project": "demo"}).json():
                if any(c["id"] == q["id"] for c in self.cards):
                    continue
                self.cards.append(q)
                said = self.answer(q) if callable(self.answer) else self.answer
                self.client.post(f"/helper/permissions/{q['id']}", json={"decision": said[0], "why": said[1]}
                                 if isinstance(said, tuple) else {"decision": said})
            time.sleep(0.02)

    def done(self):
        self.stop = True
        self.t.join(5)
        return [c["command"] for c in self.cards]


def new_session(client, repo, mode):
    r = client.post("/helper/sessions", json={"project_id": "demo", "root": str(repo), "model": FAKE, "mode": mode})
    assert r.status_code == 200, r.text
    return r.json()


def turn(client, sid, text, **extra):
    r = client.post(f"/helper/sessions/{sid}/turn", json={"text": text, **extra})
    assert r.status_code == 200, r.text
    deadline = time.time() + 30
    while time.time() < deadline:
        s = client.get(f"/helper/sessions/{sid}").json()
        if not s["busy"] and s["status"] != "running":
            return s
        time.sleep(0.02)
    raise AssertionError("the turn did not end")


def steps(client, sid):
    return [e["data"] for e in client.bus.recent if e["thread_id"] == sid and e["type"] == "helper.step"]


def test_checkout_fails_on_uncommitted_changes_then_keelbot_asks_and_does_what_the_person_picked(client, blocked,
                                                                                                    monkeypatch):
    seen = {}

    async def first(req, emit):
        # the prompt tells it what to do when something fails, in every mode
        seen["prompt"], seen["system"] = req.prompt, req.system
        out = await sh(req, emit, "git checkout main")
        seen["checkout"] = out
        return AgentResult(text=QUESTIONS, tokens_in=10, tokens_out=10)

    async def second(req, emit):
        seen["prompt2"] = req.prompt
        # the very same command again, while nothing changed: refused, with what to do instead
        seen["again"] = await sh(req, emit, "git checkout main")
        for cmd in ("git stash", "git checkout main", "git pull", "git stash pop"):
            seen[cmd] = await sh(req, emit, cmd)
        return AgentResult(text="Done: stashed, on main, pulled, and your changes are back.", tokens_in=10, tokens_out=10)

    Script(monkeypatch, first, second)
    s = new_session(client, blocked, "edit")
    person = Person(client)
    s1 = turn(client, s["id"], "checkout the main and update")
    p = seen["prompt"]
    assert "never run the same thing again unchanged" in p and "keel-questions" in p and "say in one line why" in p
    assert "git stash" in helper.MODE_TEXT["edit"] and "never git commit them yourself" in seen["system"]
    assert seen["checkout"].startswith("exit 1") and "would be overwritten by checkout" in seen["checkout"]
    # the answer is a question card with the ways forward; what failed is kept for the next turn
    answer = s1["messages"][-1]
    assert answer["role"] == "helper" and "```keel-questions" in answer["text"]
    [failed] = answer["data"]["failed"]
    assert failed["command"] == "git checkout main" and failed["state"]          # the folder's git state then
    assert "would be overwritten by checkout" in answer["data"]["failed"][0]["said"]
    assert git(blocked, "rev-parse", "--abbrev-ref", "HEAD") == "work"

    # the person picks "stash" on the card (keel TUI sends the answers as the next message)
    s2 = turn(client, s["id"], "Answers to your questions:\n1. What should I do with your uncommitted changes?\n"
                               "   → Stash them, check out main, pull, then stash pop")
    assert "In your last answer these failed or were refused:\n- `git checkout main`: " in seen["prompt2"]
    assert seen["again"].startswith("REFUSED: This exact command failed before and nothing in the folder changed")
    assert all(seen[c].startswith("exit 0") for c in ("git stash", "git checkout main", "git pull", "git stash pop")), \
        {c: seen[c] for c in ("git stash", "git checkout main", "git pull", "git stash pop")}
    commands = person.done()
    # every command that changed something waited for the person's OK; the repeat never reached them
    assert commands == ["git checkout main", "git stash", "git checkout main", "git pull", "git stash pop"]
    always = {c["command"]: c.get("always") for c in person.cards}
    assert always["git checkout main"] == "git checkout *" and always["git stash pop"] == "git stash pop"
    assert not any(c.get("warning") for c in person.cards)               # nothing here throws work away
    assert git(blocked, "rev-parse", "--abbrev-ref", "HEAD") == "main"
    assert (blocked / "CHANGELOG.md").read_text() == "- ranks\n"          # pulled
    assert "the person's own unsaved line" in (blocked / "README.md").read_text()      # nothing lost
    assert s2["messages"][-1]["text"].startswith("Done: stashed")
    refused = [d for d in steps(client, s["id"]) if d["kind"] == "guard"]
    assert len(refused) == 1 and "failed before" in refused[0]["text"]


def test_a_destructive_command_always_asks_with_a_warning_and_a_deny_reason_comes_back(client, blocked, monkeypatch):
    seen = {}

    async def first(req, emit):
        seen["reset"] = await sh(req, emit, "git checkout -- README.md")
        seen["again"] = await sh(req, emit, "git checkout -- README.md")      # asked again: "always" never covers it
        return AgentResult(text="ok", tokens_in=1, tokens_out=1)

    Script(monkeypatch, first)
    s = new_session(client, blocked, "edit")
    person = Person(client, answer=lambda q: "always" if len(person.cards) == 1 else ("deny", "keep my line"))
    turn(client, s["id"], "throw my README change away")
    assert person.done() == ["git checkout -- README.md", "git checkout -- README.md"]
    assert all("uncommitted changes are lost" in c["warning"] for c in person.cards)
    assert not person.cards[0].get("always")                             # no "Allow in this chat" for it
    assert seen["reset"].startswith("exit 0")
    assert seen["again"].startswith("REFUSED: The person said no to this command: keep my line")
    assert client.get(f"/helper/sessions/{s['id']}").json()["grants"] == []


def test_a_flow_in_the_folder_is_warned_about_and_its_branch_is_not_keelbots(client, blocked, monkeypatch):
    seen = {}
    keel = {"flows": [{"thread_id": "t1", "title": "Player ranks", "status": "waiting", "where": "folder",
                       "branch": "keel/player-ranks"}]}

    async def first(req, emit):
        seen["prompt"] = req.prompt
        seen["flow"] = await sh(req, emit, "git switch keel/player-ranks")
        seen["stash"] = await sh(req, emit, "git stash")
        return AgentResult(text="ok", tokens_in=1, tokens_out=1)

    Script(monkeypatch, first)
    s = new_session(client, blocked, "edit")
    person = Person(client)
    turn(client, s["id"], "switch to the flow's branch", keel=keel)
    assert person.done() == ["git stash"]                       # the flow's branch is refused before any card
    assert "branch of a keel flow" in seen["flow"]
    assert 'A flow works in this folder ("Player ranks" waiting)' in person.cards[0]["warning"]
    assert 'A flow works in this project folder now ("Player ranks" waiting)' in seen["prompt"]


def test_ask_mode_refuses_in_its_own_words_and_says_how_to_go_on(client, blocked, monkeypatch):
    seen = {}

    async def first(req, emit):
        seen["prompt"], seen["system"] = req.prompt, req.system
        seen["checkout"] = await sh(req, emit, "git checkout main")
        return AgentResult(text="Ask mode is read only.", tokens_in=1, tokens_out=1)

    Script(monkeypatch, first)
    s = new_session(client, blocked, "ask")
    s1 = turn(client, s["id"], "checkout the main and update")
    out = seen["checkout"]
    assert out.startswith("REFUSED: KeelBot's Ask mode is read only: \"git checkout\" changes files or git.")
    assert "flow" not in out.split(".")[0] and "/mode edit" in out and "keel-questions" in out
    assert "/mode edit" in seen["prompt"] and "keel-questions" in seen["prompt"]
    assert "Fix mode can make it" not in seen["system"] and "/mode edit" in seen["system"]
    assert s1["messages"][-1]["data"]["failed"][0]["said"].startswith("REFUSED: KeelBot's Ask mode") or \
        s1["messages"][-1]["data"]["failed"][0]["said"].startswith("KeelBot's Ask mode")
    assert git(blocked, "rev-parse", "--abbrev-ref", "HEAD") == "work"
