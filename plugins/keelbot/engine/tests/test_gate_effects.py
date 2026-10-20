"""0.18.28 KeelBot reads a gate's choices before it advises (it said "send the gate back (reject) with this reason" at
the integration gate, whose reject only stopped the flow), and "let KeelBot fix it" at a failing integration."""
import time

from conftest import start
from keel_engine.runtime import actions
from keel_engine.runtime.actions import ActionResult
from keel_plugin_keelbot import helper, keelbot

# the integration gate as keel shows it when the suite fails (engine runtime/compiler.py _suite_question)
INTEGRATION = {
    "step": "integration_commit", "name": "verify the suite + commit", "kind": "fix", "title": "verify the suite + commit: the suite fails",
    "detail": "2 tests fail", "options": ["approve", "reject"], "choices": ["send_back_ac", "keelbot_fix", "retry", "stop"],
    "choice_info": [
        {"name": "send_back_ac", "label": "Send back to AC-008", "description": "AC-008's test is the likely cause: it opens again at green", "why": "optional", "default": True},
        {"name": "keelbot_fix", "label": "Let KeelBot fix it", "description": "KeelBot fixes it in an Edit chat, then keel checks again", "why": "optional", "default": False},
        {"name": "retry", "label": "Check again", "description": "run the suite again (after you fixed it yourself)", "why": "none", "default": False},
        {"name": "stop", "label": "Stop the flow", "description": "stop here; the commits so far stay", "why": "optional", "default": False}],
    "plain": {"approve": {"does": 'the choice "send_back_ac"', "reason": "used"},
              "reject": {"does": "stops the flow (the work so far stays)", "reason": "not used: it is only kept as the stop reason"}},
}


def test_the_prompt_says_what_each_choice_does_and_what_a_reject_really_does():
    flow = {"title": "ETA", "status": "waits", "phase": "integration", "waiting": INTEGRATION}
    know = helper.agent_knowledge.for_agent(helper.AGENT, None)
    p = helper.build_prompt(mode="ask", root=".", question="the suite fails, what do I do?", know=know, graph=False, flow=flow,
                            mentions=[], selection=None, open_file=None, transcript="")
    assert "the step 'verify the suite + commit'" in p
    assert "- send_back_ac \"Send back to AC-008\": AC-008's test is the likely cause" in p
    assert "- retry \"Check again\": run the suite again (after you fixed it yourself); a reason is not used" in p
    assert "A plain reject here stops the flow (the work so far stays); its reason: not used" in p
    assert "never suggest reject (or a choice) with a reason when that reason is not used" in p
    # and in the flows list: the api sends choice_info as "choices" of dicts
    line = keelbot._flow_line({"title": "ETA", "thread_id": "t1", "status": "waiting",
                               "waiting": {"title": INTEGRATION["title"], "choices": INTEGRATION["choice_info"], "plain": INTEGRATION["plain"]}})
    assert "send_back_ac = AC-008's test is the likely cause" in line and "a plain reject stops the flow" in line
    assert "{'name'" not in line


def test_let_keelbot_fix_it_runs_an_edit_chat_then_checks_the_suite_again(client, repo, monkeypatch):
    real = actions.verify_green
    left = {"n": 5}          # 1 + 3 tries of the agent, then the question; the resume runs it once more

    async def verify_green(a):
        if not a.ac and a.phase == "integration" and left["n"] > 0:
            left["n"] -= 1
            return ActionResult(False, "The api suite does not pass yet.", "exit 2", {"suite_failure": {
                "failing": ["T::testUniqueCode"], "alone": [], "pollution": False, "likely_ac": None, "suspects": [], "evidence": []}})
        return await real(a)
    monkeypatch.setattr(actions, "verify_green", verify_green)
    tid = start(client, repo)

    def wait(timeout=60):
        deadline = time.time() + timeout
        while time.time() < deadline:
            s = client.get(f"/threads/{tid}").json()
            if s["status"] != "running":
                return s
            time.sleep(0.05)
        raise AssertionError("still running")

    s = wait()
    for _ in range(40):
        if s["status"] == "waiting" and s["waiting"]["step"] == "integration_commit":
            break
        client.post(f"/threads/{tid}/resume", json={"decision": "approve"})
        s = wait()
    assert s["status"] == "waiting", s
    w = s["waiting"]
    # no likely criterion: the agent tried first (its rounds), then the choices, KeelBot's among them
    assert w["choices"] == ["keelbot_fix", "retry", "stop"] and w["choice_info"][0]["default"]
    client.post(f"/threads/{tid}/resume", json={"decision": "approve", "payload": {"choice": "keelbot_fix"}})
    s = wait()
    assert s["waiting"]["step"] == "integration_gate", s["waiting"]
    chats = [x for x in helper.list_sessions("demo") if x["mode"] == "edit"]
    assert len(chats) == 1 and chats[0]["title"] == "Fix: verify the suite + commit"
    msgs = helper.get(chats[0]["id"])["messages"]
    assert "the whole suite fails" in msgs[0]["text"] and msgs[1]["role"] == "helper"
    assert any(x.startswith("suite integration_commit keelbot_fix") for x in s["gate_log"])
