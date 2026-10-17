"""keel 0.18.9: stacks through keel's MCP tools (keel_engine/mcp_stacks.py): the list, one stack with its YAML, keel's
suggestions, the check that saves nothing, a new one (checked first), remove, turn off, a marketplace install, and the
marketplace search that finds stacks. Create, remove and install ask the person first (here with `yes`)."""

from __future__ import annotations

import json

import httpx
import pytest
from mcp.shared.memory import create_connected_server_and_client_session

from keel_engine import formats, mcp_server

YAML = "name: zig-api\nlane: api\ndetect: {files: [build.zig]}\nlayers: [{id: unit, what: x}]\n"


class Stub:
    def __init__(self):
        self.calls: list[tuple[str, str, dict | None]] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        path, m = req.url.path, req.method
        body = json.loads(req.content) if req.content else None
        self.calls.append((m, path + (f"?{req.url.query.decode()}" if req.url.query else ""), body))
        ok = lambda x: httpx.Response(200, json=x)  # noqa: E731
        if path == "/api/mcp/token":
            return ok({"token": "t"})
        if path == "/api/projects":
            return ok([{"id": "shop", "name": "shop", "root": "/workspace/shop"}])
        if m == "GET" and path == "/api/projects/shop/stacks":
            return ok([{"name": "kotlin-spring", "lane": "api", "source": "keel", "origin": "keel", "detected": True, "off": False,
                        "removable": False},
                       {"name": "python", "lane": "api", "source": "keel", "origin": "keel", "detected": True, "off": True,
                        "removable": False},
                       {"name": "django", "lane": "api", "source": "keel pack", "origin": "keel pack", "detected": False,
                        "removable": False, "installable": True},
                       {"name": "zig-api", "lane": "api", "source": "project", "origin": "marketplace", "detected": True,
                        "removable": True, "market": {"catalog": "keel", "version": "1.0.0", "edited": True}}])
        if m == "GET" and path == "/api/projects/shop/stacks/suggest":
            return ok({"lane": "api", "closest": "kotlin-spring", "read": ["build.gradle.kts"], "detect": {"files": ["build.gradle.kts"]},
                       "layers": [{"id": "unit"}], "keys": [{"key": "api_test_ac", "what": "test one acceptance criterion"},
                                                           {"key": "migrate", "what": "migrate the database"}],
                       "commands": {"api_test_ac": [{"cmd": "./gradlew -q test --tests '*{AC_ID}*'", "from": "build.gradle.kts"}]},
                       "tools": [{"name": "pre-commit", "run": "pre-commit run --files {FILES}", "on": "pre-commit", "fail": "block",
                                  "from": ".pre-commit-config.yaml"}]})
        if m == "GET" and path == "/api/projects/shop/stacks/kotlin-spring":
            return ok({"name": "kotlin-spring", "lane": "api", "origin": "keel", "detected": True, "removable": False,
                       "why": "It ships with keel.", "layers": [{"id": "unit"}, {"id": "body"}],
                       "commands": [{"name": "api_test_module", "cmd": "./gradlew test"}],
                       "tools": [{"name": "sonar", "off": True}], "yaml": "name: kotlin-spring\n"})
        if path == "/api/projects/shop/stacks/check":
            good = "lane: api" in body["yaml"]
            return ok({"ok": good, "errors": [] if good else ["its lane is None"], "warnings": ["there is no api_test_module"],
                       "name": "zig-api", "lane": "api" if good else None, "review": {"layers": ["unit"], "commands": {}, "tools": []},
                       "detects_here": False, "skills_missing": []})
        if path == "/api/projects/shop/stacks/save":
            return ok({"stack": {"name": "zig-api"}, "path": ".keel/stacks/zig-api.yml", "replaced": False})
        if m == "DELETE" and path == "/api/projects/shop/stacks/kotlin-spring":
            return httpx.Response(409, json={"error": "kotlin-spring ships with keel: it cannot be removed.",
                                             "hint": "Turn it off for this project instead."})
        if m == "DELETE" and path.startswith("/api/projects/shop/stacks/"):
            return ok({"name": "zig-api", "removed": ".keel/stacks/zig-api.yml", "back": None})
        if m == "PUT" and path == "/api/projects/shop/stacks/python/off":
            return ok({"name": "python", "off": body["off"], "all": ["python"] if body["off"] else []})
        if path == "/api/projects/shop/stacks/market/install":
            return ok({"stack": {"name": body["name"]}, "market": {"catalog": "keel", "name": body["name"], "version": "1.2.0"},
                       "warnings": []})
        if path == "/api/marketplace/stacks":
            return ok({"stacks": [{"name": "laravel", "title": "Laravel", "publisher": "keel", "publisher_title": "keel",
                                   "version": "1.0.0", "summary": "PHP with Laravel.", "installed": None, "review": {"lane": "api"}}],
                       "builtin": [{"name": "go", "lane": "api", "source": "keel"},
                                   {"name": "django", "lane": "api", "source": "keel pack", "installable": True}]})
        if path in ("/api/marketplace", "/api/marketplace/skills"):
            return ok({"plugins": [], "sources": [], "skills": [], "builtin": []})
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


