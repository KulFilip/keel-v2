"""keel-plugin rules lint and the index's rule packs (docs/plugins/23-rules-in-marketplace.md): the checks of a pack
without keel (tolerant of fields this tool does not know), its review as keel's engine builds it, and `index` reading
rules/*.yml, the releases' <name>-<version>.yaml packs and the marketplace repo's own rules/<name>/<version>.yaml."""

from __future__ import annotations

import json
from pathlib import Path

from conftest import write

from keel_plugin import catalog, minisign, rules
from keel_plugin.manifest import file_sha256

# keel's final rule pack format (keel v2 0.17.2, docs/rules/pack-format.md, schema 1): shipped unchanged
GOOD = """schema: 1
kind: rules
name: no-new-deps
title: No new dependencies
version: 1.0.0
publisher: keel
summary: Agents never add a package, inside or outside a flow.
requires:
  keel: ">=0.17.2"
  plugins: [db]
rules:
  - id: no-install
    kind: bash
    how: regex
    match: ['\\bnpm\\s+install\\s+[^-\\s]', '\\bpip\\s+install\\b']
    phases: all
    reason: Adding a package is a person's decision.
  - id: no-lockfile
    kind: edit
    match: ["**/package-lock.json"]
    phases: [green, refactor]
    lanes: [web]
    except: ["web/fixtures/**"]
    reason: The lock file follows package.json.
  - id: no-db-change
    kind: mcp
    how: name
    match: keel_db_change
    phases: in-flow
    reason: Schema changes go through a migration.
"""

WORKFLOW = """name: Notes
steps:
  - { id: write, kind: agent, name: write, agent: librarian }
"""


def test_lint_a_good_pack_and_its_review(tmp_path, run):
    f = write(tmp_path / "no-new-deps-1.0.0.yaml", GOOD)
    report = rules.lint(f)
    assert report.ok, report.errors
    assert report.warnings == []
    assert (report.name, report.version, report.title) == ("no-new-deps", "1.0.0", "No new dependencies")
    assert report.publisher == "keel" and report.requires == {"keel": ">=0.17.2", "plugins": {"db": ""}}
    assert report.review == {
        "rules": 3, "kinds": {"bash": 1, "edit": 1, "mcp": 1}, "phases": ["all", "green", "refactor", "in-flow"],
        "lanes": ["web"],
        "blocks": [{"id": "no-install", "kind": "bash", "match": [r"\bnpm\s+install\s+[^-\s]", r"\bpip\s+install\b"],
                    "how": "regex", "phases": "all"},
                   {"id": "no-lockfile", "kind": "edit", "match": ["**/package-lock.json"], "how": "glob",
                    "phases": ["green", "refactor"], "lanes": ["web"], "except": ["web/fixtures/**"]},
                   {"id": "no-db-change", "kind": "mcp", "match": ["keel_db_change"], "how": "name", "phases": "in-flow"}]}
    code, out, _ = run("rules", "lint", f)
    assert code == 0
    assert "(no-new-deps 1.0.0)" in out and "review   3 rules (bash 1, edit 1, mcp 1)" in out
    assert "phases   all, green, refactor, in-flow" in out and "lanes    web" in out and out.rstrip().endswith("ok")
    assert "blocks   no-lockfile: edit glob **/package-lock.json (green, refactor)" in out
    # a file kept in the marketplace repo: rules/<name>/<version>.yaml
    g = write(tmp_path / "rules/no-new-deps/1.0.0.yaml", GOOD)
    assert rules.name_version(g) == ("no-new-deps", "1.0.0") and rules.lint(g).ok
    assert rules.is_pack(f) and not rules.is_pack(write(tmp_path / "notes-1.0.0.yaml", WORKFLOW))
    # a pack's name is keel's pack name: up to 64, a digit first is fine (a plugin's is not)
    long = "2fa-keep-the-database-migrations-inside-a-flow-and-never-by-hand"
    h = write(tmp_path / f"{long}-1.0.0.yaml", GOOD.replace("name: no-new-deps", f"name: {long}"))
    assert rules.name_version(h) == (long, "1.0.0") and rules.lint(h).ok


