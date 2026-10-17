"""Stacks in the marketplace (keel 0.18.9): the fifth kind of the one kinds table. A stacks entry's checks, the review keel
builds from a stack YAML, search and the kind filter, one stack, and fetch with each of its refusals."""

import hashlib

import yaml

from keel_engine.marketplace import catalog, kinds, signing, stacks
from marketplace_kit import STACK, market, server  # noqa: F401 - fixtures
from test_pluginhost import data, image  # noqa: F401 - fixtures


def test_the_stacks_row_and_the_review():
    assert (kinds.STACKS.list, kinds.STACKS.suffix, kinds.STACKS.max_size) == ("stacks", ".yaml", 64 << 10)
    assert catalog.KINDS[-1] == "stacks" and catalog.MAX_STACK == 64 << 10 and "stacks" in catalog.RESERVED
    doc = yaml.safe_load(STACK.format(name="zig", version="1.0.0"))
    assert kinds.stack_review(doc) == {
        "lane": "api", "detect": {"files": ["build.zig"], "extensions": [".zig"]}, "layers": ["unit"],
        "commands": {"api_test_ac": "zig build test -Dfilter={AC_ID}", "api_test_module": "zig build test", "api_compile": "zig build"},
        "tools": [{"name": "zig-fmt", "run": "zig fmt {FILES}", "on": "edit", "fail": "fix"}], "skills": []}
    # tolerant: odd parts read as empty, a tool turned off has no command, skills as a map or a list
    assert kinds.stack_review({"tools": {"sonar": False}, "skills": {"testing": "t"}, "layers": "x"}) == {
        "lane": "", "detect": {}, "layers": [], "commands": {}, "tools": [{"name": "sonar", "run": "", "on": "off", "fail": ""}],
        "skills": ["t"]}
    assert kinds.stack_review("nope")["commands"] == {}


def test_broken_stack_entries_are_left_out(market):
    market.publish_stack("good", "1.0.0")
    market.publish_stack("big", "1.0.0", size=(64 << 10) + 1)
    market.publish_stack("noreview", "1.0.0")
    market.stacks["noreview"]["versions"][0].pop("review")
    market.publish_stack("badlane", "1.0.0", review={"lane": 3})
    market.publish_stack("badtools", "1.0.0", review={"lane": "api", "tools": [{"name": "x"}]})
    doc = market.index()
    doc["stacks"].append({**doc["stacks"][0], "name": "Bad_Name"})
    doc["stacks"].append({**doc["stacks"][0], "name": "kinded", "kind": "skills"})
    market.serve(doc)
    market.add_source()
    [_, test] = catalog.refresh()
    assert sorted(catalog.indexes()[0].stacks) == ["good"]
    text = "\n".join(test["problems"])
    for word in ("stack big 1.0.0: size must be a number of bytes up to 65,536", "stack noreview 1.0.0: review is missing",
                 "stack badlane 1.0.0: review.lane is not text", "stack badtools 1.0.0: review.tools has an item",
                 "stack name 'Bad_Name' does not follow keel's name rule", "stack kinded: its kind is 'skills', in the stacks list"):
        assert word in text, word


def test_search_one_stack_and_the_kind_filter(client, market):
    market.publish("hello", "1.0.0")
    market.publish_stack("zig", "1.0.0", title="Zig")
    market.publish_stack("zig", "1.1.0", title="Zig")
    market.publish_stack("laravel", "1.0.0", category="php")
    market.revoked.append({"name": "zig", "version": "1.1.0", "kind": "stacks", "why": "a wrong command"})
    market.ready()
    body = client.get("/marketplace/stacks").json()
    assert [h["name"] for h in body["stacks"]] == ["laravel", "zig"]
    zig = body["stacks"][1]
    assert (zig["version"], zig["latest"], zig["trust"], zig["kind"]) == ("1.0.0", "1.1.0", "content", "stacks")
    assert zig["review"]["layers"] == ["unit"] and body["categories"] == list(catalog.STACKS_CATEGORIES)
    assert [h["name"] for h in client.get("/marketplace/stacks", params={"category": "php"}).json()["stacks"]] == ["laravel"]
    assert client.get("/marketplace/search", params={"kind": "stacks"}).json()["stacks"] == body["stacks"]
    every = client.get("/marketplace/search", params={"kind": "all"}).json()
    assert [h["name"] for h in every["stacks"]] == ["laravel", "zig"] and every["stacks_categories"] == list(catalog.STACKS_CATEGORIES)
    one = client.get("/marketplace/stacks/zig").json()
    assert [(v["version"], v["revoked"], v["fits"]) for v in one["versions"]] == [("1.1.0", "a wrong command", False), ("1.0.0", None, True)]
    assert one["checks"] == stacks.CHECKS
    assert client.get("/marketplace/stacks/nothing").status_code == 404
    assert client.get("/marketplace/stacks/Bad_Name").status_code == 400


