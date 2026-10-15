"""Workflows in the marketplace (docs/plugins/21-workflow-marketplace.md): the catalog's kinds (workflows, rules,
kind on an entry and on a revoked one), an older index without them, search across kinds, one workflow, and the
fetch with its checks (sha256, signature, size, revoked, old catalog, keel version, needed plugins)."""

import json

import pytest

from keel_engine.marketplace import MarketError, catalog, local, workflows
from keel_engine.marketplace.signing import keygen
from marketplace_kit import market, server  # noqa: F401 - fixtures
from test_pluginhost import data, image  # noqa: F401 - fixtures


@pytest.fixture
def loaded(monkeypatch):
    """The plugins keel's last start loaded (run/resolved.json), as a test sets them."""
    have: dict[str, str] = {}
    monkeypatch.setattr(local, "loaded", lambda: dict(have))
    return have


# ------------------------------------------------------------------ the catalog's kinds

def test_an_older_index_without_workflows_reads_as_before(market):
    market.publish("hello", "1.0.0")
    doc = market.index()
    assert "workflows" not in doc and "rules" not in doc
    market.serve(doc)
    market.add_source()
    [_, test] = catalog.refresh()
    assert test["ok"] and test["plugins"] == 1 and test["workflows"] == 0 and test["problems"] == []
    assert workflows.search()["workflows"] == []
    assert [h["name"] for h in catalog.search()["plugins"]] == ["hello"]


def test_workflows_and_rules_are_read_next_to_plugins(market, loaded):
    market.publish("hello", "1.0.0")
    market.publish_workflow("release-notes", "1.0.0")
    market.publish_workflow("release-notes", "1.2.0")
    market.publish_rules("strict", "1.0.0")     # rule packs, the third kind (23-rules-in-marketplace.md §2)
    doc = market.index()
    doc["plugins"][0]["kind"] = "plugin"
    market.serve(doc)
    market.add_source()
    [_, test] = catalog.refresh()
    assert test["ok"] and test["plugins"] == 1 and test["workflows"] == 1 and test["problems"] == []
    index = catalog.indexes()[0]
    entry = index.workflows["release-notes"]
    assert [v.version for v in entry.versions] == ["1.2.0", "1.0.0"] and entry.kind == "workflow"
    assert "release-notes" not in index.plugins and "hello" not in index.workflows
    assert list(index.rules) == ["strict"] and index.rules["strict"].kind == "rules"


def test_broken_workflow_entries_are_left_out_and_the_rest_is_used(market):
    market.publish_workflow("good", "1.0.0")
    market.publish_workflow("big", "1.0.0", size=300 << 10)                       # more than 256 KB
    market.publish_workflow("nosig", "1.0.0", sha256="xyz")
    market.publish_workflow("stranger", "1.0.0", publisher="nobody")
    market.publish_workflow("noreview", "1.0.0")
    market.workflows["noreview"]["versions"][0].pop("review")
    market.publish_workflow("badagent", "1.0.0", agents=["Not An Agent"])
    market.publish_workflow("plainhttp", "1.0.0")
    market.workflows["plainhttp"]["versions"][0]["url"] = "http://example.com/x.yaml"
    market.publish_workflow("badversion", "1.0.0")
    market.publish_workflow("badversion", "1.1.0")
    market.workflows["badversion"]["versions"][1]["version"] = "1.1"
    doc = market.index()
    doc["workflows"].append({**doc["workflows"][0], "name": "kinded", "kind": "plugin"})
    doc["plugins"] = [{"name": "wrongkind", "kind": "workflow"}, {"name": "workflows", "publisher": "keel"}]
    market.serve(doc)
    market.add_source()
    [_, test] = catalog.refresh()
    index = catalog.indexes()[0]
    assert sorted(index.workflows) == ["badversion", "good"]
    assert [v.version for v in index.workflows["badversion"].versions] == ["1.0.0"]
    text = "\n".join(test["problems"])
    for word in ("big 1.0.0: size", "nosig 1.0.0: sha256", "stranger: its publisher 'nobody'", "noreview 1.0.0: review",
                 "badagent 1.0.0: requires.agents", "plainhttp 1.0.0:", "version '1.1'", "kinded: its kind",
                 "'wrongkind': its kind is 'workflow', in the plugins list",
                 "plugin name 'workflows' is taken by keel"):
        assert word in text, word


