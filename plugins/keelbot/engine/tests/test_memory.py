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
