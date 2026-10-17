"""keel 0.18.5: a new workflow, rule pack or agent through keel's MCP tools (keel_engine/mcp_create.py): the format, a
check that saves nothing, and the save (which asks the person first; here with `yes`)."""

from __future__ import annotations

import json

import httpx
import pytest
from mcp.shared.memory import create_connected_server_and_client_session

from keel_engine import formats, mcp_server

WF = "id: docs-check\nname: docs check\nkeel_rules: false\nversion: 1\nsteps:\n  - { id: look, kind: gate, name: look }\n"
RULE = "schema: 1\nkind: rules\nname: no-sql-edits\ntitle: t\nversion: 1.0.0\nsummary: s\nrules:\n  - { id: x, kind: edit, match: ['**/*.sql'], reason: r }\n"


class Stub:
    def __init__(self):
        self.calls: list[tuple[str, str, dict | None]] = []
        self.wf_errors: list[str] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        path, m = req.url.path, req.method
        body = json.loads(req.content) if req.content else None
        self.calls.append((m, path, body))
        ok = lambda x: httpx.Response(200, json=x)  # noqa: E731
        if path == "/api/mcp/token":
            return ok({"token": "t"})
        if path == "/api/projects":
            return ok([{"id": "shop", "name": "shop", "root": "/workspace/shop"}])
        if path == "/api/projects/shop/workflows/check":
            return ok({"name": "docs check", "steps": 1, "gates": 1, "agents": [], "commands": [], "edits_files": False,
                       "valid": not self.wf_errors, "errors": self.wf_errors, "warnings": [],
                       "lines": [{"line": 6, "message": e} for e in self.wf_errors]})
        if path == "/api/projects/shop/workflows/import":
            return ok({"workflow": {"id": "docs-check", "steps": [{"id": "look"}]}, "review": {}})
        if path == "/api/projects/shop/rules/check":
            good = "rules:" in body["yaml"]
            return ok({"ok": good, "errors": [] if good else ["rules: a list"],
                       "dry_run": {"checked": 12, "blocked": [{"kind": "edit", "target": "db/V1__init.sql", "agent": "implementer"}]}})
        if path == "/api/projects/shop/rules/packs":
            return ok({"pack": {"id": "no-sql-edits"}})
        if m == "GET" and path == "/api/projects/shop/agents":
            return ok([{"id": "explorer", "label": "Explorer", "custom": False, "enabled": True, "tools": ["Read"], "phases": ["any"],
                        "about": "Maps the code."}])
        if m == "POST" and path == "/api/projects/shop/agents":
            return ok({"id": "doc-writer", "tools": body["tools"]})
        return httpx.Response(404, json={"error": f"stub: no {m} {path}"})


@pytest.fixture
def stub(monkeypatch):
    monkeypatch.delenv("KEEL_PROJECT", raising=False)
    monkeypatch.chdir("/")
    s = Stub()
    s.api = mcp_server.KeelApi("http://keel.test", transport=httpx.MockTransport(s))
    return s


async def call(stub, name, args, level="write", yes=True) -> str:
    srv = mcp_server.build_server(level=level, api=stub.api, yes=yes)
    async with create_connected_server_and_client_session(srv) as session:
        res = await session.call_tool(name, args)
        assert not res.isError, res
        return res.content[0].text


async def test_the_formats_have_an_example_each(stub):
    for kind, block in (("workflow", "```keel-workflow"), ("rule", "```keel-rule"), ("agent", "```keel-agent")):
        text = await call(stub, "keel_format", {"kind": kind}, level="read")
        assert text == formats.FORMATS[kind] and block in text


async def test_a_workflow_is_checked_then_saved_and_never_saved_with_errors(stub):
    assert (await call(stub, "keel_workflow_check", {"yaml": WF}, level="read")).startswith("keel can run it. docs check: 1 steps")
    saved = await call(stub, "keel_workflow_create", {"yaml": WF, "folder": "Docs"})
    assert ("POST", "/api/projects/shop/workflows/import", {"yaml": WF, "folder": "Docs"}) in stub.calls
    assert saved.startswith("saved the workflow docs-check on shop in the folder Docs (1 steps)")
    stub.wf_errors = ["steps[0].kind: one of agent, code, gate, branch"]
    refused = await call(stub, "keel_workflow_create", {"yaml": WF})
    assert "keel did not save it" in refused and "error (line 6): steps[0].kind" in refused
    assert sum(1 for _, p, _ in stub.calls if p.endswith("/import")) == 1


async def test_a_rule_pack_says_what_it_would_have_refused_then_saves(stub):
    check = await call(stub, "keel_rule_check", {"yaml": RULE}, level="read")
    assert "would have refused 1 of 12" in check and "edit: db/V1__init.sql (implementer)" in check
    saved = await call(stub, "keel_rule_create", {"yaml": RULE})
    assert saved.startswith("saved the rule pack no-sql-edits on shop (.keel/rules/no-sql-edits.yaml)")
    assert "keel did not save it" in await call(stub, "keel_rule_create", {"yaml": "name: x"})


async def test_an_agent_is_saved_with_known_tools_only(stub):
    assert "- explorer  Explorer · keel · model the default model · tools Read" in await call(stub, "keel_agent_definitions", {}, level="read")
    saved = await call(stub, "keel_agent_create", {"name": "doc writer", "prompt": "Write the docs.", "tools": ["Read", "Write"]})
    assert ("POST", "/api/projects/shop/agents", {"name": "doc writer", "about": "", "prompt": "Write the docs.",
                                                 "tools": ["Read", "Write"], "phases": ["any"]}) in stub.calls
    assert "saved the agent doc-writer" in saved and "agent: doc-writer" in saved
    bad = await call(stub, "keel_agent_create", {"name": "x", "prompt": "y", "tools": ["Delete"]})
    assert "unknown tools Delete" in bad


async def test_saving_asks_the_person_first(stub):
    text = await call(stub, "keel_agent_create", {"name": "x", "prompt": "y"}, yes=False)
    assert "cannot ask you to confirm" in text and not any(m == "POST" and p.endswith("/agents") for m, p, _ in stub.calls)
