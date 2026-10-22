"""keel 0.18.9: the model and thinking effort of an agent or KeelBot through keel's MCP tools: shown by keel_agents,
keel_agent and keel_agent_definitions; changed by keel_agent_model and keel_agent_create (both ask the person first)."""

from __future__ import annotations

import json

import httpx
import pytest
from mcp.shared.memory import create_connected_server_and_client_session

from keel_engine import mcp_server

PROJECTS = [{"id": "shop", "name": "shop", "root": "/workspace/shop"}]
CATALOG = {
    "claude": {"label": "Claude", "efforts": ["low", "medium", "high", "xhigh", "max"],
               "default": {"mode": "subscription", "model": "sonnet", "effort": "high"},
               "modes": {"subscription": [{"id": "opus", "label": "Opus", "efforts": ["low", "medium", "high", "xhigh", "max"]},
                                          {"id": "sonnet", "label": "Sonnet", "efforts": ["low", "medium", "high", "xhigh", "max"]},
                                          {"id": "haiku", "label": "Haiku", "efforts": []}]}},
    "codex": {"label": "GPT / Codex", "efforts": ["low", "medium", "high"], "default": {"mode": "subscription", "model": "gpt-5.5"},
              "modes": {"subscription": [{"id": "gpt-5.5", "label": "GPT-5.5", "efforts": ["low", "medium", "high"]}]}},
    "copilot": {"label": "GitHub Copilot", "efforts": [], "default": {"mode": "subscription", "model": "gpt-5"},
                "modes": {"subscription": [{"id": "gpt-5", "label": "GPT-5"}]}},
}


class Stub:
    def __init__(self):
        self.calls: list[tuple[str, str, dict | None]] = []
        self.agents = [
            {"id": "implementer", "label": "Implementer", "custom": False, "tools": ["Edit"], "phases": ["green"],
             "model": {"provider": "claude", "mode": "subscription", "model": "sonnet", "effort": "high"}},
            {"id": "explorer", "label": "Explorer", "custom": False, "tools": ["Read"], "phases": ["any"],
             "model": {"provider": "claude", "mode": "subscription", "model": "haiku"}},
            {"id": "helper", "label": "KeelBot", "custom": False, "tools": ["Read"], "phases": ["any"],
             "model": {"provider": "claude", "mode": "subscription", "model": "sonnet"}},
            {"id": "lens-reviewer", "label": "lens-reviewer", "custom": False, "tools": ["Read"], "phases": ["ship"],
             "model": {"provider": "claude", "mode": "subscription", "model": "opus", "effort": "high"}},
        ]
        self.session = {"id": "s-1", "title": "docs", "mode": "ask", "status": "idle",
                        "model": {"provider": "codex", "mode": "subscription", "model": "gpt-5.5", "effort": "low"}, "messages": []}

    def __call__(self, req: httpx.Request) -> httpx.Response:
        path, m = req.url.path, req.method
        body = json.loads(req.content) if req.content else None
        self.calls.append((m, path, body))
        ok = lambda x: httpx.Response(200, json=x)  # noqa: E731
        if path == "/api/mcp/token":
            return ok({"token": "t"})
        if m == "GET" and path == "/api/projects":
            return ok(PROJECTS)
        if m == "GET" and path == "/api/providers/models":
            return ok(CATALOG)
        if m == "GET" and path == "/api/projects/shop/settings":
            return ok({"effective": {"default_model": {"provider": "claude", "mode": "subscription", "model": "sonnet"}}})
        if m == "GET" and path == "/api/projects/shop/agents":
            return ok(self.agents)
        if m == "PUT" and path.startswith("/api/projects/shop/agents/"):
            a = next(x for x in self.agents if x["id"] == path.rsplit("/", 1)[1])
            a["model"] = body["model"]
            return ok(a)
        if m == "POST" and path == "/api/projects/shop/agents":
            return ok({"id": "doc-writer", "tools": body["tools"], "model": body.get("model")})
        if m == "GET" and path == "/api/jobs":
            return ok([{"id": "j-1", "agent": "implementer", "step": "green", "ac": "AC-1", "provider": "claude",
                        "model": "sonnet", "effort": "high", "tokens_in": 900, "tokens_out": 100}])
        if m == "GET" and path == "/api/jobs/j-1/steps":
            return ok({"steps": [{"n": 1, "kind": "text", "text": "working"}], "running": True})
        if m == "GET" and path == "/api/jobs/j-1":
            return ok({"id": "j-1", "agent": "implementer", "provider": "claude", "model": "sonnet", "effort": "high"})
        if m == "GET" and path == "/api/projects/shop/helper/sessions":
            return ok([{**self.session, "busy": True}])
        if m == "GET" and path == "/api/projects/shop/helper/sessions/s-1":
            return ok(self.session)
        if m == "PATCH" and path == "/api/projects/shop/helper/sessions/s-1":
            self.session["model"] = body["model"]
            return ok(self.session)
        return httpx.Response(404, json={"error": f"stub: no {m} {path}"})


@pytest.fixture
def stub(monkeypatch):
    monkeypatch.delenv("KEEL_PROJECT", raising=False)
    monkeypatch.chdir("/")
    s = Stub()
    s.api = mcp_server.KeelApi("http://keel.test", transport=httpx.MockTransport(s))
    return s


async def call(srv, name, args=None) -> str:
    async with create_connected_server_and_client_session(srv) as session:
        res = await session.call_tool(name, args or {})
        assert not res.isError, res
        return res.content[0].text


