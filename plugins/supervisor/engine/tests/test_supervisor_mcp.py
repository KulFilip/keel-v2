"""The Supervisor's tools in keel's own MCP server: keel_supervisor reads, keel_supervisor_set (--write) changes the
flow's Supervisor through keel's api."""

import asyncio

from keel_engine import mcp_server
from keel_plugin_supervisor import mcp_tools


class Api:
    def __init__(self):
        self.posted = []
        self.settings = {"on": False, "mode": "shadow", "cap_tokens": 150000}

    def get(self, route, **params):
        if route == "/projects":
            return [{"id": "demo", "name": "demo", "root": "/nowhere"}]
        if route == "/projects/demo/flow":
            return {"thread": {"thread_id": "t1", "status": "waiting"}}
        if route == "/projects/demo/flows/t1/supervisor":
            return {"settings": self.settings, "used": {"tokens": 4321}}
        if route == "/projects/demo/supervisor/decisions":
            assert params == {"threadId": "t1", "limit": 20}
            return {"decisions": [{"at": "2026-10-22T12:00:00Z", "step": "g1", "ac": "AC-1", "outcome": "applied",
                                   "decision": "approve", "confidence": "high", "tokens": 1200, "summary": "Clean."},
                                  {"at": "2026-10-22T12:05:00Z", "step": "g2", "outcome": "escalated", "code": "low-confidence",
                                   "confidence": "medium", "tokens": 900, "summary": "Spec says 410."}]}
        raise AssertionError(route)

    def post(self, path, body, timeout=None):
        self.posted.append((path, body))
        self.settings = {**self.settings, **body}
        return {"settings": self.settings}


def test_keel_supervisor_says_its_state_and_last_decisions():
    text = mcp_tools.supervisor_status(Api(), "demo")
    assert text.splitlines()[0] == "Flow t1: Supervisor off, mode shadow, 4,321 of 150,000 tokens used."
    assert "g1 AC-1: answered approve (high, 1,200 tokens) Clean." in text
    assert "g2 : asked the person [low-confidence] (medium, 900 tokens) Spec says 410." in text


def test_keel_supervisor_set_changes_the_flows_supervisor():
    api = Api()
    assert mcp_tools.supervisor_set(api, on=True, mode="act", project="demo") == "Flow t1: Supervisor on, mode act."
    assert api.posted == [("/projects/demo/flows/t1/supervisor", {"on": True, "mode": "act"})]
    assert mcp_tools.supervisor_set(api, project="demo") == "Say on, off or a mode (shadow or act)."


def test_the_tools_are_in_keels_own_mcp_server():
    tools = lambda write: {t.name for t in asyncio.run(mcp_server.build_server(write=write, api=object()).list_tools())}
    assert "keel_supervisor" in tools(False) and "keel_supervisor_set" not in tools(False)
    assert "keel_supervisor_set" in tools(True)
