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
    for want in ("DELETE /old: endpoint removed", "GET /ranks parameter page (query): new and required",
                 "GET /ranks response 404: removed", "GET /ranks response 200.score: removed",
                 "GET /ranks response 200.player: may be null now", "POST /ranks request body.name: narrowed (maxLength 50 -> 20)",
                 "POST /ranks request body.tier: enum narrowed, drops c", "POST /ranks request body.code: new required field",
                 "POST /ranks request body.note: now required"):
        assert want in breaks, want
    changed = "\n".join(d["changed"])
    assert "GET /ranks response 409: new" in changed and "GET /ranks response 200.level: enum adds z" in changed
    assert "level" not in breaks


def test_a_new_contract_is_all_new_and_a_non_openapi_file_is_not_classified():
    new = cd.classify(None, OLD)
    assert (new["new"], new["changed"], new["breaks"]) == (["GET /ranks", "POST /ranks", "DELETE /old"], [], [])
    assert cd.load("# Contract\n\nNo HTTP surface.") is None and cd.load(yaml.safe_dump(OLD))["openapi"] == "3.0.0"
    lines = cd.describe("api.yaml", cd.classify(OLD, new_doc()))
    assert lines[0] == "### `api.yaml` · OpenAPI" and lines[2].startswith("| endpoint or field | change |")
    assert "| `DELETE /old` | endpoint removed | - | - | **no**: callers of it break |" in lines[2]
    assert "is not an OpenAPI document or a JSON Schema" in cd.describe("c.md", None, 3)[2] and "3 removed line(s)" in cd.describe("c.md", None, 3)[2]
    assert cd.describe("api.yaml", {"kind": "openapi", "new": [], "changed": [], "breaks": [], "rows": []})[2].startswith("Nothing a caller")


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
    assert show.startswith("## In plain words\n\n") and show.index("## What changes") < show.index("## Compatibility") < show.index("## Diff")
    assert "| `GET /ranks response 200.score` | removed |" in show and "| `DELETE /old` | endpoint removed |" in show
    assert "**Verdict: breaks: `DELETE /old` endpoint removed" in show
    assert "\n```diff\ndiff --git a/docs/contract/openapi.yaml" in show and show.rstrip().endswith("```")
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


# ------------------------------------------------------------------ JSON Schema (message contracts)

MSG = {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "webhook_tracking_update", "type": "object",
       "required": ["shipment_id", "status"],
       "properties": {"shipment_id": {"type": "string"}, "status": {"type": "string", "enum": ["in_transit", "delivered"]},
                      "note": {"type": ["string", "null"]}, "count": {"type": "integer"}, "ref": {"type": "string"}}}


def edit(fn):
    doc = yaml.safe_load(yaml.safe_dump(MSG))
    fn(doc)
    return cd.classify_schema(MSG, doc)


def rows(d):
    return {(r["field"], r["change"]): r for r in d["rows"]}


def test_a_json_schema_is_loaded_and_an_openapi_or_config_file_is_not():
    import json
    assert cd.load_schema(json.dumps(MSG), "config/contracts/messages/x.json")["title"] == "webhook_tracking_update"
    assert cd.load_schema(yaml.safe_dump(OLD), "docs/contract/openapi.yaml") is None
    assert cd.load_schema('{"$schema": "https://biomejs.dev/schemas/1.0/schema.json", "linter": {}}', "biome.json") is None
    assert cd.load_schema('{"type": "object", "$defs": {}}', "config/contracts/a.json") is not None
    assert cd.load_schema('{"type": "object"}', "src/a.json") is None


def test_added_optional_fields_are_new_and_safe():
    def add(doc):
        doc["properties"]["expected_delivery"] = {"type": ["string", "null"], "description": "The ETA"}
        doc["properties"]["vat_updated_at"] = {"type": ["string", "null"], "description": "When the vendor last changed it"}
    d = edit(add)
    assert d["kind"] == "json-schema" and d["breaks"] == [] and d["new"] == ["expected_delivery", "vat_updated_at"]
    r = rows(d)[("expected_delivery", "new")]
    assert r["safe"] and r["required"] == "no" and r["type"] == "string or null" and r["desc"] == "the ETA"
    words = cd.plain_words("config/contracts/messages/webhook_tracking_update.json", d, MSG)
    assert words == ("The queue message `webhook_tracking_update` gets two new optional fields: `expected_delivery` (the ETA) and "
                     "`vat_updated_at` (when the vendor last changed it). Old messages without them stay valid. Nothing is "
                     "removed or made required.")
    assert cd.verdict_text([d]) == "safe for a rolling deploy"


