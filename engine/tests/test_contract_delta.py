"""The contract delta classifier (runtime/contract_delta.py): each OpenAPI operation as new, changed, or breaking callers
(removed or narrowed), and the contract step's codegen + fast check before its gate."""

import asyncio

import yaml

from keel_engine.runtime import contract_delta as cd
from keel_engine.runtime.actions import ActionInput, run_action

OLD = {
    "openapi": "3.0.0",
    "paths": {
        "/ranks": {
            "get": {"parameters": [{"in": "query", "name": "season", "schema": {"type": "string"}}],
                    "responses": {"200": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Rank"}}}},
                                  "404": {"description": "none"}}},
            "post": {"requestBody": {"content": {"application/json": {"schema": {
                "type": "object", "required": ["name"],
                "properties": {"name": {"type": "string", "maxLength": 50}, "tier": {"type": "string", "enum": ["a", "b", "c"]},
                               "note": {"type": "string"}}}}}},
                     "responses": {"201": {"description": "made"}}},
        },
        "/old": {"delete": {"responses": {"204": {"description": "gone"}}}},
    },
    "components": {"schemas": {"Rank": {"type": "object", "required": ["score", "player"],
                                        "properties": {"score": {"type": "integer"}, "player": {"type": "string"},
                                                       "level": {"type": "string", "enum": ["x", "y"]}}}}},
}


def new_doc():
    doc = yaml.safe_load(yaml.safe_dump(OLD))
    rank = doc["components"]["schemas"]["Rank"]
    del rank["properties"]["score"]                                 # a response field removed
    rank["required"] = ["player"]
    rank["properties"]["player"]["nullable"] = True                 # may be null now
    rank["properties"]["level"]["enum"] = ["x", "y", "z"]           # widened: changed, not breaking
    get = doc["paths"]["/ranks"]["get"]
    get["parameters"].append({"in": "query", "name": "page", "required": True, "schema": {"type": "integer"}})
    del get["responses"]["404"]
    get["responses"]["409"] = {"description": "conflict"}
    body = doc["paths"]["/ranks"]["post"]["requestBody"]["content"]["application/json"]["schema"]
    body["properties"]["name"]["maxLength"] = 20                    # narrowed
    body["properties"]["tier"]["enum"] = ["a", "b"]                  # enum narrowed
    body["properties"]["code"] = {"type": "string"}
    body["required"] = ["name", "code", "note"]                     # a new required field, an old one now required
    del doc["paths"]["/old"]
    doc["paths"]["/ranks/{id}"] = {"get": {"responses": {"200": {"description": "one"}}}}
    return doc


def test_classify_sorts_new_changed_and_breaking():
    d = cd.classify(OLD, new_doc())
    assert d["new"] == ["GET /ranks/{id}"]
    breaks = "\n".join(d["breaks"])
    for want in ("DELETE /old: endpoint removed", "GET /ranks: parameter page (query) new and required",
                 "GET /ranks: response 404 removed", "GET /ranks response 200.score: removed",
                 "GET /ranks response 200.player: may be null now", "POST /ranks request body.name: narrowed (maxLength 50 -> 20)",
                 "POST /ranks request body.tier: enum narrowed, drops c", "POST /ranks request body.code: new required field",
                 "POST /ranks request body.note: now required"):
        assert want in breaks, want
    changed = "\n".join(d["changed"])
    assert "GET /ranks: new response 409" in changed and "GET /ranks response 200.level: enum adds z" in changed
    assert "level" not in breaks


def test_a_new_contract_is_all_new_and_a_non_openapi_file_is_not_classified():
    assert cd.classify(None, OLD) == {"new": ["GET /ranks", "POST /ranks", "DELETE /old"], "changed": [], "breaks": []}
    assert cd.load("# Contract\n\nNo HTTP surface.") is None and cd.load(yaml.safe_dump(OLD))["openapi"] == "3.0.0"
    lines = cd.describe("api.yaml", cd.classify(OLD, new_doc()))
    assert lines[1] == "  Breaks callers (removed or narrowed):" and "  New:" in lines
    assert "removed line(s)" in cd.describe("c.md", None, 3)[0]
    assert cd.describe("api.yaml", {"new": [], "changed": [], "breaks": []})[1].startswith("  no operation changed")


def _repo(tmp_path, config):
    from test_v02 import commit_all, git, write
    root = tmp_path / "p"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    write(root, ".keel/config.yml", config)
    write(root, "docs/contract/openapi.yaml", yaml.safe_dump(OLD))
    commit_all(root, "init")
    return root, write


def test_show_diff_lists_what_breaks_callers_on_the_contract_gate(tmp_path):
    root, write = _repo(tmp_path, "version: 4\ncontract: {file: docs/contract/openapi.yaml}\n")
    write(root, "docs/contract/openapi.yaml", yaml.safe_dump(new_doc()))
    a = ActionInput(root=str(root), project="p", phase="contract", title="t", ac=None, acs=[], fake=True, flow="feature",
                    step="contract_diff")
    r = asyncio.run(run_action("show_diff", a))
    show = r.update["show"]
    assert show.index("Breaks callers (removed or narrowed):") < show.index("Uncommitted change")
    assert "GET /ranks response 200.score: removed" in show and "DELETE /old: endpoint removed" in show
    assert r.update["data"]["contract_delta"]["docs/contract/openapi.yaml"]["new"] == ["GET /ranks/{id}"]
    assert "break callers" in r.note


def test_contract_check_runs_codegen_and_the_fast_check_and_fails_before_the_gate(tmp_path):
    cfg = ("version: 4\ncontract: {file: docs/contract/openapi.yaml}\n"
           "commands: {codegen: 'echo generated > gen.txt', contract_lint: 'grep -q openapi docs/contract/openapi.yaml'}\n")
    root, write = _repo(tmp_path, cfg)
    a = ActionInput(root=str(root), project="p", phase="contract", title="t", ac=None, acs=[], fake=False, flow="feature",
                    step="contract_check")
    assert asyncio.run(run_action("contract_check", a)).note == "no contract change to check"
    write(root, "docs/contract/openapi.yaml", yaml.safe_dump(new_doc()))
    r = asyncio.run(run_action("contract_check", a))
    assert r.ok and "codegen ran" in r.note and "contract lint passed" in r.note, r.note
    assert (root / "gen.txt").is_file()
    write(root, "docs/contract/openapi.yaml", "paths: {}\n")         # the lint fails: no openapi line
    r = asyncio.run(run_action("contract_check", a))
    assert not r.ok and r.note.startswith("The contract does not build: Fast check: contract lint failed")
    write(root, ".keel/config.yml", cfg.replace("echo generated > gen.txt", "exit 3"))
    r = asyncio.run(run_action("contract_check", a))
    assert not r.ok and r.note == "Codegen failed on the new contract: exit 3"
