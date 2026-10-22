"""An answer is for the question it was given to: a flow that moved on while the person decided answers 409."""
import copy

from conftest import start, wait
from test_mcp import THREAD, call
from test_mcp import StubApi
from keel_engine import mcp_server
import httpx


def test_resume_with_the_question_id_of_an_old_gate_is_refused(client, repo):
    tid = start(client, repo)
    w = wait(client, tid)["waiting"]
    r = client.post(f"/threads/{tid}/resume", json={"decision": "approve", "question_id": "an-older-question"})
    assert r.status_code == 409, r.text
    assert wait(client, tid)["waiting"]["id"] == w["id"], "the gate still waits"
    # the id inside the payload (the api passes only decision, why and payload) counts the same
    r = client.post(f"/threads/{tid}/resume", json={"decision": "approve", "payload": {"question_id": "an-older-question"}})
    assert r.status_code == 409, r.text
    # the right id, and no id at all, still work
    r = client.post(f"/threads/{tid}/resume", json={"decision": "approve", "question_id": w["id"]})
    assert r.status_code == 200, r.text


def test_resume_without_an_id_keeps_the_old_behaviour(client, repo):
    tid = start(client, repo)
    wait(client, tid)
    assert client.post(f"/threads/{tid}/resume", json={"decision": "approve"}).status_code == 200


async def test_mcp_approve_gate_sends_the_id_of_the_gate_it_read(monkeypatch):
    monkeypatch.setenv("KEEL_PROJECT", "shop")
    thread = copy.deepcopy(THREAD)
    thread["waiting"]["id"] = "q-old"
    stub = StubApi(thread)
    api = mcp_server.KeelApi("http://keel.test", transport=httpx.MockTransport(stub))
    await call(mcp_server.build_server(write=True, api=api), "keel_approve_gate", {"decision": "approve"})
    assert stub.posts[-1][1]["payload"]["question_id"] == "q-old"
    await call(mcp_server.build_server(write=True, api=api), "keel_approve_gate",
               {"decision": "approve", "question_id": "q-shown"})
    assert stub.posts[-1][1]["payload"]["question_id"] == "q-shown"