WRITES = {"keel_stack_create", "keel_stack_remove", "keel_stack_off", "keel_stack_market_install"}


async def test_reads_are_read_and_changes_are_write():
    read = await tools("read")
    assert {"keel_stacks", "keel_stack", "keel_stack_suggest", "keel_stack_check"} <= read and not read & WRITES
    assert WRITES <= await tools("write")
    assert {"keel_stack_create", "keel_stack_remove", "keel_stack_market_install"} <= mcp_server.CONFIRM
    assert "keel_stack_off" not in mcp_server.CONFIRM


async def test_the_list_and_one_stack(stub):
    text = await call(stub, "keel_stacks", {}, level="read")
    assert text.startswith("4 stacks for shop, 2 used")
    assert "- kotlin-spring  api · keel · used · keel's own" in text
    assert "- python  api · keel · turned off · keel's own" in text
    assert "- django  api · keel pack · not used · installable pack" in text
    assert "- zig-api  api · marketplace 1.0.0 (edited) · used" in text
    one = await call(stub, "keel_stack", {"stack": "kotlin-spring"}, level="read")
    assert "not removable: It ships with keel." in one and "test layers (lowest first): unit, body" in one
    assert "  api_test_module: ./gradlew test" in one and "tool sonar: turned off" in one and one.endswith("name: kotlin-spring")


async def test_suggest_check_and_the_format(stub):
    text = await call(stub, "keel_stack_suggest", {}, level="read")
    assert "closest of keel's: kotlin-spring" in text and "read: build.gradle.kts" in text
    assert "  api_test_ac (test one acceptance criterion): ./gradlew -q test --tests '*{AC_ID}*'  [build.gradle.kts]" in text
    assert "  migrate (migrate the database): nothing found" in text and "tool pre-commit" in text
    checked = await call(stub, "keel_stack_check", {"yaml": YAML}, level="read")
    assert checked.startswith("keel would save it: zig-api (api): 1 layers") and "warning: there is no api_test_module" in checked
    assert "does not match this project's files" in checked
    assert (await call(stub, "keel_format", {"kind": "stack"}, level="read")) == formats.FORMATS["stack"]


async def test_create_checks_first_then_saves(stub):
    bad = await call(stub, "keel_stack_create", {"yaml": "name: zig-api\n"})
    assert bad.startswith("keel did not save it") and "error: its lane is None" in bad
    assert not any(p.endswith("/save") for _, p, _ in stub.calls)
    done = await call(stub, "keel_stack_create", {"yaml": YAML})
    assert ("POST", "/api/projects/shop/stacks/save", {"yaml": YAML, "replace": False}) in stub.calls
    assert done.startswith("saved the stack zig-api as .keel/stacks/zig-api.yml on shop")


async def test_remove_off_and_install(stub):
    assert await call(stub, "keel_stack_remove", {"stack": "zig-api"}) == "removed the stack zig-api from shop (.keel/stacks/zig-api.yml)."
    refused = await call(stub, "keel_stack_remove", {"stack": "kotlin-spring"})
    assert "ships with keel" in refused and "Turn it off" in refused
    assert await call(stub, "keel_stack_off", {"stack": "python"}) == "python is turned off for shop; turned off there now: python."
    assert "turned on again" in await call(stub, "keel_stack_off", {"stack": "python", "off": False})
    done = await call(stub, "keel_stack_market_install", {"name": "laravel"})
    assert ("POST", "/api/projects/shop/stacks/market/install", {"name": "laravel"}) in stub.calls
    assert done == "installed the stack laravel 1.2.0 from the catalog keel on shop (.keel/stacks/laravel.yml)."
    assert "not a stack name" in await call(stub, "keel_stack_market_install", {"name": "../x"})
    found = await call(stub, "keel_marketplace_search", {"q": ""}, level="read")
    assert "stack laravel  Laravel · api · keel · not installed · version 1.0.0" in found
    assert "stack go  keel's own (keel) · api" in found and "stack django  keel's own (keel pack) · api · an installable pack" in found


async def test_remove_asks_the_person_first(stub):
    text = await call(stub, "keel_stack_remove", {"stack": "zig-api"}, yes=False)
    assert "cannot ask you to confirm" in text and not any(m == "DELETE" for m, _, _ in stub.calls)


def test_keelbots_stack_button_is_named_as_the_tool_that_saves_it():
    from keel_engine.mcp_tui import _buttons_hint
    hint = _buttons_hint("Here:\n```keel-stack\nname: zig-api\nlane: api\n```")
    assert "save the stack zig-api: keel_stack_create(yaml=<the keel-stack block, whole>)" in hint
