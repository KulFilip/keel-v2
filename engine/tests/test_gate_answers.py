"""A gate takes only the answers it offers, and send-backs of one gate stop by themselves (the e2e's spec gate took
"approve" where it offered only "reject", as a send-back without a reason, 296 times in 80 minutes)."""

from conftest import decide, start, to_loop, wait
from keel_engine.runtime import compiler
from keel_engine.runtime.compiler import answer_problem
from test_flows_base import answers, wf

SETTINGS = {"gates_mode": "every-ac", "cap_tokens": 0, "on_cap": "pause"}


def resume(client, tid, decision, why=None, **kw):
    return client.post(f"/threads/{tid}/resume", json={"decision": decision, "why": why, **kw})


def test_answer_problem_knows_each_kind_of_question():
    gate = {"kind": "gate", "title": "spec approval", "options": ["approve", "reject"]}
    assert answer_problem(gate, "approve", None, None) is None
    assert answer_problem(gate, "reject", "", None)[0] == "Say why when you send it back."
    assert answer_problem(gate, "reject", "too vague", None) is None
    only = {**gate, "options": ["reject"]}
    assert answer_problem(only, "approve", "x", None) == ('"spec approval" does not take approve.', "Answer with one of: reject.")
    routes = {**gate, "options": ["approve"], "choices": ["approve", "edit", "reject"]}
    assert answer_problem(routes, "approve", None, {"choice": "edit"}) is None
    assert answer_problem(routes, "approve", None, {"choice": "bogus"})[0] == '"bogus" is not a choice of "spec approval".'
    assert answer_problem(routes, "reject", "missing the intent", None) is None     # the exit named reject
    assert answer_problem(routes, "approve", "", {"choice": "reject"})[0] == "Say why when you send it back."
    menu = {"kind": "gate", "title": "which ship steps run", "options": ["approve"]}
    assert answer_problem(menu, "reject", "no", None)[0] == '"which ship steps run" does not take reject.'
    # the special kinds keep what their buttons send
    usage = {"kind": "usage", "title": "plan", "options": ["approve", "reject"], "choices": ["continue", "wait", "cheaper", "stop"]}
    assert answer_problem(usage, "approve", None, {"choice": "wait"}) is None and answer_problem(usage, "reject", None, None) is None
    assert answer_problem({"kind": "budget", "title": "cap", "options": ["approve", "reject"]}, "reject", None, None) is None
    stuck = {"kind": "fix", "title": "stuck", "options": ["approve", "reject"], "choices": ["recheck", "retry", "skip", "stop"]}
    assert answer_problem(stuck, "approve", None, {"choice": "skip"}) is None and answer_problem(stuck, "reject", None, None) is None
    clar = {"kind": "clarify", "title": "questions", "options": ["approve"]}
    assert answer_problem(clar, "approve", None, {"answers": {"q1": "A"}}) is None
    assert answer_problem(clar, "reject", "x", None)[0] == '"questions" does not take reject.'


def test_resume_refuses_a_decision_or_choice_the_gate_does_not_offer(client, repo):
    tid = start(client, repo)
    s = wait(client, tid)
    w = s["waiting"]
    assert w["step"] == "spec_gate" and w["options"] == ["approve"] and "edit" in w["choices"]
    r = resume(client, tid, "approve", payload={"choice": "bogus"})
    assert r.status_code == 400 and "is not a choice" in r.text, r.text
    r = resume(client, tid, "approve", payload={"choice": "reject"})
    assert r.status_code == 400 and "Say why" in r.text, r.text
    assert wait(client, tid)["waiting"]["id"] == w["id"], "a refused answer leaves the gate waiting"
    s = to_loop(client, tid, s, upto="options")
    assert s["waiting"]["step"] != "spec_gate"


def back_wf():
    return wf([{"id": "work", "kind": "agent", "name": "work", "agent": "explorer"},
               {"id": "check", "kind": "gate", "name": "check the work", "back": "work"}])


def test_after_the_limit_a_send_back_asks_go_on_or_stop(client, repo, monkeypatch):
    seen = answers(monkeypatch, {"explorer": lambda r: "did it"})
    tid = start(client, repo, workflow=back_wf(), settings={**SETTINGS, "sendback_limit": 2})
    wait(client, tid)
    for n in (1, 2):
        s = decide(client, tid, "reject", why="same note")
        assert s["waiting"]["step"] == "check", s
    assert len(seen) == 3
    s = decide(client, tid, "reject", why="same note")
    w = s["waiting"]
    assert w["kind"] == "fix" and w["title"] == "check the work: sent back 2 time(s) in a row", w
    assert w["labels"] == {"approve": "Go on anyway", "reject": "Stop"} and len(seen) == 3, "no agent ran meanwhile"
    s = decide(client, tid, "approve")
    assert s["waiting"]["step"] == "check" and len(seen) == 4, "go on: that send-back went ahead"
    assert "same note" in seen[-1].prompt
    s = decide(client, tid, "approve")
    assert s["status"] == "done", "an approval ends the row"


def test_stop_at_the_limit_stops_the_flow_and_an_approval_starts_the_count_again(client, repo, monkeypatch):
    answers(monkeypatch, {"explorer": lambda r: "did it"})
    tid = start(client, repo, workflow=back_wf(), settings={**SETTINGS, "sendback_limit": 1})
    wait(client, tid)
    decide(client, tid, "reject", why="again")
    s = decide(client, tid, "reject", why="again")
    assert s["waiting"]["title"] == "check the work: sent back 1 time(s) in a row"
    s = decide(client, tid, "reject", why="enough")
    assert s["status"] == "stopped", s
    assert any(line.startswith("gate check stop: stopped: check the work was sent back 1 time(s)") for line in s["gate_log"])


def test_a_spec_gate_without_criteria_stops_looping_too(client, repo, monkeypatch):
    seen = answers(monkeypatch, {"explorer": lambda r: "I need to know which owners."})
    tid = start(client, repo, acs=None, settings={**SETTINGS, "sendback_limit": 2})
    s = wait(client, tid)
    assert s["waiting"]["options"] == ["reject"]
    assert resume(client, tid, "approve").status_code == 400
    for _ in range(2):
        s = decide(client, tid, "reject", why="all owners")
        assert "no acceptance criteria" in s["waiting"]["title"]
    s = decide(client, tid, "reject", why="all owners")
    assert s["waiting"]["kind"] == "fix" and "sent back 2 time(s) in a row" in s["waiting"]["title"]
    assert len([r for r in seen if r.step_name == "spec"]) == 3


def test_a_send_back_without_a_reason_tells_the_agent_so(client, repo, monkeypatch):
    # an old client or a driver script that skips the engine's check: the agent hears that no reason came
    monkeypatch.setattr(compiler, "answer_problem", lambda *a: None)
    from keel_engine.runtime import service
    monkeypatch.setattr(service, "answer_problem", lambda *a: None)
    seen = answers(monkeypatch, {"explorer": lambda r: "did it"})
    tid = start(client, repo, workflow=back_wf(), settings=SETTINGS)
    wait(client, tid)
    s = decide(client, tid, "reject")
    assert s["waiting"]["step"] == "check"
    assert "gave no reason" in seen[-1].feedback and "ask them once" in seen[-1].feedback
