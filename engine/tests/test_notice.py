"""0.18.55 readable notifications: the gate.waiting event carries short lines (summary) made from structured data,
the flow and the step's name; the full text stays the gate's detail."""

import asyncio

from conftest import start, to_loop, wait

from keel_engine.runtime import notice
from keel_engine.runtime.actions import ActionInput
from keel_engine.runtime.init_actions import init_summary


def test_hand_over_lines_are_short_facts_with_marks():
    assert notice.hand_over(3, 9, [], ["architecture", "domain", "conventions"], []) == [
        "✓ 3 setup checks passed · 9 skipped",
        "✓ Knowledge: architecture, domain, conventions",
    ]
    lines = notice.hand_over(1, 0, ["build", "tests"], [], ["architecture"])
    assert lines == ["✓ 1 setup check passed", "✗ 2 setup checks still fail: build, tests",
                     "⤼ Knowledge kept as it was: architecture"]


def test_init_summary_writes_the_short_lines_beside_the_full_text(tmp_path):
    rungs = [{"n": n, "name": f"rung{n}", "status": "pass" if n <= 3 else "skipped", "detail": "not needed", "cmd": "true"}
             for n in range(1, 13)]
    a = ActionInput(root=str(tmp_path), phase="setup", title="init", ac=None, acs=[], fake=True, flow="init",
                    init={"write_sections": ["architecture", "domain", "conventions"]}, state={"ladder": rungs})
    r = asyncio.run(init_summary(a))
    data = r.update["data"]
    assert data["hand_over_summary"] == ["✓ 3 setup checks passed · 9 skipped", "✓ Knowledge: architecture, domain, conventions"]
    # the long text stays for the Inbox
    assert "Setup ladder: 3 of 12 rungs passed" in data["hand_over_detail"]
    assert all("Layout" not in x and ".keel" not in x for x in data["hand_over_summary"])


def test_clip_cuts_whole_lines_and_never_a_word():
    long = "The order export writes every order of the shop as one CSV row with its customer and its total amount"
    assert notice.words(long, 40) == "The order export writes every order…"
    assert notice.clip(["a", "b", "c", "d", "e"]) == ["a", "b", "+3 more"]
    assert notice.clip(["", "  ", "one"]) == ["one"]
    assert notice.names(["a", "b", "c", "d", "e"]) == "a, b, c +2 more"


def test_gate_waiting_carries_the_flow_the_step_name_and_short_lines(client, repo):
    tid = start(client, repo)
    s = wait(client, tid)
    assert s["waiting"]["step"] == "spec_gate"
    ev = client.bus.of(tid, "gate.waiting")[-1]["data"]
    assert ev["flow"] == "feature" and ev["phase"] == "spec" and ev["step_name"]
    assert ev["summary"][0] == "◆ 2 acceptance criteria"
    assert len(ev["summary"]) <= 3 and ev["detail"]          # the full text stays the detail

    s = to_loop(client, tid)
    assert s["waiting"]["step"] == "ac_gate"
    ev = client.bus.of(tid, "gate.waiting")[-1]["data"]
    assert ev["ac"] == "AC-1"
    assert ev["summary"][0].startswith("◆ AC-1: ")
