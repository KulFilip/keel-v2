"""keel 0.18.6: skills through keel's MCP tools (keel_engine/mcp_skills.py): the list with the agents that use each, one
skill's text, a new one (checked first), one from a link, attach and detach (an agent's own skill list too), one from the
marketplace, and the marketplace search that finds skills. Each save asks the person first (here with `yes`)."""

from __future__ import annotations

import json

import httpx
import pytest
from mcp.shared.memory import create_connected_server_and_client_session

from keel_engine import formats, mcp_server

SKILL = "---\nname: changelog-entries\ndescription: How to write a changelog entry.\n---\n# Changelog\n\nOne line per change.\n"


class Stub:
    def __init__(self):
        self.calls: list[tuple[str, str, dict | None]] = []
        self.on = {"debugging": ["reproducer"], "changelog-entries": []}
        self.reviewer_skills = ["review"]

    def __call__(self, req: httpx.Request) -> httpx.Response:
        path, m = req.url.path, req.method
        body = json.loads(req.content) if req.content else None
        self.calls.append((m, path, body))
        ok = lambda x: httpx.Response(200, json=x)  # noqa: E731
        if path == "/api/mcp/token":
            return ok({"token": "t"})
        if path == "/api/projects":
            return ok([{"id": "shop", "name": "shop", "root": "/workspace/shop"}])
        if m == "GET" and path == "/api/projects/shop/skills":
            return ok([{"id": "debugging", "kind": "debugging", "source": "keel", "stack": "any", "version": "v2", "tokens": 2300,
                        "agents": self.on["debugging"], "when": "bug-repro", "enabled": True, "about": "Find the cause."},
                       {"id": "mine", "kind": "knowledge", "source": "yours", "stack": "any", "version": "v1", "tokens": 40,
                        "agents": [], "when": "on demand", "enabled": False, "about": ""}])
        if m == "GET" and path.startswith("/api/skills/"):
            sid = path.rsplit("/", 1)[1]
            return ok({"id": sid, "kind": "debugging", "stack": "any", "source": "keel", "version": "v2", "tokens": 2300,
                       "agents": self.on.get(sid, []), "when": "bug-repro", "enabled": True, "about": "",
                       "body": "# Debugging\nFind the cause first.", "refs": [{"path": "references/bisect.md", "tokens": 900}]})
        if m == "GET" and path == "/api/projects/shop/agents":
            return ok([{"id": "reproducer", "overridden": [], "skills": []},
                       {"id": "investigator", "overridden": [], "skills": []},
                       {"id": "lens-reviewer", "overridden": ["skills"], "skills": self.reviewer_skills}])
        if m == "PUT" and path.startswith("/api/projects/shop/skills/"):
            self.on[path.rsplit("/", 1)[1]] = body["agents"]
            return ok({"id": path.rsplit("/", 1)[1], "agents": body["agents"]})
        if m == "PUT" and path == "/api/projects/shop/agents/lens-reviewer":
            self.reviewer_skills = body["skills"]
            return ok({"id": "lens-reviewer"})
        if path == "/api/projects/shop/skills/import":
            return ok({"id": "changelog-entries", "tokens": 30, "agents": []})
        if path == "/api/projects/shop/skills/market/install":
            return ok({"skill": {"id": body["name"], "tokens": 1200, "agents": body.get("agents") or []},
                       "market": {"catalog": "keel", "name": body["name"], "version": "1.0.0", "sha256": "ab"}})
        if path == "/api/marketplace/skills":
            return ok({"skills": [{"name": "flaky-tests", "title": "Flaky tests", "publisher": "keel", "publisher_title": "keel",
                                   "version": "1.0.0", "summary": "Find why a test fails sometimes.", "installed": None}],
                       "builtin": [{"name": "debugging", "source": "keel", "summary": "Find the cause.", "kind": "debugging",
                                    "tokens": 2300, "agents": ["reproducer"]}]})
        if path == "/api/marketplace":
            return ok({"plugins": [], "sources": []})
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


async def tools(level):
    srv = mcp_server.build_server(level=level, api=object())
    return {t.name for t in await srv.list_tools()}


async def test_reads_are_read_and_saves_are_write():
    read = await tools("read")
    assert {"keel_skills", "keel_skill"} <= read
    assert not read & {"keel_skill_create", "keel_skill_import", "keel_skill_attach", "keel_skill_market_install"}
    assert {"keel_skill_create", "keel_skill_import", "keel_skill_attach", "keel_skill_market_install"} <= await tools("write")
    for name in ("keel_skill_create", "keel_skill_import", "keel_skill_attach", "keel_skill_market_install"):
        assert name in mcp_server.CONFIRM


