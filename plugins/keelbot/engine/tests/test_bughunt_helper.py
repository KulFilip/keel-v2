"""Bug hunt: KeelBot's turn start (busy before the first await), the turn's setup inside the try, a per-file undo that
keeps the person's later edit, and Done holding the chat busy."""

import asyncio
import threading
import time
from pathlib import Path

import pytest

from keel_engine.events import EventBus
from keel_plugin_keelbot import helper

from test_helper import FAKE, new_session
from test_turn_undo import ScriptRunner  # noqa: F401  (the fixture below uses it)


def _runner_and_session(repo, mode="edit"):
    runner = helper.HelperRunner(EventBus())
    s = helper.create("demo", str(repo), mode=mode, model=FAKE)
    return runner, s["id"]


@pytest.mark.asyncio
async def test_a_second_message_during_the_compact_waits_and_never_starts_a_second_answer(client, repo, monkeypatch):
    runner, sid = _runner_and_session(repo)
    s = helper.get(sid, messages=False)
    helper.update(sid, ctx_tokens=int(s["ctx_window"] * 0.95))
    real = helper.compact

    async def slow_compact(x, keys=None):
        await asyncio.sleep(0.2)
        return await real(x, keys)

    monkeypatch.setattr(helper, "compact", slow_compact)
    first, second = await asyncio.gather(runner.turn(sid, {"text": "one"}), _later(runner, sid))
    assert not first.get("queued")
    assert second.get("queued") is True, second
    for t in list(runner.tasks.values()):
        await asyncio.gather(t, return_exceptions=True)


async def _later(runner, sid):
    await asyncio.sleep(0.05)               # the first turn is awaiting compact() now
    return await runner.turn(sid, {"text": "two"})


@pytest.mark.asyncio
async def test_an_error_in_the_turns_setup_ends_the_turn_as_failed_and_frees_its_keys(client, repo, monkeypatch):
    runner, sid = _runner_and_session(repo, mode="edit")

    def boom(*a, **k):
        raise RuntimeError("push gate exploded")

    monkeypatch.setattr(helper, "push_blockers_for", boom)
    await runner.turn(sid, {"text": "go"})
    await asyncio.gather(*runner.tasks.values(), return_exceptions=True)
    s = helper.get(sid, messages=False)
    assert s["status"] == "failed" and "exploded" in (s["error"] or ""), s
    assert not runner.ask_keys and not runner.turn_keel and not runner.busy(sid)


@pytest.fixture
def model(monkeypatch):
    r = ScriptRunner()
    monkeypatch.setattr(helper.models, "runner_for", lambda _m: r)
    return r


def test_undoing_one_file_keeps_what_the_person_wrote_after_the_answer(client, repo, model):
    s = new_session(client, repo, mode="edit")
    sid = s["id"]
    model.plans.append({"src/scores/mine.py": "x = 1\n"})
    client.post(f"/helper/sessions/{sid}/turn", json={"text": "add it"})
    deadline = time.time() + 20
    while client.get(f"/helper/sessions/{sid}").json()["busy"] and time.time() < deadline:
        time.sleep(0.02)
    f = Path(repo) / "src" / "scores" / "mine.py"
    f.write_text("x = 1\n# the person's own line\n")
    with pytest.raises(helper.HelperError) as exc:
        helper.undo(sid, "src/scores/mine.py")
    assert exc.value.status == 409
    assert "the person's own line" in f.read_text()
    f.write_text("x = 1\n")                       # back as KeelBot left it: the undo works
    assert helper.undo(sid, "src/scores/mine.py") == [] and not f.exists()


def test_done_holds_the_chat_busy_so_a_message_sent_meanwhile_waits(client, repo, monkeypatch):
    s = new_session(client, repo, mode="edit")
    sid = s["id"]
    started = threading.Event()

    def slow_done(*a, **k):
        started.set()
        time.sleep(0.5)
        return {"ok": True}

    monkeypatch.setattr(helper, "done", slow_done)
    out = {}
    t = threading.Thread(target=lambda: out.update(client.post(f"/helper/sessions/{sid}/done", json={"flow": {}}).json()))
    t.start()
    assert started.wait(5)
    r = client.post(f"/helper/sessions/{sid}/turn", json={"text": "while checks run"})
    assert r.status_code == 200 and r.json().get("queued") is True, r.text
    t.join()
    assert out == {"ok": True}