def test_fetch_gives_the_verified_yaml(client, market):
    market.publish_stack("zig", "1.0.0")
    market.ready()
    got = client.post("/marketplace/stacks/zig/fetch", json={}).json()
    assert got["yaml"] == STACK.format(name="zig", version="1.0.0")
    assert (got["name"], got["version"], got["publisher"], got["catalog"], got["category"]) == ("zig", "1.0.0", "keel", "test", "other")
    assert got["review"] == kinds.stack_review(yaml.safe_load(got["yaml"])) and got["warnings"] == []
    assert client.post("/marketplace/stacks/zig/fetch", json={"version": "9.9.9"}).status_code == 404


def test_fetch_refusals(client, market):
    stranger = signing.keygen()
    market.publish_stack("unsigned", "1.0.0", sign_with=stranger)
    market.publish_stack("changed", "1.0.0", sha256=hashlib.sha256(b"other").hexdigest())
    market.publish_stack("renamed", "1.0.0", text=STACK.format(name="other", version="1.0.0"))
    market.publish_stack("versioned", "1.0.0", text=STACK.format(name="versioned", version="1") + "version: 2.0.0\n")
    market.publish_stack("broken", "1.0.0", text="name: broken\nlane: desktop\n")
    market.publish_stack("notyaml", "1.0.0", text="name: [x\n", review={"lane": ""})
    market.publish_stack("lies", "1.0.0", review={"lane": "web"})
    market.publish_stack("future", "1.0.0", keel=">=99.0.0")
    market.ready()

    def refused(name):
        r = client.post(f"/marketplace/stacks/{name}/fetch", json={})
        return r.status_code, r.json()["error"]

    assert refused("unsigned")[0] == 502 and "signature" in refused("unsigned")[1]
    assert refused("changed")[0] == 502 and "sha256" in refused("changed")[1]
    assert refused("renamed") == (502, "renamed 1.0.0 is not the stack the catalog lists: its name is other, the catalog says renamed.")
    assert "its version is 2.0.0" in refused("versioned")[1]
    status, error = refused("broken")
    assert status == 502 and "is not a stack keel can use" in error and "its lane is 'desktop'" in error
    assert refused("notyaml") == (502, "notyaml 1.0.0 is not a YAML file keel can read.")
    lies = client.post("/marketplace/stacks/lies/fetch", json={})
    assert lies.status_code == 409 and lies.json()["differences"][0].startswith("lane: keel finds")
    assert refused("future")[0] == 409 and "needs keel >=99.0.0" in refused("future")[1]


def test_the_tools_review_is_the_engines_on_keels_own_stacks():
    """keel-plugin (tools/keel-plugin, keel_plugin.stack.review, its own YAML reader) builds the review the catalog lists;
    keel's engine computes it again at fetch with PyYAML: the two must agree, here on every stack keel ships."""
    import sys
    from pathlib import Path
    repo = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(repo / "tools/keel-plugin"))
    try:
        from keel_plugin import miniyaml
        from keel_plugin import stack as tool
    finally:
        sys.path.pop(0)
    files = sorted(repo.glob("content/stacks/*.yml")) + sorted(repo.glob("content/packs/*/stack.yml"))
    assert len(files) >= 7
    for f in files:
        text = f.read_text(encoding="utf-8")
        assert tool.review(miniyaml.loads(text)) == kinds.stack_review(yaml.safe_load(text)), f