async def test_the_list_and_one_skill(stub):
    text = await call(stub, "keel_skills", {}, level="read")
    assert text.startswith("2 skills on shop")
    assert "- debugging  debugging · keel · 2.3k tokens · reproducer · when bug-repro\n    Find the cause." in text
    assert "- mine  knowledge · yours · 40 tokens · no agent · when on demand · off" in text
    one = await call(stub, "keel_skill", {"skill": "debugging"}, level="read")
    assert "agents: reproducer · when: bug-repro" in one and "references/bisect.md (900)" in one
    assert one.endswith("# Debugging\nFind the cause first.")
    assert ("GET", "/api/skills/debugging", None) in stub.calls


async def test_the_skill_format(stub):
    text = await call(stub, "keel_format", {"kind": "skill"}, level="read")
    assert text == formats.FORMATS["skill"] and "```keel-skill" in text


async def test_a_new_skill_is_checked_then_saved_and_attached(stub):
    bad = await call(stub, "keel_skill_create", {"text": "# no front matter\ntext"})
    assert "keel did not save it" in bad and "no front matter" in bad
    assert "is not an id" in await call(stub, "keel_skill_create", {"text": "---\nname: Big Name\ndescription: d\n---\nx"})
    assert not any(p.endswith("/import") for _, p, _ in stub.calls)
    saved = await call(stub, "keel_skill_create", {"text": SKILL, "agents": ["investigator"]})
    assert ("POST", "/api/projects/shop/skills/import", {"body": SKILL}) in stub.calls
    assert saved == "saved the skill changelog-entries on shop (written here, 30 tokens); loaded by investigator from the next run."
    assert stub.on["changelog-entries"] == ["investigator"]


async def test_import_from_a_link(stub):
    saved = await call(stub, "keel_skill_import", {"url": "https://example.com/x/SKILL.md"})
    assert ("POST", "/api/projects/shop/skills/import", {"url": "https://example.com/x/SKILL.md"}) in stub.calls
    assert "from https://example.com/x/SKILL.md" in saved and "keel_skill_attach(skill='changelog-entries'" in saved
    assert "give a link" in await call(stub, "keel_skill_import", {"url": "file:///etc/passwd"})


async def test_attach_and_detach(stub):
    # "reviewer" is the lens-reviewer's old name: it still names that agent
    done = await call(stub, "keel_skill_attach", {"skill": "debugging", "agents": ["investigator", "reviewer"]})
    assert done == ("put debugging on investigator, lens-reviewer on shop; it is loaded by reproducer, investigator, "
                    "lens-reviewer now, from the next run.")
    assert stub.reviewer_skills == ["review", "debugging"]       # the reviewer's own list wins over the skill's, so it changes too
    again = await call(stub, "keel_skill_attach", {"skill": "debugging", "agents": ["investigator"]})
    assert again == "debugging was already on investigator: nothing changed."
    off = await call(stub, "keel_skill_attach", {"skill": "debugging", "agents": ["reproducer", "lens-reviewer"], "detach": True})
    assert off.startswith("took debugging off reproducer, lens-reviewer") and stub.on["debugging"] == ["investigator"]
    assert stub.reviewer_skills == ["review"]
    assert "no agent ghost on shop" in await call(stub, "keel_skill_attach", {"skill": "debugging", "agents": ["ghost"]})


async def test_install_from_the_marketplace_and_search_finds_skills(stub):
    done = await call(stub, "keel_skill_market_install", {"name": "flaky-tests", "agents": ["investigator"]})
    assert ("POST", "/api/projects/shop/skills/market/install", {"name": "flaky-tests", "agents": ["investigator"]}) in stub.calls
    assert done == "installed the skill flaky-tests 1.0.0 from the catalog keel on shop (1.2k tokens); loaded by investigator from the next run."
    assert "not a skill name" in await call(stub, "keel_skill_market_install", {"name": "../x"})
    found = await call(stub, "keel_marketplace_search", {"q": "find"}, level="read")
    assert "skill flaky-tests  Flaky tests · keel · not installed · version 1.0.0" in found
    assert "skill debugging  built into keel (keel) · in every project · 2.3k tokens · agents reproducer" in found


async def test_saving_asks_the_person_first(stub):
    text = await call(stub, "keel_skill_attach", {"skill": "debugging", "agents": ["investigator"]}, yes=False)
    assert "cannot ask you to confirm" in text and not any(m == "PUT" for m, _, _ in stub.calls)


def test_keelbots_skill_button_is_named_as_the_tool_that_saves_it():
    from keel_engine.mcp_tui import _buttons_hint
    hint = _buttons_hint("Here:\n```keel-skill\n---\nname: changelog-entries\ndescription: d\n---\nbody\n```")
    assert "save the skill changelog-entries: keel_skill_create(text=<the keel-skill block, whole>)" in hint
