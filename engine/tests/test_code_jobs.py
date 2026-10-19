"""keel 0.18.15: a code step is a job like an agent's, so the person sees what runs while it runs (code.* events the api
stores as a job, like an agent's), and the ladder reports each rung live."""
from pathlib import Path

from conftest import decide, start, wait
from keel_engine.runtime import ladder
from test_flows_base import answers
from test_flows_init import SETTINGS, to


def test_a_code_step_runs_as_a_job_with_live_lines(client, repo, monkeypatch):
    answers(monkeypatch, {})
    tid = start(client, repo, workflow="init", title="keel init", settings={**SETTINGS, "fast": True})
    s = to(client, tid, wait(client, tid), "questions")
    to(client, tid, decide(client, tid), "audit_now")

    started = [e for e in client.bus.of(tid, "code.started")]
    assert started, "the code steps emit code.started"
    first = started[0]
    assert first["data"]["agent"] == "keel" and first["data"]["provider"] == "keel" and first["data"]["name"]
    calls = {e["call_id"] for e in started}
    lines = [e for e in client.bus.of(tid, "code.step") if e.get("call_id") in calls]
    assert lines and all(e["data"]["job"] == "code" for e in lines)
    assert any(e["data"]["text"].startswith("▶ ") for e in lines)                  # each action says it starts
    assert any("ms" in e["data"] and "ok" in e["data"] for e in lines)              # and how it ended
    finished = {e["call_id"]: e["data"] for e in client.bus.of(tid, "code.finished") if e.get("call_id") in calls}
    assert set(finished) == calls, "every code job ends"
    assert all(d["kind"] == "code" and d["tokens_in"] == 0 and d["status"] in ("done", "failed") for d in finished.values())


def test_the_ladder_reports_each_rung_as_it_runs(repo):
    (Path(repo) / ".keel").mkdir(exist_ok=True)
    (Path(repo) / ".keel" / "config.yml").write_text("commands:\n  api_compile: 'true'\n  unit_tests: 'false'\n")
    lines = []

    def runner(root, cmd):
        return (0, "ok") if cmd == "true" else (1, "boom")

    ok, rungs = ladder.run(repo, False, runner, progress=lambda text, **f: lines.append((text, f)))
    ran = [r for r in rungs if r["status"] in ("pass", "fail") and r.get("cmd") in ("true", "false")]
    assert ran
    for r in ran:
        mine = [(t, f) for t, f in lines if f.get("command") == r["cmd"]]
        assert len(mine) == 2, "a line when the command starts and one when it ends"
        (t0, f0), (t1, f1) = mine
        assert t0.startswith(f"rung {r['n']}/") and "$ " + r["cmd"] in t0 and "ok" not in f0
        assert f1["ok"] is (r["status"] == "pass") and isinstance(f1["ms"], int)
    assert any("failed (exit 1)" in t for t, _ in lines)


def test_code_jobs_leave_the_agent_events_to_agents(client, repo, monkeypatch):
    answers(monkeypatch, {})
    tid = start(client, repo, workflow="init", title="keel init", settings={**SETTINGS, "fast": True})
    to(client, tid, wait(client, tid), "questions")
    to(client, tid, decide(client, tid), "audit_now")
    assert client.bus.of(tid, "code.started")
    assert all((e.get("data") or {}).get("agent") != "keel" for e in client.bus.of(tid, "agent.started"))