def test_the_review_is_the_engines():
    # the same pack and answer as keel's engine test (engine/tests/test_marketplace_rules.py)
    doc = {"id": "p", "name": "P", "owner": "someone",
           "rules": [{"id": "a", "kind": "mcp", "how": "name", "match": "db_change", "reason": "x", "severity": 3},
                     {"id": "b", "kind": "read", "phases": "in-flow", "lanes": "api"},
                     {"id": "c", "kind": "bash", "phases": ["green"]},
                     {"id": "d", "kind": "teleport"},
                     "not a rule"]}
    assert rules.review(doc) == {
        "rules": 4, "kinds": {"bash": 1, "read": 1, "mcp": 1, "teleport": 1}, "phases": ["all", "in-flow", "green"],
        "lanes": ["api"],
        "blocks": [{"id": "a", "kind": "mcp", "match": ["db_change"], "how": "name", "phases": "all"},
                   {"id": "b", "kind": "read", "match": [], "how": "glob", "phases": "in-flow", "lanes": ["api"]},
                   {"id": "c", "kind": "bash", "match": [], "how": "contains", "phases": ["green"]},
                   {"id": "d", "kind": "teleport", "match": [], "how": "contains", "phases": "all"}]}
    assert rules.review({"rules": [{"id": "e", "kind": "edit", "match": "x/**", "phases": "green"}]})["blocks"] \
        == [{"id": "e", "kind": "edit", "match": ["x/**"], "how": "glob", "phases": ["green"]}]
    assert rules.review({"rules": "none"}) == {"rules": 0, "kinds": {}, "phases": [], "lanes": [], "blocks": []}


def test_lint_finds_what_keel_would_refuse_and_warns_on_what_it_does_not_know(tmp_path, run):
    bad = """schema: 2
kind: plugin
name: Other_Name
title: ""
version: 1.0
publisher: Not A Publisher
owner: someone
requires: {keel: "soon", plugins: [Bad_Plugin]}
rules:
  - id: a
    kind: teleport
    how: magic
    match: []
    reason: x
  - id: a
    kind: bash
    how: regex
    match: ['(unclosed']
    phases: sometimes sometimes
    reason: x
  - kind: edit
    how: glob
    match: ["*.lock"]
    phases: [Green Phase]
    lanes: mobile
  - id: d
    kind: bash
    how: glob
    match: rm
    except: ["x"]
    severity: high
    reason: y
  - just text
"""
    f = write(tmp_path / "strict-1.0.0.yaml", bad)
    report = rules.lint(f)
    text = "\n".join(report.errors)
    for words in ("schema must be 1", "kind must be rules", "name must be the pack's id", "title is missing",
                  "version must be a version like 1.0.0", "publisher 'Not A Publisher' must be lower-case",
                  "requires.keel must be a version range", "requires.plugins: 'Bad_Plugin' is not a plugin name",
                  "rule a: kind 'teleport'", "rule a: how 'magic'",
                  "rule a: match must be a pattern or a list", "rule a: two rules share this id",
                  "is not a regular expression", "phases 'sometimes sometimes' is not one of all, in-flow, none",
                  "rules[2] has no id", "rules[2]: phases must be all, in-flow, none, or a list",
                  "rules[2]: lanes must be api and/or web", "rules[2]: reason is missing", "rules[4] is not a mapping"):
        assert words in text, words
    warned = "\n".join(report.warnings)
    for words in ("'owner' is not a rule pack field", "rule d: 'severity' is not a rule field",
                  "rule d: how glob is for edit, read rules, not bash", "rule d: except is for edit and read rules"):
        assert words in warned, words
    code, out, _ = run("rules", "lint", f)
    assert code == 1 and "error(s)" in out
    # the name and the version are the marketplace's
    other = rules.lint(write(tmp_path / "strict-2.0.0.yaml", GOOD))
    assert other.errors == ["name no-new-deps is not the marketplace name strict (the file name, or --name)",
                            "version 1.0.0 is not the marketplace version 2.0.0 (the file name, or --version)"]
    assert rules.lint(write(tmp_path / "pack.yaml", GOOD)).errors[0].startswith("the file name must be")
    assert rules.lint(write(tmp_path / "pack.yaml", GOOD), "no-new-deps", "1.0.0").ok
    assert rules.lint(write(tmp_path / "x-1.0.0.yaml",
                            "schema: 1\nname: x\ntitle: X\nversion: 1.0.0\npublisher: keel\nrules: []\n")).errors == [
        "rules is missing: a pack has a list of at least one rule"]
    # keel defaults the publisher to local; a marketplace pack must name it
    nopub = rules.lint(write(tmp_path / "no-new-deps-1.0.0.yaml", GOOD.replace("publisher: keel\n", "")))
    assert nopub.errors == ["publisher is missing: a marketplace pack names its publisher (the entry's publisher)"]
    big = write(tmp_path / "no-new-deps-1.0.1.yaml", GOOD.replace("version: 1.0.0", "version: 1.0.1")
                + "# " + "x" * (64 << 10) + "\n")
    assert any("bigger than 64 KB" in e for e in rules.lint(big).errors)
    code, _, err = run("rules", "lint", tmp_path / "nope-1.0.0.yaml")
    assert code == 1 and "there is no file" in err
    code, _, err = run("rules", "lint", f, big, "--name", "x")
    assert code == 1 and "--name and --version are for one file" in err


