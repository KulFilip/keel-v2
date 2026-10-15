"""Rule packs in the marketplace (docs/plugins/23-rules-in-marketplace.md §2): the third kind of the one kinds table.
An index with all three kinds, a rules entry's checks (size, sha256, publisher, review, kind), revoked by kind, the
search's kind filter, one pack, the pack review keel builds from a YAML, and the plugin and workflow answers the same
as before with rule packs in the index."""

import pytest

from keel_engine.marketplace import catalog, kinds, rulepacks, workflows
from marketplace_kit import RULES, market, server  # noqa: F401 - fixtures
from test_pluginhost import data, image  # noqa: F401 - fixtures


def test_the_kinds_table():
    assert [(k.name, k.list, k.suffix, k.max_size) for k in kinds.TABLE] == [
        ("plugin", "plugins", ".kplug", 200 << 20), ("workflow", "workflows", ".yaml", 256 << 10),
        ("rules", "rules", ".yaml", 64 << 10)]
    assert catalog.KINDS == ("plugin", "workflow", "rules") and catalog.MAX_RULES == 64 << 10
    assert catalog.RESERVED == ("workflows", "rules", "refresh")


def test_an_index_with_all_three_kinds(market):
    market.publish("notes", "1.0.0")
    market.publish_workflow("notes", "1.0.0")
    market.publish_rules("notes", "1.0.0")
    market.publish_rules("no-new-deps", "1.0.0")
    market.publish_rules("no-new-deps", "1.1.0")
    [_, test] = market.ready()
    assert test["ok"] and test["problems"] == [] and test["plugins"] == 1 and test["workflows"] == 1
    index = catalog.indexes()[0]
    assert sorted(index.rules) == ["no-new-deps", "notes"] and list(index.entries("rules")) == list(index.rules)
    pack = index.rules["no-new-deps"]
    assert [v.version for v in pack.versions] == ["1.1.0", "1.0.0"] and pack.category == "safety"
    assert pack.versions[0].review == {"rules": 2, "kinds": {"bash": 1, "edit": 1},
                                      "phases": ["all", "green", "refactor"], "lanes": ["web"]}
    # one name in three lists: three entries, each of its own kind
    assert catalog.lookup_kind("plugin", "notes")[1].trust == "web"
    assert catalog.lookup_kind("workflow", "notes")[1].kind == "workflow"
    assert catalog.lookup_kind("rules", "notes")[1].kind == "rules"


def test_an_older_index_without_rules_reads_as_before(client, market):
    market.publish("hello", "1.0.0")
    doc = market.index()
    assert "workflows" not in doc and "rules" not in doc
    market.serve(doc)
    market.add_source()
    [_, test] = catalog.refresh()
    assert test["ok"] and test["problems"] == [] and catalog.indexes()[0].rules == {}
    assert client.get("/marketplace/rule-packs").json()["rules"] == []
    assert client.get("/marketplace/search", params={"kind": "rules"}).json()["rules"] == []


def test_broken_rules_entries_are_left_out_and_the_rest_is_used(market):
    market.publish_rules("good", "1.0.0")
    market.publish_rules("big", "1.0.0", size=(64 << 10) + 1)                  # more than 64 KB
    market.publish_rules("nosha", "1.0.0", sha256="xyz")
    market.publish_rules("stranger", "1.0.0", publisher="nobody")
    market.publish_rules("noreview", "1.0.0")
    market.rules["noreview"]["versions"][0].pop("review")
    market.publish_rules("badsum", "1.0.0", review={"rules": 3, "kinds": {"bash": 1}, "phases": [], "lanes": []})
    market.publish_rules("badphases", "1.0.0", review={"rules": 1, "kinds": {"bash": 1}, "phases": "all"})
    market.publish_rules("plainhttp", "1.0.0")
    market.rules["plainhttp"]["versions"][0]["url"] = "http://example.com/x.yaml"
    market.publish_rules("badversion", "1.0.0")
    market.publish_rules("badversion", "1.1.0")
    market.rules["badversion"]["versions"][1]["version"] = "1.1"
    doc = market.index()
    doc["rules"].append({**doc["rules"][0], "name": "kinded", "kind": "workflow"})
    doc["rules"].append({**doc["rules"][0], "name": "Bad_Name"})
    doc["rules"].append(doc["rules"][0])
    doc["rules"].append("not an object")
    market.serve(doc)
    market.add_source()
    [_, test] = catalog.refresh()
    index = catalog.indexes()[0]
    assert sorted(index.rules) == ["badversion", "good"]
    assert [v.version for v in index.rules["badversion"].versions] == ["1.0.0"]
    text = "\n".join(test["problems"])
    for word in ("rule pack big 1.0.0: size must be a number of bytes up to 65,536", "rule pack nosha 1.0.0: sha256",
                 "rule pack stranger: its publisher 'nobody' is not listed", "rule pack noreview 1.0.0: review is missing",
                 "rule pack badsum 1.0.0: review.kinds does not add up to review.rules",
                 "rule pack badphases 1.0.0: review.phases is not a list of text", "rule pack plainhttp 1.0.0:",
                 "rule pack badversion: version '1.1'", "rule pack kinded: its kind is 'workflow', in the rules list",
                 "rule pack name 'Bad_Name' does not follow keel's name rule", "rule pack good is listed twice",
                 "a rule pack is not an object"):
        assert word in text, word
    assert test["plugins"] == 0 and test["workflows"] == 0