def test_an_added_required_field_breaks_old_producers():
    def add(doc):
        doc["properties"]["carrier"] = {"type": "string"}
        doc["required"].append("carrier")
    d = edit(add)
    r = rows(d)[("carrier", "new")]
    assert not r["safe"] and r["required"] == "yes" and "old producers" in r["why"]
    assert d["breaks"] == ["carrier: new"] and cd.verdict_text([d]).startswith("breaks: `carrier` new (old producers")
    assert "new required field" in cd.plain_words("config/contracts/messages/m.json", d, MSG)


def test_a_removed_field_or_one_no_longer_required_breaks_consumers():
    def drop(doc):
        del doc["properties"]["ref"]
        doc["required"] = ["shipment_id"]
    d = edit(drop)
    assert not rows(d)[("ref", "removed")]["safe"] and "consumers" in rows(d)[("ref", "removed")]["why"]
    assert not rows(d)[("status", "no longer required (may be missing)")]["safe"]
    assert "`ref` is removed: consumers that still read it break." in cd.plain_words("config/contracts/messages/m.json", d, MSG)


def test_a_narrowed_type_breaks_and_a_widened_one_is_safe():
    def narrow(doc):
        doc["properties"]["note"]["type"] = "string"           # null no longer allowed
        doc["properties"]["count"]["type"] = ["integer", "null"]  # widened
        doc["properties"]["status"]["enum"] = ["in_transit"]   # enum narrowed
        doc["properties"]["shipment_id"]["maxLength"] = 36     # a limit added
    d = edit(narrow)
    r = rows(d)
    assert not r[("note", "type narrowed (string or null -> string)")]["safe"]
    assert r[("count", "type widened (integer -> integer or null)")]["safe"]
    assert not r[("status", "enum narrowed, drops delivered")]["safe"]
    assert not r[("shipment_id", "narrowed (maxLength none -> 36)")]["safe"]
    d = edit(lambda doc: doc["properties"]["count"].update(type="number"))
    assert rows(d)[("count", "type widened (integer -> number)")]["safe"]


def test_additional_properties_closed_breaks_and_opened_is_safe():
    d = edit(lambda doc: doc.update(additionalProperties=False))
    r = rows(d)[("(other fields)", "additionalProperties: false (fields not listed are refused)")]
    assert not r["safe"] and "other fields" in r["why"]
    closed = {**MSG, "additionalProperties": False}
    d = cd.classify_schema(closed, MSG)
    assert d["breaks"] == [] and rows(d)[("(other fields)", "additionalProperties allowed now")]["safe"]


def test_nested_objects_and_refs_are_compared_field_by_field():
    old = {"type": "object", "properties": {"eta": {"$ref": "#/$defs/Eta"}}, "$defs": {"Eta": {"type": "object", "properties": {
        "at": {"type": "string"}}}}}
    new = yaml.safe_load(yaml.safe_dump(old))
    new["$defs"]["Eta"]["properties"]["source"] = {"type": "string"}
    new["$defs"]["Eta"]["required"] = ["at"]
    d = cd.classify_schema(old, new)
    assert ("eta.source", "new") in rows(d) and not rows(d)[("eta.at", "now required")]["safe"]
    assert cd.classify_schema(None, MSG)["breaks"] == [] and len(cd.classify_schema(None, MSG)["rows"]) == 5


def test_the_message_contract_gate_starts_in_plain_words_and_fences_the_diff(tmp_path):
    import json
    root, write = _repo(tmp_path, "version: 4\n")
    f = "config/contracts/messages/webhook_tracking_update.json"
    write(root, f, json.dumps(MSG, indent=2) + "\n")
    from test_v02 import commit_all
    commit_all(root, "msg")
    doc = yaml.safe_load(yaml.safe_dump(MSG))
    doc["properties"]["expected_delivery"] = {"type": ["string", "null"], "description": "The ETA"}
    doc["properties"]["vat_updated_at"] = {"type": ["string", "null"], "description": "When the vendor last changed it"}
    write(root, f, json.dumps(doc, indent=2) + "\n")
    a = ActionInput(root=str(root), project="p", phase="contract", title="t", ac=None, acs=[], fake=True, flow="feature",
                    step="contract_diff")
    r = asyncio.run(run_action("show_diff", a))
    show = r.update["show"]
    assert show.startswith("## In plain words\n\nThe queue message `webhook_tracking_update` gets two new optional fields")
    assert "| `vat_updated_at` | new | string or null | no | yes: old messages without it stay valid |" in show
    assert "**Verdict: safe for a rolling deploy.**" in show
    assert f"`{f}` (+" in show and "\n```diff\n" in show and "+    \"vat_updated_at\": {" in show
    assert "webhook*tracking" not in show and r.note == "contract delta: nothing breaks callers"
    assert r.update["data"]["contract_delta"][f]["kind"] == "json-schema"
