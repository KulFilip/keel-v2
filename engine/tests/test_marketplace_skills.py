"""Skills in the marketplace (keel 0.18.6): the fourth kind of the one kinds table. A skills entry's checks, the review
keel builds from a SKILL.md, search and the kind filter, one skill, and fetch with each of its refusals."""

import hashlib

from keel_engine.marketplace import catalog, kinds, signing, skills
from marketplace_kit import SKILL, market, server  # noqa: F401 - fixtures
from test_pluginhost import data, image  # noqa: F401 - fixtures


def test_the_skills_row_and_the_review():
    assert (kinds.SKILLS.list, kinds.SKILLS.suffix, kinds.SKILLS.max_size) == ("skills", ".md", 256 << 10)
    assert catalog.KINDS == ("plugin", "workflow", "rules", "skills", "stacks") and catalog.MAX_SKILL == 256 << 10
    assert "skills" in catalog.RESERVED
    text = SKILL.format(name="changelog", version="1.0.0")
    assert kinds.skill_review(text) == {"tokens": len(text.encode()) // 4, "sections": ["When", "How"],
                                        "description": "How to write a good changelog entry (1.0.0)."}
    assert kinds.split_front("no front matter") == ({}, "no front matter")
    assert kinds.skill_review("---\nname: x\n---\nbody")["description"] == ""


def test_broken_skill_entries_are_left_out(market):
    market.publish_skill("good", "1.0.0")
    market.publish_skill("big", "1.0.0", size=(256 << 10) + 1)
    market.publish_skill("noreview", "1.0.0")
    market.skills["noreview"]["versions"][0].pop("review")
    market.publish_skill("badtokens", "1.0.0", review={"tokens": -1, "sections": [], "description": ""})
    market.publish_skill("badsections", "1.0.0", review={"tokens": 3, "sections": "When", "description": ""})
    doc = market.index()
    doc["skills"].append({**doc["skills"][0], "name": "Bad_Name"})
    doc["skills"].append({**doc["skills"][0], "name": "kinded", "kind": "rules"})
    market.serve(doc)
    market.add_source()
    [_, test] = catalog.refresh()
    assert sorted(catalog.indexes()[0].skills) == ["good"]
    text = "\n".join(test["problems"])
    for word in ("skill big 1.0.0: size must be a number of bytes up to 262,144", "skill noreview 1.0.0: review is missing",
                 "skill badtokens 1.0.0: review.tokens is not a whole number",
                 "skill badsections 1.0.0: review.sections is not a list of text",
                 "skill name 'Bad_Name' does not follow keel's name rule", "skill kinded: its kind is 'rules', in the skills list"):
        assert word in text, word


def test_search_one_skill_and_the_kind_filter(client, market):
    market.publish("hello", "1.0.0")
    market.publish_skill("changelog", "1.0.0", title="Changelog writing")
    market.publish_skill("changelog", "1.1.0", title="Changelog writing")
    market.publish_skill("flaky-tests", "1.0.0", category="testing")
    market.revoked.append({"name": "changelog", "version": "1.1.0", "kind": "skills", "why": "it says the wrong thing"})
    market.ready()
    body = client.get("/marketplace/skills").json()
    assert [h["name"] for h in body["skills"]] == ["changelog", "flaky-tests"]
    first = body["skills"][0]
    assert (first["version"], first["latest"], first["trust"], first["kind"]) == ("1.0.0", "1.1.0", "content", "skills")
    assert first["review"]["sections"] == ["When", "How"] and body["categories"] == list(catalog.SKILLS_CATEGORIES)
    assert [h["name"] for h in client.get("/marketplace/skills", params={"category": "testing"}).json()["skills"]] \
        == ["flaky-tests"]
    assert client.get("/marketplace/search", params={"kind": "skills"}).json()["skills"] == body["skills"]
    every = client.get("/marketplace/search", params={"kind": "all"}).json()
    assert [h["name"] for h in every["skills"]] == ["changelog", "flaky-tests"] and [h["name"] for h in every["plugins"]] == ["hello"]
    assert every["skills_categories"] == list(catalog.SKILLS_CATEGORIES)
    assert set(client.get("/marketplace/search").json()) == {"plugins", "sources", "categories"}
    one = client.get("/marketplace/skills/changelog").json()
    assert [(v["version"], v["revoked"], v["fits"]) for v in one["versions"]] == [
        ("1.1.0", "it says the wrong thing", False), ("1.0.0", None, True)]
    assert one["checks"] == skills.CHECKS
    assert client.get("/marketplace/skills/nothing").status_code == 404
    assert client.get("/marketplace/skills/Bad_Name").status_code == 400


def test_fetch_gives_the_verified_text(client, market):
    market.publish_skill("changelog", "1.0.0")
    market.ready()
    got = client.post("/marketplace/skills/changelog/fetch", json={}).json()
    assert got["text"] == SKILL.format(name="changelog", version="1.0.0")
    assert (got["name"], got["version"], got["publisher"], got["catalog"], got["category"]) == (
        "changelog", "1.0.0", "keel", "test", "authoring")
    assert got["review"] == kinds.skill_review(got["text"])
    assert client.post("/marketplace/skills/changelog/fetch", json={"version": "9.9.9"}).status_code == 404


def test_fetch_refusals(client, market):
    stranger = signing.keygen()
    market.publish_skill("unsigned", "1.0.0", sign_with=stranger)
    market.publish_skill("changed", "1.0.0", sha256=hashlib.sha256(b"other").hexdigest())
    market.publish_skill("renamed", "1.0.0", text=SKILL.format(name="other", version="1.0.0"))
    market.publish_skill("versioned", "1.0.0", text="---\nname: versioned\nversion: 2.0.0\n---\ntext\n")
    market.publish_skill("bare", "1.0.0", text="no front matter at all\n")
    market.publish_skill("lies", "1.0.0", review={"tokens": 1, "sections": [], "description": ""})
    market.publish_skill("future", "1.0.0", keel=">=99.0.0")
    market.ready()

    def refused(name):
        r = client.post(f"/marketplace/skills/{name}/fetch", json={})
        return r.status_code, r.json()["error"]

    assert refused("unsigned")[0] == 502 and "signature" in refused("unsigned")[1]
    assert refused("changed")[0] == 502 and "sha256" in refused("changed")[1]
    assert refused("renamed") == (502, "renamed 1.0.0 is not the skill the catalog lists: its name is other, the catalog says renamed.")
    assert "its version is 2.0.0" in refused("versioned")[1]
    assert refused("bare")[0] == 502 and "front matter" in refused("bare")[1]
    lies = client.post("/marketplace/skills/lies/fetch", json={})
    assert lies.status_code == 409 and lies.json()["differences"][0].startswith("tokens: keel finds")
    assert refused("future")[0] == 409 and "needs keel >=99.0.0" in refused("future")[1]


def test_the_tools_review_is_the_engines_on_keels_own_skills():
    """keel-plugin (tools/keel-plugin, keel_plugin.skill.review) builds the review the catalog lists; keel's engine
    computes it again at fetch: the two must agree, here on every skill keel ships."""
    import sys
    from pathlib import Path
    repo = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(repo / "tools/keel-plugin"))
    try:
        from keel_plugin import skill as tool
    finally:
        sys.path.pop(0)
    files = sorted(repo.glob("content/skills/*/SKILL.md")) + sorted(repo.glob("content/packs/*/skills/*/SKILL.md"))
    assert len(files) > 10
    for f in files:
        text = f.read_text(encoding="utf-8")
        assert tool.review(text) == kinds.skill_review(text), f