def test_revoked_by_kind(client, market):
    market.publish("strict", "1.1.0")
    market.publish_rules("strict", "1.0.0")
    market.publish_rules("strict", "1.1.0")
    market.revoked.append({"name": "strict", "version": "1.1.0", "kind": "rules", "why": "it blocks git commit"})
    market.ready()
    index = catalog.indexes()[0]
    assert index.why_revoked("strict", "1.1.0", "rules") == "it blocks git commit"
    assert index.why_revoked("strict", "1.1.0") is None and index.why_revoked("strict", "1.1.0", "workflow") is None
    [hit] = client.get("/marketplace/rule-packs").json()["rules"]
    assert (hit["version"], hit["latest"], hit["fits"]) == ("1.0.0", "1.1.0", True)
    assert [h["version"] for h in catalog.search()["plugins"]] == ["1.1.0"]       # the plugin is not revoked
    one = client.get("/marketplace/rule-packs/strict").json()
    assert [(v["version"], v["revoked"], v["fits"]) for v in one["versions"]] == [
        ("1.1.0", "it blocks git commit", False), ("1.0.0", None, True)]
    assert one["versions"][0]["why_not"] == "strict 1.1.0 is revoked: it blocks git commit"


def test_search_by_kind_and_the_hit_shape(client, market):
    market.publish("hello", "1.0.0", title="Strict hello")
    market.publish_workflow("release-notes", "1.0.0", title="Strict notes")
    market.publish_rules("no-new-deps", "1.0.0", title="No new dependencies")
    market.publish_rules("strict-git", "1.0.0", title="Strict git", category="git")
    market.ready()
    body = client.get("/marketplace/rule-packs", params={"q": "strict"}).json()
    assert set(body) == {"rules", "sources", "categories"} and body["categories"] == list(catalog.RULES_CATEGORIES)
    [hit] = body["rules"]
    assert hit == {
        "name": "strict-git", "kind": "rules", "title": "Strict git", "publisher": "keel", "publisher_title": "keel",
        "verified": True, "version": "1.0.0", "summary": "The strict-git rule pack for tests.", "category": "git",
        "tags": ["strict-git", "test"],
        "review": {"rules": 2, "kinds": {"bash": 1, "edit": 1}, "phases": ["all", "green", "refactor"],
                   "lanes": ["web"]},
        "requires": {}, "fits": True, "refused": None, "source": "test",
        "repo": "https://github.com/keel-studio/keel-rules", "latest": "1.0.0", "old": False, "why_not": None,
        "trust": "content"}
    assert [h["name"] for h in client.get("/marketplace/rule-packs", params={"category": "safety"}).json()["rules"]] \
        == ["no-new-deps"]
    # the search's kind filter
    only = client.get("/marketplace/search", params={"q": "strict", "kind": "rules"}).json()
    assert only == {**body, "sources": only["sources"]}
    plugins = client.get("/marketplace/search", params={"q": "strict"}).json()
    assert set(plugins) == {"plugins", "sources", "categories"} and [h["name"] for h in plugins["plugins"]] == ["hello"]
    every = client.get("/marketplace/search", params={"q": "strict", "kind": "all"}).json()
    assert [h["name"] for h in every["plugins"]] == ["hello"]
    assert [h["name"] for h in every["workflows"]] == ["release-notes"]
    assert [h["name"] for h in every["rules"]] == ["strict-git"]
    assert every["rules_categories"] == list(catalog.RULES_CATEGORIES)
    assert every["workflow_categories"] == list(catalog.WORKFLOW_CATEGORIES)
    assert client.get("/marketplace/search", params={"kind": "packs"}).status_code == 400
    # /marketplace/rules stays the four marketplace rules
    assert set(client.get("/marketplace/rules").json()) == {"agents_may_ask", "allow_unverified", "check_daily",
                                                            "restart_when_idle"}