def _market(root: Path, keel_key: minisign.SecretKey) -> Path:
    write(root / "publishers/keel.yml", f"name: keel\ntitle: keel\nverified: true\nkeys: [{keel_key.public().line()}]\n")
    (root / "plugins").mkdir(parents=True)
    write(root / "revoked.yml", 'revoked:\n  - { name: strict, version: "1.0.0", why: "it blocks git commit", kind: rules }\n')
    write(root / "rules/no-new-deps.yml", "\n".join([
        "name: no-new-deps", "title: No new dependencies", "publisher: keel", "repo: https://github.com/keel-studio/keel-rules",
        "category: safety", "summary: Agents never add a package.", "tags: [dependencies]", "keel: '>=0.17.0'"]) + "\n")
    write(root / "rules/strict.yml", "name: strict\ntitle: Strict\npublisher: keel\ncategory: git\nsummary: Strict git.\n")
    write(root / "workflows/notes.yml", "name: notes\ntitle: Notes\npublisher: keel\ncategory: docs\nsummary: Notes.\n"
                                        "repo: https://github.com/keel-studio/keel-workflows\n")
    return root


def _sign(f: Path, key: minisign.SecretKey) -> Path:
    f.with_name(f.name + ".minisig").write_text(minisign.sign(f.read_bytes(), key, f.name))
    return f


