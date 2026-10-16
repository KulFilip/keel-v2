"""Live text (models/stream.py): runners emit("delta", chunk) while the model writes; the runtime sends the text so
far as agent.delta / helper.delta at most every 80 ms; the whole message stays the step that is stored."""

import asyncio
import json

from keel_engine.models import api_runner, fake
from keel_engine.models.cli_runners import ClaudeStream
from keel_engine.models.stream import DeltaThrottle
from keel_engine.tools.agent_tools import ToolBox

from conftest import start, wait


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_throttle_sends_the_text_so_far_at_most_every_interval():
    clock, sent = Clock(), []
    th = DeltaThrottle(sent.append, interval=0.08, clock=clock)
    clock.t = 1.0
    th.add("Hel")                      # first chunk: sent at once
    th.add("lo ")                      # within 80 ms: kept
    clock.t = 1.05
    th.add("wor")
    assert [d["text"] for d in sent] == ["Hel"]
    clock.t = 1.2
    th.add("ld")
    assert sent[-1] == {"n": 2, "block": 0, "text": "Hello world"}
    th.add("!")
    th.reset()                         # the whole step arrived: what is left goes out, the next block starts
    assert sent[-1] == {"n": 3, "block": 0, "text": "Hello world!"}
    th.reset()                         # nothing new: nothing sent
    assert len(sent) == 3
    clock.t = 2
    th.add("Next")
    assert sent[-1] == {"n": 4, "block": 1, "text": "Next"}


def test_claude_partial_messages_become_deltas():
    got = []
    s = ClaudeStream(lambda kind, text="", **k: got.append((kind, text)), "/tmp")
    for line in [
        {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "The entry "}}},
        {"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "is main.py"}}},
        {"type": "stream_event", "event": {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{"}}},
        {"type": "stream_event", "event": {"type": "message_start"}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "The entry is main.py"}]}},
    ]:
        s.line(json.dumps(line))
    assert got == [("delta", "The entry "), ("delta", "is main.py"), ("text", "The entry is main.py")]


def test_fake_chunks_add_up_to_the_text():
    text = "You asked: where?\nThe package starts in `src/scores/__init__.py:1`."
    parts = fake.chunks(text)
    assert "".join(parts) == text and len(parts) > 3 and max(len(p) for p in parts) <= 16


def test_the_api_runner_streams_its_reply(monkeypatch):
    from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
    from langchain_core.messages import AIMessage

    model = GenericFakeChatModel(messages=iter([AIMessage(content="Ranks are kept in scores.py today")]))
    monkeypatch.setattr(api_runner, "chat_model", lambda *a, **k: model)

    async def no_mcp(*a, **k):
        return [], None

    monkeypatch.setattr(api_runner.mcp, "langchain_tools", no_mcp)
    tb = ToolBox.__new__(ToolBox)
    tb.langchain_tools = lambda: []
    req = api_runner.AgentRequest(agent="helper", system="", prompt="where?", root="/tmp", phase="none",
                                  model={"provider": "claude", "mode": "api", "model": "sonnet"}, toolbox=tb, key="k")
    steps = []
    res = asyncio.run(api_runner.APIRunner().run(req, lambda kind, text="", **k: steps.append((kind, text))))
    deltas = [t for k, t in steps if k == "delta"]
    assert len(deltas) > 2 and "".join(deltas) == "Ranks are kept in scores.py today"
    assert ("text", "Ranks are kept in scores.py today") in steps and res.text == "Ranks are kept in scores.py today"


def test_a_flow_agent_streams_agent_delta_and_stores_only_whole_steps(client, repo):
    tid = start(client, repo)
    wait(client, tid)
    evs = [e for e in client.bus.recent if e["thread_id"] == tid]
    deltas = [e for e in evs if e["type"] == "agent.delta"]
    assert deltas, "the fake agents stream their answers"
    d = deltas[0]
    assert d["call_id"] and d["step"] and set(d["data"]) == {"n", "block", "text"}
    # the delta's text is a start of the answer step of the same call
    answers = {e["call_id"]: e["data"]["text"] for e in evs if e["type"] == "agent.step" and e["data"]["kind"] == "answer"}
    last = {}
    for e in deltas:
        last[e["call_id"]] = e["data"]["text"]
    for cid, text in last.items():
        assert answers[cid].startswith(text)
    assert not any(e["type"] == "agent.step" and e["data"]["kind"] == "delta" for e in evs)
