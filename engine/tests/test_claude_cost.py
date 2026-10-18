"""The cost keel books for a claude run is that run's own, also when keel continues (--resume) the step's session.

claude's result carries total_cost_usd as the session's running total: a resumed session starts from the total its
transcript saved ("cost-state" lines in <CLAUDE_CONFIG_DIR>/projects/<folder>/<session>.jsonl, Claude Code 2.1). Its
`usage` tokens are the run's own. An e2e feature flow (sonnet, subscription) summed those running totals and booked
$1546.98 for tokens worth about $33 at API prices.
"""
import json
import stat
import sys

import pytest

from keel_engine.models.base import AgentRequest, ModelError
from keel_engine.models.cli_runners import ClaudeCLIRunner, run_cost, session_cost
from keel_engine.runtime.compiler import run_or_continue
from keel_engine.tools.agent_tools import ToolBox

# Sonnet's API prices, USD per million tokens: input, cache write (5 min), cache read, output.
IN, WRITE, READ, OUT = 3.0, 3.75, 0.30, 15.0


def priced(u: dict) -> float:
    return (u["input_tokens"] * IN + u["cache_creation_input_tokens"] * WRITE + u["cache_read_input_tokens"] * READ
            + u["output_tokens"] * OUT) / 1e6


def fake_claude(tmp_path):
    """A claude that keeps the running total like Claude Code: --resume starts from the transcript's last cost-state,
    the result carries the session total, the run's own usage, and a cost-state line is saved at the end. Each run
    takes the next entry of runs.json ({usage, fail?})."""
    f = tmp_path / "claude"
    f.write_text(f"""#!{sys.executable}
import json, os, sys
sys.stdin.read()
argv = sys.argv[1:]
resume = "--resume" in argv
sid = argv[argv.index("--resume" if resume else "--session-id") + 1]
runs = json.load(open({str(tmp_path / "runs.json")!r}))
n_file = {str(tmp_path / "n")!r}
n = int(open(n_file).read()) if os.path.exists(n_file) else 0
open(n_file, "w").write(str(n + 1))
run = runs[n]
folder = os.path.join(os.environ["CLAUDE_CONFIG_DIR"], "projects", "-work-repo")
os.makedirs(folder, exist_ok=True)
transcript = os.path.join(folder, sid + ".jsonl")
total = 0.0
if resume and os.path.exists(transcript):
    for line in open(transcript):
        ev = json.loads(line)
        if ev.get("type") == "cost-state":
            total = ev["totalCostUSD"]
u = run["usage"]
total += (u["input_tokens"] * {IN} + u["cache_creation_input_tokens"] * {WRITE} + u["cache_read_input_tokens"] * {READ}
          + u["output_tokens"] * {OUT}) / 1e6
with open(transcript, "a") as t:
    t.write(json.dumps({{"type": "user", "sessionId": sid, "message": {{"content": "go"}}}}) + "\\n")
    t.write(json.dumps({{"type": "cost-state", "sessionId": sid, "totalCostUSD": total,
                         "modelUsage": {{"claude-sonnet": {{"costUSD": total}}}}}}) + "\\n")
if run.get("fail"):
    print(json.dumps({{"type": "result", "subtype": "error_max_turns", "is_error": True, "num_turns": 30,
                      "total_cost_usd": total, "usage": u}}))
    sys.exit(1)
print(json.dumps({{"type": "result", "subtype": "success", "is_error": False, "result": "done",
                  "total_cost_usd": total, "usage": u}}))
""")
    f.chmod(f.stat().st_mode | stat.S_IEXEC)
    return str(f)


def runs(tmp_path, items):
    (tmp_path / "runs.json").write_text(json.dumps(items))


def req(root, **kw):
    return AgentRequest(agent="implementer", system="", prompt="go", root=str(root), phase="green",
                        model={"provider": "claude", "mode": "subscription", "model": "sonnet"},
                        toolbox=ToolBox(str(root), "green"), workdir=str(root), **kw)


@pytest.fixture
def claude(tmp_path, monkeypatch):
    monkeypatch.setenv("KEEL_DATA", str(tmp_path / "data"))
    monkeypatch.setenv("KEEL_CLAUDE_BIN", fake_claude(tmp_path))
    (tmp_path / "repo").mkdir()
    return tmp_path / "repo"


def usage(i, cw, cr, o):
    return {"input_tokens": i, "cache_creation_input_tokens": cw, "cache_read_input_tokens": cr, "output_tokens": o}