def test_revoked_entries_carry_their_kind(market, loaded):
    market.publish("notes", "1.0.0")
    market.publish_workflow("notes", "1.0.0")
    market.publish_workflow("notes", "1.1.0")
    market.revoked.append({"name": "notes", "version": "1.1.0", "kind": "workflow", "why": "it deletes files"})
    market.revoked.append({"name": "notes", "version": "1.0.0", "why": "a plugin bug"})      # no kind: a plugin's
    market.ready()
    index = catalog.indexes()[0]
    assert index.why_revoked("notes", "1.1.0", "workflow") == "it deletes files"
    assert index.why_revoked("notes", "1.1.0") is None
    assert index.why_revoked("notes", "1.0.0") == "a plugin bug" and index.why_revoked("notes", "1.0.0", "workflow") is None
    [hit] = workflows.search("notes")["workflows"]
    assert hit["version"] == "1.0.0" and hit["latest"] == "1.1.0" and hit["fits"]
    one = workflows.detail("notes")
    assert [(v["version"], v["revoked"]) for v in one["versions"]] == [("1.1.0", "it deletes files"), ("1.0.0", None)]
    with pytest.raises(MarketError, match="revoked: it deletes files") as exc:
        workflows.fetch("notes", "1.1.0")
    assert exc.value.status == 409
    assert workflows.fetch("notes")["version"] == "1.0.0"


# ------------------------------------------------------------------ search and one workflow

def test_search_across_kinds_and_the_hit_shape(client, market, loaded):
    market.publish("hello", "1.0.0", title="Hello notes")
    market.publish_workflow("release-notes", "1.2.0", title="Release notes", needs={"git": ">=1.0.0"},
                            agents=["librarian"])
    market.publish_workflow("flaky", "1.0.0", category="quality", title="Flaky tests")
    market.ready()
    loaded["git"] = "1.1.0"
    body = client.get("/marketplace/workflows", params={"q": "notes"}).json()
    assert set(body) == {"workflows", "sources", "categories"}
    assert body["categories"] == list(catalog.WORKFLOW_CATEGORIES)
    [hit] = body["workflows"]
    assert hit == {
        "name": "release-notes", "kind": "workflow", "title": "Release notes", "publisher": "keel",
        "publisher_title": "keel", "verified": True, "version": "1.2.0", "summary": "The release-notes workflow for tests.",
        "category": "docs", "tags": ["release-notes", "test"],
        "review": {"steps": 2, "gates": 1, "agents": ["librarian"], "mcp": [], "commands": [], "edits_files": True,
                   "keel_rules": False},
        "needs": {"plugins": {"git": ">=1.0.0"}, "agents": ["librarian"]}, "fits": True, "refused": None,
        "source": "test", "repo": "https://github.com/keel-studio/keel-workflows", "latest": "1.2.0", "old": False,
        "why_not": None, "missing_plugins": [], "trust": "content"}
    assert [h["name"] for h in client.get("/marketplace/workflows", params={"category": "quality"}).json()["workflows"]] \
        == ["flaky"]
    # one search, every kind: the plugin search keeps its answer, kind=all adds the workflows
    plugins_only = client.get("/marketplace/search", params={"q": "notes"}).json()
    assert set(plugins_only) == {"plugins", "sources", "categories"} and plugins_only["plugins"][0]["name"] == "hello"
    both = client.get("/marketplace/search", params={"q": "notes", "kind": "all"}).json()
    assert [h["name"] for h in both["plugins"]] == ["hello"] and [h["name"] for h in both["workflows"]] == ["release-notes"]
    assert both["workflow_categories"] == list(catalog.WORKFLOW_CATEGORIES)
    assert client.get("/marketplace/search", params={"kind": "workflow"}).json()["workflows"][0]["kind"] == "workflow"


def test_one_workflow_versions_checks_and_what_it_needs(client, market, loaded):
    market.publish_workflow("release-notes", "1.0.0")
    market.publish_workflow("release-notes", "1.1.0", needs={"db": ">=1.0.0"})
    market.publish_workflow("release-notes", "2.0.0", keel=">=99.0.0")
    market.ready()
    one = client.get("/marketplace/workflows/release-notes").json()
    # 2.0.0 is for another keel; 1.1.0 needs db, which keel does not run: 1.0.0 is the newest that fits
    assert one["version"] == "1.0.0" and one["fits"] is True and one["refused"] is None
    assert [v["version"] for v in one["versions"]] == ["2.0.0", "1.1.0", "1.0.0"]
    v2, v11, v1 = one["versions"]
    assert v2["fits"] is False and v2["why_not"].startswith("needs keel >=99.0.0")
    assert v11["fits"] is False and v11["missing_plugins"] == ["db"] and v11["requires"] == {"plugins": {"db": ">=1.0.0"}}
    assert set(v1) >= {"version", "released", "requires", "review", "url", "size", "sha256"}
    assert one["checks"] == workflows.CHECKS
    loaded["db"] = "1.4.0"
    assert client.get("/marketplace/workflows/release-notes").json()["version"] == "1.1.0"
    # only versions that need a plugin keel does not run: the newest is still shown, fits false, and why
    loaded.clear()
    market.workflows["release-notes"]["versions"] = market.workflows["release-notes"]["versions"][1:2]
    market.built = "2026-10-10T06:00:00Z"
    market.ready()
    one = client.get("/marketplace/workflows/release-notes").json()
    assert one["version"] == "1.1.0" and one["fits"] is False and one["missing_plugins"] == ["db"]
    assert one["why_not"] == "needs db >=1.0.0, which this keel does not run" and one["refused"] is None
    r = client.get("/marketplace/workflows/nope")
    assert r.status_code == 404 and r.json()["error"] == "There is no workflow nope in the catalogs keel reads."
    assert client.get("/marketplace/workflows/Bad_Name").status_code == 400