def test_one_rule_pack(client, market):
    market.publish_rules("no-new-deps", "1.0.0")
    market.publish_rules("no-new-deps", "2.0.0", keel=">=99.0.0")
    market.ready()
    one = client.get("/marketplace/rule-packs/no-new-deps").json()
    assert one["version"] == "1.0.0" and one["latest"] == "2.0.0" and one["fits"] is True and one["refused"] is None
    assert one["checks"] == rulepacks.CHECKS
    v2, v1 = one["versions"]
    assert v2["fits"] is False and v2["why_not"].startswith("needs keel >=99.0.0") and v2["requires"] == {"keel": ">=99.0.0"}
    assert set(v1) == {"version", "released", "requires", "review", "url", "size", "sha256", "revoked", "fits", "why_not"}
    r = client.get("/marketplace/rule-packs/nope")
    assert r.status_code == 404 and r.json()["error"] == "There is no rule pack nope in the catalogs keel reads."
    assert client.get("/marketplace/rule-packs/Bad_Name").status_code == 400
    # no install route for a pack (the rules session's api installs it)
    assert client.post("/marketplace/rule-packs/no-new-deps/fetch", json={}).status_code in (404, 405)


def test_no_version_for_this_keel_and_an_old_catalog_are_refused(client, market):
    market.publish_rules("future", "1.0.0", keel=">=99.0.0")
    market.ready()
    one = client.get("/marketplace/rule-packs/future").json()
    assert one["version"] is None and one["fits"] is False and one["why_not"].startswith("needs keel >=99.0.0")
    assert one["refused"]["error"].startswith("No version of Future can be installed")
    market.expires = "2020-01-01T00:00:00Z"
    market.built = "2026-10-10T06:00:00Z"
    market.ready()
    one = client.get("/marketplace/rule-packs/future").json()
    assert one["old"] is True and one["refused"]["error"].startswith("The catalog test is old")


def test_the_pack_review_keel_builds_from_a_yaml():
    import yaml
    assert kinds.pack_review(yaml.safe_load(RULES.format(name="x", version="1.0.0"))) == {
        "rules": 2, "kinds": {"bash": 1, "edit": 1}, "phases": ["all", "green", "refactor"], "lanes": ["web"]}
    doc = {"id": "p", "name": "P", "owner": "someone",         # unknown fields are read past
           "rules": [{"id": "a", "kind": "mcp", "how": "name", "match": "db_change", "reason": "x", "severity": 3},
                     {"id": "b", "kind": "read", "phases": "in-flow", "lanes": "api"},
                     {"id": "c", "kind": "bash", "phases": ["green"]},
                     {"id": "d", "kind": "teleport"},
                     "not a rule"]}
    assert kinds.pack_review(doc) == {"rules": 4, "kinds": {"bash": 1, "read": 1, "mcp": 1, "teleport": 1},
                                      "phases": ["all", "in-flow", "green"], "lanes": ["api"]}
    assert kinds.pack_review({"rules": "none"}) == {"rules": 0, "kinds": {}, "phases": [], "lanes": []}
    assert kinds.pack_review(None) == {"rules": 0, "kinds": {}, "phases": [], "lanes": []}
    assert kinds.RULES.summarise is kinds.pack_review


@pytest.fixture
def loaded(monkeypatch):
    from keel_engine.marketplace import local
    monkeypatch.setattr(local, "loaded", lambda: {})


def _answers(client) -> dict:
    """The plugin and workflow answers, without the moment each source was read."""
    def clean(body):
        if isinstance(body, dict) and "sources" in body:
            body = {**body, "sources": [{k: v for k, v in s.items() if k != "fetched_at"} for s in body["sources"]]}
        return body

    return {path: clean(client.get(path, params=params).json()) for path, params in (
        ("/marketplace/search", {}), ("/marketplace/search", {"q": "notes"}), ("/marketplace/search", {"kind": "workflow"}),
        ("/marketplace/plugins/hello", {}), ("/marketplace/workflows", {}), ("/marketplace/workflows/release-notes", {}),
        ("/marketplace/sources", {}))} | {"fetch": client.post("/marketplace/workflows/release-notes/fetch").json()}


def test_plugin_and_workflow_answers_are_the_same_with_rule_packs_in_the_index(client, market, loaded):
    market.publish("hello", "1.0.0")
    market.publish("hello", "1.1.0")
    market.publish_workflow("release-notes", "1.0.0")
    market.revoked.append({"name": "hello", "version": "1.1.0", "why": "a bug"})
    market.ready()
    before = _answers(client)
    market.publish_rules("hello", "1.0.0")
    market.publish_rules("release-notes", "1.1.0")
    market.revoked.append({"name": "release-notes", "version": "1.0.0", "kind": "rules", "why": "a pack's"})
    market.ready()
    assert len(catalog.indexes()[0].rules) == 2
    assert _answers(client) == before
    assert workflows.search()["workflows"][0]["version"] == "1.0.0"
