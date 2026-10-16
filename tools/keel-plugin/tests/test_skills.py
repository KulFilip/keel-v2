"""keel-plugin skills (keel 0.18.6): lint a SKILL.md for the marketplace and its review (the same as keel's engine,
keel_engine.marketplace.kinds.skill_review), add keel's own skills to a marketplace folder, and the index's skills list."""

from __future__ import annotations

import json
from pathlib import Path

from conftest import write

from keel_plugin import catalog, minisign, skill

REPO = Path(__file__).resolve().parents[3]
TEXT = ("---\nname: changelog\ndescription: How to write a changelog entry.\n---\n# Changelog\n\n## When\nAt the end.\n\n"
        "```md\n## not a section\n```\n\n## How\nOne line per change.\n")


def test_lint_and_the_review(tmp_path):
    f = write(tmp_path / "changelog-1.0.0.md", TEXT)
    r = skill.lint(f)
    assert r.ok and (r.name, r.version) == ("changelog", "1.0.0")
    assert r.review == {"tokens": len(TEXT.encode()) // 4, "sections": ["When", "How"], "description": "How to write a changelog entry."}
    assert "ok: no problems found" in r.text()
    bad = skill.lint(write(tmp_path / "other-1.0.0.md", TEXT.replace("description: How to write a changelog entry.\n", "")))
    assert "its name is 'changelog'; the marketplace name is 'other': they must be the same" in bad.errors
    assert any("no description" in e for e in bad.errors)
    assert skill.lint(write(tmp_path / "x-1.0.0.md", "no front matter\n")).errors[0].startswith("it has no front matter")
    assert skill.name_version(tmp_path / "skills/changelog/1.2.0.md") == ("changelog", "1.2.0")


def test_add_keels_own_skills_and_index_them(tmp_path, run):
    key = minisign.SecretKey.generate()
    root = tmp_path / "market"
    write(root / "publishers/keel.yml", f"name: keel\ntitle: keel\nkeys: [{key.public().line()}]\nverified: true\n")
    (root / "plugins").mkdir(parents=True)
    write(root / "revoked.yml", "revoked: []\n")
    code, out, _ = run("skills", "add", str(REPO / "content/skills/debugging"), str(REPO / "content/skills/memory"),
                       "--market", str(root), "--keel", ">=0.18.6")
    assert code == 0 and "2 skills in" in out
    assert (root / "skills/debugging/1.0.0.md").read_text() == (REPO / "content/skills/debugging/SKILL.md").read_text()
    entry = (root / "skills/debugging.yml").read_text()
    assert "category: debugging" in entry and "publisher: keel" in entry and 'keel: ">=0.18.6"' in entry
    for name in ("debugging", "memory"):
        f = root / f"skills/{name}/1.0.0.md"
        f.with_name(f.name + ".minisig").write_text(minisign.sign(f.read_bytes(), key, f.name))
    code, out, _ = run("index", str(root), "--check")
    assert code == 0 and "0 rule packs, 2 skills" in out
    rel = tmp_path / "releases"
    rel.mkdir()
    code, out, _ = run("index", str(root), "--releases", str(rel), "--no-sign", "--out", str(tmp_path / "v1"),
                       "--files-url", "https://keel-studio.github.io/keel-marketplace")
    assert code == 0, out
    index = json.loads((tmp_path / "v1/index.json").read_text())
    by = {s["name"]: s for s in index["skills"]}
    assert sorted(by) == ["debugging", "memory"] and by["memory"]["category"] == "knowledge"
    v = by["debugging"]["versions"][0]
    assert v["url"] == "https://keel-studio.github.io/keel-marketplace/skills/debugging/1.0.0.md"
    assert v["review"] == skill.review((root / "skills/debugging/1.0.0.md").read_text())
    assert v["requires"] == {"keel": ">=0.18.6"} and "2 skills, 2 skill versions" in out


def test_keels_own_skills_are_in_the_marketplace_template():
    """docs/plugins/marketplace-repo/skills holds keel's own skills (keel-plugin skills add), each the same as content/."""
    market = REPO / "docs/plugins/marketplace-repo/skills"
    names = {p.stem for p in market.glob("*.yml")}
    own = {p.name for p in (REPO / "content/skills").iterdir() if (p / "SKILL.md").is_file()}
    assert own <= names
    for n in own:
        assert (market / n / "1.0.0.md").read_text() == (REPO / "content/skills" / n / "SKILL.md").read_text(), n
        assert skill.lint(market / n / "1.0.0.md").ok, n
    assert catalog.SKILLS in catalog.FILE_KINDS
