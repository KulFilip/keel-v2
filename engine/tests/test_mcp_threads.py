"""MCP answers a flow that is not the project's current flow: a worktree flow, or one started after another.

The api has no GET /threads/{id} (that is the engine's route): a thread is read with GET /projects/{pid}/flows/{tid},
and a flow the project's Flow page does not show is found through the Inbox."""

import json

import httpx
import pytest

from keel_engine import mcp_server
from test_mcp import THREAD, call

DONE = {**THREAD, "thread_id": "t-1", "status": "done", "waiting": None, "current": None}
SIDE = {**THREAD, "thread_id": "t-2", "title": "Checkout coupons", "worktree": "/workspace/.keel/worktrees/t-2",
        "waiting": {"id": "q-7", "step": "spec_gate", "kind": "gate", "title": "Approve the coupon spec",
                    "options": ["approve", "reject"]}}
OTHER = {**SIDE, "thread_id": "t-3", "title": "Basket totals",
         "waiting": {**SIDE["waiting"], "id": "q-8", "title": "Approve the basket spec"}}


class Api:
    """The api as keel 0.18.57 has it: the project's current flow is done; t-2 (and t-3) wait in worktrees."""

    def __init__(self, waiting=(SIDE,)):
        self.threads = {t["thread_id"]: t for t in (DONE, *waiting)}
        self.waiting = list(waiting)
        self.posts: list[tuple[str, dict]] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if req.method == "POST":
            body = json.loads(req.content)
            self.posts.append((path, body))
            tid = path.split("/")[3]
            return httpx.Response(200, json={**self.threads[tid], "status": "running", "waiting": None})
        if path == "/api/projects":
            return httpx.Response(200, json=[{"id": "shop", "name": "shop", "root": "/workspace/shop"}])
        if path == "/api/projects/shop/flow":
            return httpx.Response(200, json={"thread": DONE, "workflow": {"id": "feature"}})
        if path.startswith("/api/projects/shop/flows/"):
            tid = path.rsplit("/", 1)[1]
            if tid in self.threads:
                return httpx.Response(200, json={"thread": self.threads[tid], "workflow": {"id": "feature"}})
        if path == "/api/inbox":
            items = [{"project_id": "shop", "thread_id": t["thread_id"], "kind": "gate", "title": t["waiting"]["title"],
                      "options": ["approve", "reject"]} for t in self.waiting]
            return httpx.Response(200, json={"items": items, "count": len(items)})
        return httpx.Response(404, json={"error": f"No route {path}"})


@pytest.fixture
def make(monkeypatch):
    monkeypatch.setenv("KEEL_PROJECT", "shop")
    monkeypatch.chdir("/")

    def build(waiting=(SIDE,)):
        s = Api(waiting)
        s.srv = mcp_server.build_server(write=True, api=mcp_server.KeelApi("http://keel.test", transport=httpx.MockTransport(s)))
        return s
    return build


async def test_keel_answer_with_a_thread_id_answers_a_worktree_flow(make):
    api = make()
    text = await call(api.srv, "keel_answer", {"thread_id": "t-2"})
    assert "answered thread t-2" in text
    assert api.posts == [("/api/inbox/t-2/act", {"decision": "approve", "why": None, "payload": {"question_id": "q-7"}})]


async def test_keel_answer_without_a_thread_id_finds_the_one_waiting_flow(make):
    api = make()
    text = await call(api.srv, "keel_answer", {})
    assert "answered thread t-2" in text and api.posts[0][0] == "/api/inbox/t-2/act"


async def test_keel_approve_gate_decides_the_flow_the_inbox_lists(make):
    api = make()
    text = await call(api.srv, "keel_approve_gate", {"decision": "approve"})
    assert "approved Approve the coupon spec on thread t-2" in text
    assert api.posts == [("/api/threads/t-2/resume", {"decision": "approve", "payload": {"question_id": "q-7"}})]


async def test_keel_approve_gate_takes_a_thread_id(make):
    api = make((SIDE, OTHER))
    text = await call(api.srv, "keel_approve_gate", {"decision": "reject", "why": "split it", "thread_id": "t-3"})
    assert "sent back Approve the basket spec on thread t-3" in text
    assert api.posts[0][0] == "/api/threads/t-3/resume"


async def test_two_waiting_flows_and_no_thread_id_name_both_and_send_nothing(make):
    api = make((SIDE, OTHER))
    text = await call(api.srv, "keel_answer", {})
    assert "2 flows wait on shop" in text and "t-2" in text and "t-3" in text and "thread_id" in text
    text = await call(api.srv, "keel_approve_gate", {"decision": "approve"})
    assert "2 flows wait on shop" in text
    assert not api.posts
