"""The Supervisor's switches: keel-wide (off by default: nothing listens, nothing runs), per project, per flow, the
plugin's own switch per project, and turning any of them off while it looks (the look stops, nothing is answered)."""

import json
import time

import pytest

from conftest import start, wait
from keel_engine.runtime import side_usage
from keel_engine.workflows.model import from_dict
from keel_plugin_supervisor import ledger, verdict

SETTINGS = {"gates_mode": "every-ac", "cap_tokens": 0, "on_cap": "pause", "plugins": ["supervisor"]}
GOOD = {"action": "answer", "decision": "approve", "why": "matches the spec", "confidence": "high",
        "evidence": ["knowledge:conventions"], "summary": "Looks right."}
GATED = [{"id": "a1", "kind": "agent", "name": "work", "agent": "implementer", "phase": "green"},
         {"id": "g1", "kind": "gate", "name": "check", "phase": "green"},
         {"id": "a2", "kind": "agent", "name": "more", "agent": "implementer", "phase": "green"}]


@pytest.fixture(autouse=True)
def script(tmp_path, monkeypatch):
    p = tmp_path / "sup.json"
    p.write_text(json.dumps(GOOD))
    monkeypatch.setenv("KEEL_FAKE_SUPERVISOR", str(p))
    verdict.reset_fake()


def sup_of(client):
    return client.app.state.supervisor


def call(client, fn):
    return client.portal.call(fn)


def switch(client, keel=None, **projects):
    return call(client, lambda: sup_of(client).set_switch(keel, projects or None))


def idle(client):
    call(client, sup_of(client).idle)


def flow(client, repo, sup=None, **settings):
    s = {**SETTINGS, **settings}
    if sup is not None:
        s["supervisor"] = sup
    tid = start(client, repo, workflow=from_dict({"name": "sw", "keel_rules": False, "steps": GATED}), settings=s)
    st = wait(client, tid)
    assert st["status"] == "waiting", st
    idle(client)
    return tid


def looked(client, tid):
    return ledger.list_rows(thread_id=tid)


def test_off_by_default_nothing_listens_and_nothing_runs(client, repo):
    sup = sup_of(client)
    assert sup.active is False and sup._hear not in client.bus._listeners
    tid = flow(client, repo, sup={"on": True, "mode": "act"})
    assert wait(client, tid)["status"] == "waiting"
    assert looked(client, tid) == [] and side_usage.of_source(tid, "supervisor")["tokens"] == 0
    assert not [e for e in client.bus.of(tid) if e["type"].startswith("supervisor.") and e["type"] != "supervisor.settings"]
    v = client.get(f"/threads/{tid}/supervisor").json()["settings"]
    assert v["on"] is False and v["switches"]["off_by"] == "keel"


def test_the_keel_wide_switch_starts_and_stops_listening(client, repo):
    tid = flow(client, repo, sup={"on": True})
    view = switch(client, keel=True)
    idle(client)
    assert view["keel"] is True and sup_of(client).active and sup_of(client)._hear in client.bus._listeners
    assert looked(client, tid)[0]["outcome"] == "suggested"      # the gate that waited is looked at when it goes on
    switch(client, keel=False)
    assert sup_of(client).active is False and sup_of(client)._hear not in client.bus._listeners
    assert client.get("/supervisor/switch").json()["keel"] is False


def test_a_project_switch_supervises_its_flows_and_a_flow_can_say_otherwise(client, repo):
    switch(client, keel=True, demo={"on": True})
    tid = flow(client, repo)                                       # no switch of its own: the project's
    assert looked(client, tid)[0]["outcome"] == "suggested"
    off = flow(client, repo, sup={"on": False})                    # its own switch wins
    assert looked(client, off) == []
    assert client.get(f"/threads/{off}/supervisor").json()["settings"]["switches"]["off_by"] == "flow"
    switch(client, demo={"on": False})
    alone = flow(client, repo)
    assert looked(client, alone) == []
    assert client.post(f"/threads/{alone}/supervisor", json={"on": True}).json()["settings"]["on"] is True
    idle(client)
    assert looked(client, alone)[0]["outcome"] == "suggested"
    r = client.post(f"/threads/{alone}/supervisor", json={"on": None}).json()       # follows the project again
    assert r["settings"]["on"] is False and r["settings"]["switches"]["off_by"] == "project"


def test_the_plugin_switched_off_for_the_project_wins(client, repo):
    switch(client, keel=True, demo={"on": True, "plugin": False})
    tid = flow(client, repo, sup={"on": True})
    assert looked(client, tid) == []
    assert client.get(f"/threads/{tid}/supervisor").json()["settings"]["switches"]["off_by"] == "plugin"


@pytest.mark.parametrize("how", ["keel", "project", "flow"])
def test_turning_it_off_while_it_looks_stops_the_look_and_answers_nothing(client, repo, monkeypatch, how):
    monkeypatch.setenv("KEEL_FAKE_DELAY", "0.3")                   # slow turns: there is time to turn it off
    switch(client, keel=True, demo={"on": True})
    s = {**SETTINGS, "supervisor": {"mode": "act"}}
    tid = start(client, repo, workflow=from_dict({"name": "sw", "keel_rules": False, "steps": GATED}), settings=s)
    assert wait(client, tid)["status"] == "waiting"
    deadline = time.time() + 15
    while not client.bus.of(tid, "supervisor.started") and time.time() < deadline:
        time.sleep(0.02)
    assert sup_of(client).looks, "the look did not start"
    if how == "keel":
        switch(client, keel=False)
    elif how == "project":
        switch(client, demo={"on": False})
    else:
        client.post(f"/threads/{tid}/supervisor", json={"on": False})
    idle(client)
    assert not sup_of(client).looks
    [row] = looked(client, tid)
    assert row["outcome"] == "cancelled" and row["code"] == "turned-off"
    assert [e["data"]["status"] for e in client.bus.of(tid, "supervisor.finished")] == ["cancelled"]
    assert not client.bus.of(tid, "supervisor.decided") and not client.bus.of(tid, "gate.decided")
    assert wait(client, tid)["status"] == "waiting"


def test_the_daily_cap_per_project(client, repo):
    switch(client, keel=True)
    ledger.record(project_id="demo", thread_id="earlier", trigger="t", action="answer", outcome="applied", tokens=500_000)
    tid = flow(client, repo, sup={"on": True})
    [row] = looked(client, tid)
    assert row["code"] == "budget-day" and row["tokens"] == 0