def server(stub, level="write", yes=True):
    return mcp_server.build_server(level=level, api=stub.api, yes=yes)


def puts(stub):
    return [(p, b) for m, p, b in stub.calls if m in ("PUT", "PATCH", "POST") and "/mcp/" not in p]


async def test_the_agents_show_their_model_and_effort(stub):
    text = await call(server(stub, "read"), "keel_agents")
    assert "j-1  ▶ implementer (flow) · green AC-1 · claude/sonnet · effort high · 1,000 tokens" in text
    assert "codex/gpt-5.5 (subscription) · effort low" in text
    one = await call(server(stub, "read"), "keel_agent", {"agent_id": "j-1"})
    assert one.startswith("agent call j-1 · at work · implementer · claude/sonnet · effort high")
    defs = await call(server(stub, "read"), "keel_agent_definitions")
    assert "- implementer  Implementer · keel · model claude/sonnet (subscription) · effort high" in defs
    assert "- explorer  Explorer · keel · model claude/haiku (subscription) · effort default" in defs


async def test_agent_model_changes_the_effort_and_keeps_the_rest(stub):
    text = await call(server(stub), "keel_agent_model", {"agent": "implementer", "effort": "max"})
    assert puts(stub) == [("/api/projects/shop/agents/implementer",
                           {"model": {"provider": "claude", "mode": "subscription", "model": "sonnet", "effort": "max"}})]
    assert "the agent implementer now uses claude/sonnet (subscription) · effort max on shop" in text
    await call(server(stub), "keel_agent_model", {"agent": "implementer", "effort": "default"})
    assert puts(stub)[-1][1] == {"model": {"provider": "claude", "mode": "subscription", "model": "sonnet"}}


async def test_agent_model_another_provider_starts_on_its_default_and_drops_an_effort_it_lacks(stub):
    await call(server(stub), "keel_agent_model", {"agent": "implementer", "provider": "codex"})
    assert puts(stub)[-1][1] == {"model": {"provider": "codex", "mode": "subscription", "model": "gpt-5.5"}}
    stub.agents[0]["model"] = {"provider": "claude", "mode": "subscription", "model": "sonnet", "effort": "xhigh"}
    await call(server(stub), "keel_agent_model", {"agent": "implementer", "model": "haiku"})
    assert puts(stub)[-1][1] == {"model": {"provider": "claude", "mode": "subscription", "model": "haiku"}}


async def test_agent_model_with_an_agents_old_name_changes_the_renamed_agent(stub):
    text = await call(server(stub), "keel_agent_model", {"agent": "reviewer", "effort": "low"})
    assert puts(stub) == [("/api/projects/shop/agents/lens-reviewer",
                           {"model": {"provider": "claude", "mode": "subscription", "model": "opus", "effort": "low"}})]
    assert "the agent lens-reviewer now uses claude/opus (subscription) · effort low on shop" in text


async def test_agent_model_refuses_an_effort_the_model_does_not_have(stub):
    no = await call(server(stub), "keel_agent_model", {"agent": "explorer", "effort": "high"})
    assert no == "keel: claude/haiku has no effort setting: keel ignores one. Leave effort out."
    bad = await call(server(stub), "keel_agent_model", {"agent": "implementer", "effort": "ultra"})
    assert 'has no effort "ultra": pick low, medium, high, xhigh, max or default' in bad
    gone = await call(server(stub), "keel_agent_model", {"agent": "nobody", "effort": "low"})
    assert gone.startswith('keel: no agent "nobody"')
    assert puts(stub) == []


async def test_keelbot_and_one_of_its_chats(stub):
    text = await call(server(stub), "keel_agent_model", {"agent": "keelbot", "effort": "low"})
    assert puts(stub)[-1] == ("/api/projects/shop/agents/helper",
                              {"model": {"provider": "claude", "mode": "subscription", "model": "sonnet", "effort": "low"}})
    assert text.startswith("KeelBot now uses claude/sonnet (subscription) · effort low")
    chat = await call(server(stub), "keel_agent_model", {"agent": "keelbot", "chat": "s-1", "effort": "high"})
    assert puts(stub)[-1] == ("/api/projects/shop/helper/sessions/s-1",
                              {"model": {"provider": "codex", "mode": "subscription", "model": "gpt-5.5", "effort": "high"}})
    assert chat == "KeelBot's chat s-1 now answers with codex/gpt-5.5 (subscription) · effort high."


async def test_agent_model_asks_first_and_is_a_write_tool(stub):
    text = await call(server(stub, yes=False), "keel_agent_model", {"agent": "implementer", "effort": "low"})
    assert "cannot ask you to confirm" in text and puts(stub) == []
    assert mcp_server.tool_level("keel_agent_model") == "write" and "keel_agent_model" in mcp_server.CONFIRM


async def test_agent_create_with_a_model_and_effort(stub):
    text = await call(server(stub), "keel_agent_create", {"name": "doc writer", "prompt": "Write docs.", "effort": "medium"})
    path, body = puts(stub)[-1]
    assert path == "/api/projects/shop/agents"
    assert body["model"] == {"provider": "claude", "mode": "subscription", "model": "sonnet", "effort": "medium"}
    assert "model claude/sonnet (subscription) · effort medium" in text
    plain = await call(server(stub), "keel_agent_create", {"name": "plain", "prompt": "Read."})
    assert "model" not in puts(stub)[-1][1] and "model the default model" in plain