def test_run_cost_takes_the_saved_total_away():
    assert run_cost(31.25, 30.0) == 1.25
    assert run_cost(0.4, None) == 0.4 and run_cost(0.4, 0.0) == 0.4
    assert run_cost(0.4, 30.0) == 0.4            # claude did not carry the saved total over (a /clear): all its own
    assert run_cost(None, 2.0) == 0.0


def test_session_cost_reads_the_last_cost_state(tmp_path, monkeypatch):
    monkeypatch.setenv("KEEL_DATA", str(tmp_path / "data"))
    assert session_cost("s-1") is None and session_cost(None) is None
    folder = tmp_path / "data" / "agent-home" / "claude" / "projects" / "-work-repo"
    folder.mkdir(parents=True)
    # line shapes from a real Claude Code 2.1 transcript
    (folder / "s-1.jsonl").write_text("\n".join(json.dumps(x) for x in [
        {"type": "user", "sessionId": "s-1", "message": {"content": "go"}},
        {"type": "cost-state", "sessionId": "s-1", "totalCostUSD": 0.091331, "hasUnknownModelCost": False},
        {"type": "assistant", "sessionId": "s-1", "message": {"content": [{"type": "text", "text": "cost-state"}]}},
        {"type": "cost-state", "sessionId": "s-1", "totalCostUSD": 0.214155, "hasUnknownModelCost": False},
        {"type": "last-prompt", "sessionId": "s-1", "lastPrompt": "go"},
    ]) + "\n")
    assert session_cost("s-1") == 0.214155
    (folder / "s-2.jsonl").write_text(json.dumps({"type": "user", "sessionId": "s-2"}) + "\n")
    assert session_cost("s-2") is None


async def test_a_resumed_session_books_each_runs_own_cost(claude, tmp_path):
    """The e2e numbers: 628,034 tokens in, 107,311 out and 96,452,813 cache reads over 16 runs of one session (a step
    sent back again and again) are about $33 at Sonnet's prices; summing claude's running totals booked 8.5 times that."""
    per = usage(39_252 - 30_000, 30_000, 6_028_300, 6_707)
    n = 16
    runs(tmp_path, [{"usage": per}] * n)
    got = [await ClaudeCLIRunner().run(req(claude, session="s-1", resume=i > 0), lambda *a, **k: None) for i in range(n)]
    one = priced(per)
    assert all(r.cost_usd == pytest.approx(one, abs=1e-5) for r in got)
    assert sum(r.cost_usd for r in got) == pytest.approx(n * one, abs=1e-4)
    assert 30 < sum(r.cost_usd for r in got) < 36
    # the tokens are the run's own: no running totals there
    assert all((r.tokens_in, r.tokens_out, r.tokens_cached) == (39_252, 6_707, 6_028_300) for r in got)
    assert sum(r.tokens_cached for r in got) == n * 6_028_300


async def test_a_failed_resumed_run_counts_only_its_own_cost(claude, tmp_path):
    first, second = usage(100, 9_000, 500_000, 2_000), usage(50, 1_000, 800_000, 3_000)
    runs(tmp_path, [{"usage": first}, {"usage": second, "fail": True}])
    await ClaudeCLIRunner().run(req(claude, session="s-1"), lambda *a, **k: None)
    with pytest.raises(ModelError) as e:
        await ClaudeCLIRunner().run(req(claude, session="s-1", resume=True), lambda *a, **k: None)
    assert e.value.max_turns
    assert e.value.usage["cost_usd"] == pytest.approx(priced(second), abs=1e-5)
    assert e.value.usage["tokens_cached"] == 800_000


async def test_out_of_turns_then_continue_counts_each_run_once(claude, tmp_path):
    """run_or_continue adds the cut-off run's use to the continued run's result; the continued run's running total
    already held the cut-off run's cost."""
    cut, cont = usage(100, 20_000, 1_000_000, 4_000), usage(20, 2_000, 1_200_000, 1_500)
    runs(tmp_path, [{"usage": cut, "fail": True}, {"usage": cont}])
    res = await run_or_continue(ClaudeCLIRunner(), req(claude, session="s-7"), lambda *a, **k: None, True,
                                lambda: {"session": "s-7"})
    assert res.cost_usd == pytest.approx(priced(cut) + priced(cont), abs=1e-5)
    assert res.tokens_cached == 2_200_000 and res.tokens_in == 22_120 and res.tokens_out == 5_500
