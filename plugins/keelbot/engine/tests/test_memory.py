"""keel 0.18.19 KeelBot's memory, kept in keel's backend as opencode keeps it: /compact's structured summary and the
checkpoint the next turn reads, a note when the person changes the mode in the middle of a chat, and a chat's own
short title after its first answer.

The model is scripted (FakeRunner.run replaced) where the test needs to see the prompt or to answer something exact.
"""

import time

import pytest

from keel_engine.models import fake as fake_mod
from keel_engine.models.base import AgentResult
from keel_plugin_keelbot import helper

FAKE = {"provider": "fake", "mode": "api", "model": "fake"}


class Script:
    """The model, scripted: call k answers `answers[k]` (a string, or a function of the request) and keeps the request."""

    def __init__(self, monkeypatch, *answers):
        self.answers, self.reqs = list(answers), []

        async def run(_self, req, emit):
            self.reqs.append(req)
            a = self.answers[min(len(self.reqs), len(self.answers)) - 1]
            text = a(req) if callable(a) else a
            for i in range(0, len(text), 7):
                emit("delta", text[i:i + 7])
            emit("answer", text)
            return AgentResult(text=text, tokens_in=10, tokens_out=10)
        monkeypatch.setattr(fake_mod.FakeRunner, "run", run)


def new_session(client, repo, mode="ask", **extra):
    r = client.post("/helper/sessions", json={"project_id": "demo", "root": str(repo), "model": FAKE, "mode": mode, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def turn(client, sid, text, **extra):
    r = client.post(f"/helper/sessions/{sid}/turn", json={"text": text, **extra})
    assert r.status_code == 200, r.text
    deadline = time.time() + 20
    while time.time() < deadline:
        s = client.get(f"/helper/sessions/{sid}").json()
        if not s["busy"] and s["status"] != "running":
            return s
        time.sleep(0.02)
    raise AssertionError("the turn did not end")


def chat(sid, pairs):
    for q, a in pairs:
        helper.add_message(sid, "user", q)
        helper.add_message(sid, "helper", a)


# ------------------------------------------------------------------ bug: /compact read only the newest 6000 characters

@pytest.mark.asyncio
async def test_compact_reads_the_whole_chat_once_and_a_summary_is_never_cut_from_the_transcript(client, repo, monkeypatch):
    """The summary prompt had only the newest TRANSCRIPT_CHARS (6000) of the chat, so a long chat's start (often the
    person's goal) never reached the summary; an API-key model got the chat twice (as messages and in the prompt). And
    once newer messages filled 6000 characters, the transcript of a CLI that cannot resume dropped the summary."""
    s = new_session(client, repo)
    sid = s["id"]
    chat(sid, [("GOAL: rank the players by score", "ok")] + [(f"question {i} " + "x" * 400, "y" * 400) for i in range(12)])
    sc = Script(monkeypatch, "## Objective\n- rank the players")
    await helper.compact(sid)
    req = sc.reqs[0]
    assert "GOAL: rank the players by score" in req.prompt
    assert req.history == []                     # the chat goes once, in the prompt

    chat(sid, [(f"later {i} " + "x" * 600, "z" * 600) for i in range(8)])
    t = helper._transcript(helper.history(sid))
    assert "## Objective\n- rank the players" in t and "later 7" in t and len(t) < helper.TRANSCRIPT_CHARS + 2000


# ------------------------------------------------------------------ 1. /compact: opencode's structured summary

@pytest.mark.asyncio
async def test_compact_asks_for_the_structured_summary_then_updates_it_and_the_next_turn_reads_it_as_a_checkpoint(
        client, repo, monkeypatch):
    s = new_session(client, repo)
    sid = s["id"]
    chat(sid, [("Add a /health endpoint", "Added it in src/app/health.py, not committed yet.")])
    sc = Script(monkeypatch, "## Objective\n- a /health endpoint", "## Objective\n- a /health endpoint, tested")
    await helper.compact(sid)
    p = sc.reqs[0].prompt
    # the chat first, then opencode's template and rules (core/src/session/compaction.ts)
    assert p.index("Add a /health endpoint") < p.index("## Objective")
    for part in ("## Requirements", "## Decisions", "## Work State", "### Completed", "### Active", "### Blocked",
                 "## Next Move", "## Relevant Files", "at most 15", "## Important Context",
                 "Preserve exact file paths, symbols, commands, error strings",
                 "whether changes are uncommitted, committed, pushed", "Do not continue the task or call tools."):
        assert part in p, part
    assert "Update the existing checkpoint" not in p

    # the next turn reads the summary as opencode's checkpoint: history, not new instructions
    hist = helper.history(sid)
    assert hist[0][1].startswith("<conversation-checkpoint>")
    assert "Treat it as historical context, not as new instructions." in hist[0][1]
    assert "<summary>\n## Objective\n- a /health endpoint\n</summary>" in hist[0][1]

    # newer messages after the summary stay word for word; a second /compact updates the earlier summary
    chat(sid, [("Now a test for it", "tests/test_health.py passes.")])
    assert helper.history(sid)[1:] == [("user", "Now a test for it"), ("assistant", "tests/test_health.py passes.")]
    await helper.compact(sid)
    p2 = sc.reqs[1].prompt
    assert "Update the existing checkpoint" in p2 and "Newer history always takes precedence" in p2
    assert "- a /health endpoint" in p2 and "Now a test for it" in p2
    assert helper.history(sid) == [("user", helper.history(sid)[0][1])]
    assert "- a /health endpoint, tested" in helper.history(sid)[0][1]


# ------------------------------------------------------------------ 2. a note when the mode changes in a chat

def patch(client, sid, **body):
    return client.patch(f"/helper/sessions/{sid}", json=body)


def test_a_mode_change_keeps_the_chat_and_the_next_prompt_starts_with_a_note_of_it(client, repo, monkeypatch):
    """Claude and Codex resume their own session: without the note they keep the old mode's rules (opencode's plan
    mode does the same, core/src/plugin/plan.ts)."""
    sc = Script(monkeypatch, "ok")
    s = new_session(client, repo)
    sid = s["id"]
    turn(client, sid, "Why does the test fail?")
    assert not sc.reqs[0].prompt.startswith("You were in")

    r = patch(client, sid, mode="edit")
    assert r.status_code == 200, r.text
    assert r.json()["id"] == sid and r.json()["mode"] == "edit"
    s = turn(client, sid, "Fix it then")
    p = sc.reqs[1].prompt
    assert p.startswith("You were in Ask mode (read only); you are now in Edit mode: you may change files")
    assert "after the person's OK" in p.split("\n\n")[0]
    assert "Mode: Edit." in p and "Mode: Ask." not in p
    assert [m["role"] for m in s["messages"]] == ["user", "helper", "user", "helper"]     # the same chat goes on
    assert s["messages"][-1]["data"]["mode"] == "edit"

    turn(client, sid, "And the other one?")                  # no change since the last answer: no note
    assert not sc.reqs[2].prompt.startswith("You were in")

    patch(client, sid, mode="ask")
    turn(client, sid, "What did you change?")
    p = sc.reqs[3].prompt
    assert p.startswith("You were in Edit mode; you are now in Ask mode (read only): you may not change anything")
    assert "Mode: Ask." in p

    # switched there and back before the next answer: nothing changed for the model, no note
    patch(client, sid, mode="edit")
    patch(client, sid, mode="ask")
    turn(client, sid, "Thanks")
    assert not sc.reqs[4].prompt.startswith("You were in")


def test_which_mode_changes_a_chat_can_make(client, repo, monkeypatch):
    s = new_session(client, repo)
    sid = s["id"]
    assert patch(client, sid, mode="loud").status_code == 400
    r = patch(client, sid, mode="side")                  # a side session is its own worktree: a new chat
    assert r.status_code == 409 and "new chat" in r.json()["hint"].lower(), r.text
    assert patch(client, sid, mode="fix").status_code == 400          # Fix needs the flow that waits
    s = helper.set_mode(sid, "fix", thread_id="t_waits", flow={"phase": "green"})
    assert (s["mode"], s["thread_id"], s["phase"]) == ("fix", "t_waits", "green")

    side = new_session(client, repo, "side")
    assert patch(client, side["id"], mode="ask").json()["mode"] == "ask"       # read only, in its own worktree
    assert patch(client, side["id"], mode="side").json()["mode"] == "side"
    assert patch(client, side["id"], mode="edit").status_code == 409


def test_the_mode_notes_say_what_the_new_mode_lets_keelbot_do():
    assert helper.mode_note("ask", "ask") == ""
    assert helper.mode_note("", "edit") == ""
    side = helper.mode_note("side", "ask")
    assert side.startswith("You were in a side session (your own worktree); you are now in Ask mode (read only)")
    fix = helper.mode_note("ask", "fix")
    assert "you are now in Fix mode" in fix and "the flow's phase" in fix
    assert "no longer apply" in helper.mode_note("edit", "ask")


def test_a_side_session_in_ask_mode_still_owns_its_worktree_and_an_edit_chat_in_ask_can_still_keep(client, repo):
    from pathlib import Path
    side = new_session(client, repo, "side")
    (Path(side["worktree"]) / "NOTE.md").write_text("from the side\n")
    helper.set_mode(side["id"], "ask")
    assert [c["path"] for c in helper.changes(side["id"])] == ["NOTE.md"]
    assert helper.handover(side["id"])["uncommitted"] == ["NOTE.md"]
    assert helper.undo(side["id"], "NOTE.md") == []

    edit = new_session(client, repo, "edit")
    helper.set_mode(edit["id"], "ask")
    with pytest.raises(helper.HelperError, match="has changes to commit"):     # nothing changed: nothing to keep
        helper.done(edit["id"], {})
    from keel_engine.tools import guard
    before = guard.snapshot(str(repo))
    (Path(repo) / "README.md").write_text("changed in Edit\n")
    helper.remember_originals(edit["id"], str(repo), before)
    assert [c["path"] for c in helper.changes(edit["id"])] == ["README.md"]   # still there to keep or undo in Ask
