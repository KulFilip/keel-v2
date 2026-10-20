"""0.18.28 a critic's gaps loop (a custom "scout" spike: critic GAPS: 9, then 10) loops back while rounds remain.

The real run stopped at the critic's findings gate: the critic was a reviewer agent, and a reviewer's blocking findings
went to "critic: N blocking findings" before the branch that reads GAPS ever ran.
"""
import itertools

import pytest

from conftest import decide, start, wait
from test_flows_base import answers, values, wf
from keel_engine.runtime import markers
from keel_engine.workflows.model import from_dict
from keel_engine.workflows.templates import get_template
from keel_engine.workflows.validate import validate

CRITIC_SAYS = ("Gaps:\n## Blocking\n- the ETA field is not confirmed\n- no sample payload\nGAPS: 9\nBLOCKING: yes",
               "Gaps:\n## Blocking\n- no sample payload\nGAPS: 0\nBLOCKING: no")


def scout(branch: dict, agent: str = "reviewer"):
    return wf([{"id": "research", "kind": "agent", "name": "research", "agent": "investigator", "phase": "spec"},
               {"id": "critic", "kind": "agent", "name": "critic", "agent": agent, "markers": ["GAPS"], "phase": "spec"},
               {"id": "gaps", "kind": "branch", "name": "gaps closed?", "no": "research", "rounds": 3, **branch},
               {"id": "decide", "kind": "gate", "name": "spike result", "phase": "spec"}], name="scout")


def critic(monkeypatch, said=CRITIC_SAYS):
    n = itertools.count()
    return answers(monkeypatch, {"reviewer": lambda r: said[min(next(n), len(said) - 1)]})


@pytest.mark.parametrize("when", [{"marker": "GAPS", "equals": "0", "step": "critic"},
                                  {"marker": "GAPS", "lte": 0, "step": "critic"}])
def test_a_critic_with_gaps_loops_back_once_then_stops_at_the_gate(client, repo, monkeypatch, when):
    seen = critic(monkeypatch)
    w = scout({"when": when})
    assert validate(w) == []
    tid = start(client, repo, workflow=w)
    s = wait(client, tid)
    assert s["waiting"]["step"] == "decide", s["waiting"]           # not the critic's findings gate
    assert [r.agent for r in seen] == ["investigator", "reviewer", "investigator", "reviewer"]
    v = values(client, tid)
    assert v["markers"]["critic"]["GAPS"] == "0"
    notes = [e["data"].get("note") or "" for e in client.bus.of(tid, "step.finished") if e["step"] == "gaps"]
    assert notes[0].startswith("gaps closed?: no (GAPS: 9); round 2 of 3"), notes
    assert not [e for e in client.bus.of(tid, "step.started") if e["step"] == "critic__fix"]


def test_past_its_rounds_the_loop_asks_and_still_never_the_findings_gate(client, repo, monkeypatch):
    critic(monkeypatch, said=(CRITIC_SAYS[0], CRITIC_SAYS[0].replace("GAPS: 9", "GAPS: 10")))
    tid = start(client, repo, workflow=scout({"when": {"marker": "GAPS", "equals": "0", "step": "critic"}}))
    s = wait(client, tid)
    assert s["waiting"]["step"] == "gaps" and "still no after 3 round(s)" in s["waiting"]["title"]
    assert "GAPS: 10" in s["waiting"]["detail"]


def test_the_spike_with_a_critic_step_loops(client, repo, monkeypatch):
    """spike.yaml with a critic between the findings and the report: the built-in steps and the loop together."""
    critic(monkeypatch)
    raw = get_template("spike").model_dump(exclude_none=True, by_alias=True)
    steps = raw["steps"]
    at = next(i for i, s in enumerate(steps) if s["id"] == "report")
    steps[at:at] = [{"id": "critic", "kind": "agent", "name": "critic", "agent": "reviewer", "model": "default",
                     "phase": "spec", "markers": ["GAPS"]},
                    {"id": "gaps", "kind": "branch", "name": "gaps closed?", "when": {"marker": "GAPS", "lte": 0, "step": "critic"},
                     "no": "research", "rounds": 2, "phase": "spec"}]
    w = from_dict({**raw, "id": "scout", "name": "scout", "steps": steps})
    assert validate(w) == []
    tid = start(client, repo, workflow=w)
    s = wait(client, tid)
    while s["status"] == "waiting" and s["waiting"]["step"] != "decide":
        s = decide(client, tid)
    assert s["waiting"]["step"] == "decide"
    started = [e["step"] for e in client.bus.of(tid, "step.started")]
    assert started.count("critic") == 2 and started.count("research") == 2


def test_when_compares_numbers_and_a_zero_text_is_not_set():
    assert markers.matches("9", {"gt": 0}) and markers.matches("9 (3 high, 6 low)", {"gte": 9})
    assert not markers.matches("0", {"gt": 0}) and markers.matches("0", {"lte": 0})
    assert not markers.matches("none", {"gt": 0})            # no number: does not hold
    assert not markers.matches("0", {"marker": "GAPS"})     # "GAPS: 0" is no gap
    assert markers.matches("3", {"marker": "GAPS"})
    assert markers.matches("0", {"marker": "GAPS", "equals": "0"})


def test_validate_names_a_when_key_keel_does_not_know():
    w = wf([{"id": "c", "kind": "agent", "name": "c", "agent": "reviewer", "markers": ["GAPS"]},
            {"id": "b", "kind": "branch", "name": "b", "when": {"marker": "GAPS", "above": 0}, "no": "c"}])
    assert any("when does not know above" in e for e in validate(w))
