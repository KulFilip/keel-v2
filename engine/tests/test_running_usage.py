"""0.18.17 an agent's usage while it runs: the runner reports it (Claude Code's stream-json has usage on every assistant
message), the engine sends agent.usage, the thread's view and the token cap see it before agent.finished books it."""
import json

from conftest import start, wait
from keel_engine.models.cli_runners import ClaudeStream
from keel_engine.runtime.compiler import running_usage
from keel_engine.workflows.model import from_dict
from test_agent_memory import _claude
from test_v02 import script

CLAUDE = {"default": {"provider": "claude", "mode": "subscription", "model": "haiku"}}
ONE = from_dict({"name": "one", "keel_rules": False,
                 "steps": [{"id": "impl", "kind": "agent", "name": "implement", "agent": "explorer", "phase": "spec"}]})


def assistant(mid, text, **usage):
    """An assistant line in the shape claude 2.1 prints (one line per content block, all with the message's usage)."""
    return {"type": "assistant", "message": {"id": mid, "role": "assistant", "content": [{"type": "text", "text": text}],
                                             "usage": {"input_tokens": 9, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
                                                       "output_tokens": 1, "service_tier": "standard", **usage}}}


TURNS = [
    assistant("msg_01", "Reading the code.", input_tokens=3, cache_creation_input_tokens=13_605, cache_read_input_tokens=22_383, output_tokens=6),
    assistant("msg_01", "Still the same message.", input_tokens=3, cache_creation_input_tokens=13_605, cache_read_input_tokens=22_383, output_tokens=6),
    assistant("msg_02", "Editing.", input_tokens=5, cache_creation_input_tokens=1_000, cache_read_input_tokens=35_988, output_tokens=420),
]
RESULT = {"type": "result", "result": "done", "total_cost_usd": 0.05,
          "usage": {"input_tokens": 8, "cache_creation_input_tokens": 14_605, "cache_read_input_tokens": 58_371, "output_tokens": 430}}


def test_the_claude_stream_reports_the_runs_usage_so_far_once_per_change():
    seen = []
    s = ClaudeStream(lambda kind, text="", **kw: seen.append(kw) if kind == "usage" else None, "/tmp")
    for line in TURNS:
        s.line(json.dumps(line))
    # the second line of msg_01 repeats its numbers: no new report, and it is not counted twice
    assert seen == [{"tokens_in": 13_608, "tokens_out": 6, "tokens_cached": 22_383},
                    {"tokens_in": 14_613, "tokens_out": 426, "tokens_cached": 58_371}]


def test_partial_messages_count_too_and_a_message_keeps_its_largest_numbers():
    seen = []
    s = ClaudeStream(lambda kind, text="", **kw: seen.append(kw) if kind == "usage" else None, "/tmp")
    start_ev = {"type": "stream_event", "event": {"type": "message_start", "message": {"id": "msg_07", "usage": {
        "input_tokens": 4, "cache_creation_input_tokens": 200, "cache_read_input_tokens": 9_000, "output_tokens": 1}}}}
    delta = {"type": "stream_event", "event": {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 350}}}
    for line in (start_ev, delta, assistant("msg_07", "x", input_tokens=4, cache_creation_input_tokens=200,
                                            cache_read_input_tokens=9_000, output_tokens=12)):
        s.line(json.dumps(line))
    assert seen[-1] == {"tokens_in": 204, "tokens_out": 350, "tokens_cached": 9_000}
    assert len(seen) == 2          # the assistant line's smaller output count changed nothing


def test_running_usage_adds_the_calls_that_still_run():
    u = running_usage({"tokens_in": 10, "tokens_out": 5, "cap_tokens": 100}, {"c1": {"tokens_in": 7, "tokens_cached": 30}})
    assert u == {"tokens_in": 17, "tokens_out": 5, "tokens_cached": 30, "cap_tokens": 100}


def test_a_flow_sends_agent_usage_while_the_agent_runs_and_warns_past_the_cap(client, repo, tmp_path, monkeypatch):
    monkeypatch.setenv("KEEL_FAKE", "0")
    monkeypatch.setenv("KEEL_CLAUDE_BIN", _claude(tmp_path, [*TURNS, RESULT]))
    tid = start(client, repo, workflow=ONE, models=CLAUDE, settings={"gates_mode": "every-ac", "cap_tokens": 10_000, "on_cap": "pause"})
    s = wait(client, tid)
    assert s["status"] == "done", s
    [first, *_] = client.bus.of(tid, "agent.usage")             # sent at once, then at most every 15 s
    assert first["call_id"] and first["data"]["tokens_in"] == 13_608 and first["data"]["agent"] == "explorer"
    started = client.bus.of(tid, "agent.started")[0]
    assert first["call_id"] == started["call_id"]
    [warn] = [e["data"] for e in client.bus.of(tid, "budget.warn") if e["data"].get("running")]
    assert warn["cap"] == 10_000 and warn["used"] >= 10_000 and "still runs" in warn["detail"]
    done = client.bus.of(tid, "agent.finished")[-1]["data"]
    assert done["tokens_in"] == 14_613 and done["tokens_out"] == 430      # the result's numbers win at the end


def test_a_run_that_dies_without_a_result_still_books_its_usage_so_far(client, repo, tmp_path, monkeypatch):
    monkeypatch.setenv("KEEL_FAKE", "0")
    (tmp_path / "claude.out").write_text("\n".join(json.dumps(x) for x in TURNS) + "\n")
    monkeypatch.setenv("KEEL_CLAUDE_BIN", script(tmp_path, "claude", f"cat > /dev/null\ncat {tmp_path}/claude.out\nexit 1\n"))
    tid = start(client, repo, workflow=ONE, models=CLAUDE)
    s = wait(client, tid)
    assert s["status"] == "waiting" and s["waiting"]["kind"] == "fix", s
    failed = client.bus.of(tid, "agent.finished")[-1]["data"]
    assert failed["status"] == "failed" and failed["tokens_in"] == 14_613 and failed["tokens_cached"] == 58_371