def test_index_lists_rule_packs_from_releases_and_from_the_marketplace_repo(tmp_path, run, monkeypatch):
    keel_key, other, catalog_key = (minisign.SecretKey.generate() for _ in range(3))
    root = _market(tmp_path / "market", keel_key)
    rel = tmp_path / "releases"
    good = _sign(write(rel / "no-new-deps/no-new-deps-v1.0.0/no-new-deps-1.0.0.yaml", GOOD), keel_key)
    write(good.with_name(good.name + ".json"), json.dumps({
        "url": "https://github.com/keel-studio/keel-rules/releases/download/no-new-deps-v1.0.0/no-new-deps-1.0.0.yaml",
        "released": "2026-10-16T09:00:00Z"}))
    def v(version: str, text: str = GOOD) -> str:
        return text.replace("version: 1.0.0", f"version: {version}")

    _sign(write(rel / "no-new-deps/v1.1.0/no-new-deps-1.1.0.yaml", v("1.1.0")), other)        # not the publisher's key
    write(rel / "no-new-deps/v1.2.0/no-new-deps-1.2.0.yaml", v("1.2.0"))                       # no signature
    _sign(write(rel / "no-new-deps/v1.3.0/no-new-deps-1.3.0.yaml",
                v("1.3.0").replace("    reason: Adding a package is a person's decision.\n", "")), keel_key)   # no reason
    _sign(write(rel / "no-new-deps/v1.4.0/no-new-deps-1.4.0.yaml",
                v("1.4.0").replace("publisher: keel", "publisher: bob")), keel_key)           # not the entry's publisher
    _sign(write(rel / "stranger/stranger-1.0.0.yaml", GOOD.replace("no-new-deps", "stranger")), keel_key)
    _sign(write(rel / "notes/notes-1.0.0.yaml", WORKFLOW), keel_key)                           # a workflow, next to them
    _sign(write(root / "rules/strict/1.0.0.yaml",
                GOOD.replace("name: no-new-deps", "name: strict").replace('  keel: ">=0.17.2"\n', "")), keel_key)
    monkeypatch.setenv("GK_CATALOG_KEY", catalog_key.text())
    code, out, err = run("index", root, "--releases", rel, "--key-env", "GK_CATALOG_KEY", "--out", tmp_path / "site/v1",
                         "--files-url", "https://keel-studio.github.io/keel-marketplace")
    assert code == 0, err
    index = json.loads((tmp_path / "site/v1/index.json").read_text())
    minisign.verify((tmp_path / "site/v1/index.json").read_bytes(), (tmp_path / "site/v1/index.json.minisig").read_text(),
                    [catalog_key.public()])
    assert index["revoked"] == [{"name": "strict", "version": "1.0.0", "why": "it blocks git commit", "kind": "rules"}]
    assert [w["name"] for w in index["workflows"]] == ["notes"]
    [deps, strict] = index["rules"]
    assert {k: v for k, v in deps.items() if k != "versions"} == {
        "name": "no-new-deps", "kind": "rules", "title": "No new dependencies", "publisher": "keel",
        "summary": "Agents never add a package.", "category": "safety", "tags": ["dependencies"],
        "repo": "https://github.com/keel-studio/keel-rules"}
    [v] = deps["versions"]
    # the pack's own requires: its keel range wins over the entry's, its plugins (a list) read as a map
    assert v == {"version": "1.0.0", "released": "2026-10-16", "requires": {"keel": ">=0.17.2", "plugins": {"db": ""}},
                 "url": "https://github.com/keel-studio/keel-rules/releases/download/no-new-deps-v1.0.0/no-new-deps-1.0.0.yaml",
                 "sha256": file_sha256(good), "size": good.stat().st_size, "review": rules.lint(good).review}
    assert strict["versions"][0]["url"] == "https://keel-studio.github.io/keel-marketplace/rules/strict/1.0.0.yaml"
    assert strict["versions"][0]["requires"] == {"plugins": {"db": ""}} and "repo" not in strict
    for words in ("no-new-deps-1.1.0.yaml left out", "no-new-deps-1.2.0.yaml left out: there is no signature",
                  "no-new-deps-1.3.0.yaml left out: rule no-install: reason is missing",
                  "no-new-deps-1.4.0.yaml left out: its publisher is bob, the entry rules/no-new-deps.yml says keel",
                  "stranger-1.0.0.yaml left out: there is no rules/stranger.yml"):
        assert words in out, words
    assert "1 workflows, 1 workflow versions; 2 rule packs, 2 rule pack versions" in out
    # without --files-url the marketplace repo's own pack has no address: left out, and said
    code, out, _ = run("index", root, "--releases", rel, "--no-sign", "--out", tmp_path / "check")
    assert "rules/strict/1.0.0.yaml left out: keel would not know where to download it" in out
    code, out, _ = run("index", root, "--check")
    assert code == 0 and "; 1 workflows, 2 rule packs" in out


def test_the_rule_pack_entries_are_checked(tmp_path, run):
    key = minisign.SecretKey.generate()
    root = _market(tmp_path / "market", key)
    write(root / "rules/broken.yml", "name: broken\ntitle: B\npublisher: nobody\ncategory: games\nsummary: x\nowner: me\n")
    write(root / "rules/rules.yml", "name: other\ntitle: R\npublisher: keel\ncategory: other\nsummary: x\n")
    write(root / "revoked.yml", 'revoked:\n  - { name: strict, version: "1.0.0", why: "x", kind: pack }\n')
    cat = catalog.read_catalog(root)
    text = "\n".join(cat.errors)
    for words in ("rules/broken.yml: the publisher 'nobody'", "rules/broken.yml: category must be one of safety, code",
                  "rules/rules.yml: name must be the file's name (rules)",
                  "revoked[0] must have a plugin name, a version (x.y.z, in quotes) and why (and kind: plugin, "
                  "workflow, rules, skills or stacks"):
        assert words in text, words
    assert "rules/broken.yml: 'owner' is not a rule pack field" in "\n".join(cat.warnings)
    code, _, _ = run("index", root, "--check")
    assert code == 1
