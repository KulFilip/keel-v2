"""Small correctness fixes: a full event buffer keeps the newest, a branch's "no", a bad cap, MCP writes."""
import json
from collections import deque

import httpx
import pytest

from conftest import decide, start, wait
from keel_engine import mcp_server
from keel_engine.events import EventBus
from test_flows_base import answers, wf
from test_mcp import StubApi, call


async def test_a_full_buffer_drops_the_oldest_events_not_the_newest(monkeypatch):
    monkeypatch.setenv("KEEL_API_URL", "http://api.test")
    bus = EventBus()
    bus._pending = deque(maxlen=5)
    monkeypatch.setattr("keel_engine.events.BATCH", 2)
    for n in range(1, 6):
        bus.emit(f"e{n}", "t", "p")

    def down(request):
        for n in (6, 7, 8):          # events that arrive while the send is on its way
            bus.emit(f"e{n}", "t", "p")
        return httpx.Response(503)

    async with httpx.AsyncClient(transport=httpx.MockTransport(down)) as client:
        assert not await bus._send_once(client=client)
    assert [e["type"] for e in bus._pending] == ["e4", "e5", "e6", "e7", "e8"]


def branch_flow():
    return wf([{"id": "ask", "kind": "agent", "name": "ask", "agent": "explorer"},
               {"id": "br", "kind": "branch", "name": "blocked?", "agent": "reviewer", "no": "done"},
               {"id": "mid", "kind": "gate", "name": "yes path"},
               {"id": "done", "kind": "gate", "name": "no path"}])


@pytest.mark.parametrize("said,waits", [("Nothing blocks, yes", "no path"), ("No, nothing", "no path")])
def test_a_branch_answer_is_no_only_when_it_says_the_word_no(client, repo, monkeypatch, said, waits):
    answers(monkeypatch, {"reviewer": lambda r: said})
    tid = start(client, repo, workflow=branch_flow())
    s = wait(client, tid)
    # "Nothing blocks, yes" is a yes: it goes on to the next step, "mid"; "No, nothing" jumps to "done"
    assert s["waiting"]["title"] == ("yes path" if said.startswith("Nothing") else "no path"), s["waiting"]


def test_a_cap_answer_that_is_not_a_number_does_not_crash_the_flow(client, repo):
    from test_caps import SETTINGS, agent
    tid = start(client, repo, workflow=wf([agent(i) for i in range(1, 7)]), settings={**SETTINGS, "cap_tokens": 30_000})
    s = wait(client, tid)
    assert s["waiting"]["title"] == "Token cap reached", s
    s = decide(client, tid, "approve", payload={"cap_tokens": "lots"})        # not a number: keel's own suggestion is used
    assert s["status"] != "failed", s
    assert s["usage"]["cap_tokens"] == 74_000, s


def _api(stub):
    return mcp_server.KeelApi("http://keel.test", transport=httpx.MockTransport(stub))


async def test_a_write_in_a_folder_that_matches_no_project_does_not_pick_the_first(monkeypatch):
    monkeypatch.delenv("KEEL_PROJECT", raising=False)
    monkeypatch.chdir("/")
    stub = StubApi()
    text = await call(mcp_server.build_server(write=True, api=_api(stub)), "keel_approve_gate", {"decision": "approve"})
    assert "none of keel's projects" in text and not stub.posts
    # the same call with the project named works; a read still falls back to the first project
    await call(mcp_server.build_server(write=True, api=_api(stub)), "keel_approve_gate", {"decision": "approve", "project": "shop"})
    assert stub.posts
    assert "shop" in await call(mcp_server.build_server(write=False, api=_api(stub)), "keel_status", {})


def test_the_proof_is_asked_again_after_a_failed_answer(monkeypatch):
    monkeypatch.setenv("KEEL_INTERNAL_TOKEN", "internal")
    monkeypatch.delenv("KEEL_MCP_TOKEN", raising=False)
    calls = []

    def handler(req):
        calls.append(req.url.path)
        return httpx.Response(503) if len(calls) == 1 else httpx.Response(200, json={"token": "tok"})

    api = mcp_server.KeelApi("http://keel.test", transport=httpx.MockTransport(handler))
    api._prove()
    api._prove()
    assert calls == ["/api/mcp/token", "/api/mcp/token"] and api.http.headers.get(mcp_server.MCP_TOKEN_HEADER) == "tok"


async def test_run_action_that_opens_a_pr_asks_first(monkeypatch):
    monkeypatch.delenv("KEEL_PROJECT", raising=False)
    monkeypatch.chdir("/")
    stub = StubApi()
    srv = mcp_server.build_server(level="admin", api=_api(stub))
    text = await call(srv, "keel_run_action", {"action": "open_pr", "project": "shop"})
    assert "cannot ask you to confirm" in text and not stub.posts


def test_a_branch_name_that_starts_with_a_dash_is_not_fetched(tmp_path):
    from types import SimpleNamespace
    from keel_engine.runtime import ticket_actions
    r, why = ticket_actions._source_branch(SimpleNamespace(root=str(tmp_path)), {}, "--upload-pack=touch /tmp/x", None)
    assert r is None and "starts with" in why