def test_an_old_catalog_is_shown_and_refused(client, market, loaded):
    market.publish_workflow("release-notes", "1.0.0")
    market.expires = "2020-01-01T00:00:00Z"
    market.ready()
    one = client.get("/marketplace/workflows/release-notes").json()
    assert one["old"] is True and one["refused"]["error"].startswith("The catalog test is old")
    r = client.post("/marketplace/workflows/release-notes/fetch", json={})
    assert r.status_code == 409 and r.json()["error"].startswith("The catalog test is old")


# ------------------------------------------------------------------ fetch

def test_fetch_gives_the_verified_yaml(client, market, loaded):
    market.publish_workflow("release-notes", "1.0.0")
    v = market.publish_workflow("release-notes", "1.2.0", needs={"git": ">=1.0.0"}, agents=["librarian"])
    market.ready()
    r = client.post("/marketplace/workflows/release-notes/fetch", json={"version": "1.0.0"})
    assert r.status_code == 200
    got = r.json()
    assert got["version"] == "1.0.0" and "write the notes (1.0.0)" in got["yaml"]
    assert got == {**got, "name": "release-notes", "title": "Release notes", "publisher": "keel", "catalog": "test",
                   "requires": {}, "verified": True, "missing_plugins": []}
    # no body: the newest that fits (1.2.0 needs git, which keel does not run)
    assert client.post("/marketplace/workflows/release-notes/fetch").json()["version"] == "1.0.0"
    loaded["git"] = "1.0.0"
    assert client.post("/marketplace/workflows/release-notes/fetch").json()["version"] == "1.2.0"
    # asked for by version, a version that needs a plugin keel does not run is fetched, and says what it misses
    loaded.clear()
    newest = client.post("/marketplace/workflows/release-notes/fetch", json={"version": "1.2.0"}).json()
    assert newest["version"] == "1.2.0" and newest["missing_plugins"] == ["git"] and newest["sha256"] == v["sha256"]
    assert newest["requires"] == {"plugins": {"git": ">=1.0.0"}, "agents": ["librarian"]}
    assert newest["review"]["agents"] == ["librarian"]
    assert client.post("/marketplace/workflows/release-notes/fetch", json={"version": "9.9.9"}).status_code == 404


def test_fetch_refuses_a_bad_signature_a_wrong_sha256_and_a_bigger_file(market, loaded):
    market.publish_workflow("signed-by-other", "1.0.0", sign_with=keygen())
    market.publish_workflow("changed", "1.0.0")
    market.publish_workflow("bigger", "1.0.0")
    market.publish_workflow("not-yaml", "1.0.0", text="name: [unclosed\n")
    market.publish_workflow("no-steps", "1.0.0", text="name: x\n")
    market.ready()
    market.server.files["/wf/changed-1.0.0.yaml"] += b"# one more line\n"
    market.server.files["/wf/bigger-1.0.0.yaml"] += b"# x" * 100
    for name, status, words in (("signed-by-other", 502, "does not match its publisher's key"),
                                ("changed", 502, "more than the"),
                                ("bigger", 502, "more than the"),
                                ("not-yaml", 502, "is not a workflow YAML file"),
                                ("no-steps", 502, "needs a name and a list of steps")):
        with pytest.raises(MarketError, match=words) as exc:
            workflows.fetch(name)
        assert exc.value.status == status, name
    # the same size, other bytes: the sha256 stops it
    data = market.server.files["/wf/changed-1.0.0.yaml"]
    market.server.files["/wf/changed-1.0.0.yaml"] = data[:-16].replace(b"write", b"WRITE")
    with pytest.raises(MarketError, match="does not match the catalog's sha256"):
        workflows.fetch("changed")


def test_an_unverified_publishers_workflow_is_content_and_installs(market, loaded):
    other = keygen()
    market.publishers["ana-k"] = {"title": "Ana K", "keys": [other.public().line()], "verified": False}
    market.publish_workflow("community", "1.0.0", publisher="ana-k", sign_with=other)
    market.ready()
    [hit] = workflows.search("community")["workflows"]
    assert hit["verified"] is False and hit["trust"] == "content" and hit["refused"] is None
    got = workflows.fetch("community")
    assert got["publisher"] == "ana-k" and got["verified"] is False
    assert json.loads(json.dumps(got))["yaml"].startswith("name: community")
