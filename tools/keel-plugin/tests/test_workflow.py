"""keel-plugin workflow lint and the index's workflows (docs/plugins/21-workflow-marketplace.md §5): the checks without
keel, the Install review as keel computes it, and `index` reading workflows/*.yml, the releases' <name>-<version>.yaml
and the marketplace repo's own workflows/<name>/<version>.yaml, each with its .minisig."""

from __future__ import annotations

import json
from pathlib import Path

from conftest import REPO, write

from keel_plugin import catalog, minisign, workflow
from keel_plugin.manifest import file_sha256

GOOD = """name: Release notes
keel_rules: false
mcp: [github]
needs_plugins: [git]
steps:
  - { id: collect, kind: code, name: merged PRs, action: "run:git log --merges --oneline" }
  - { id: write, kind: agent, name: write the notes, agent: librarian, model: default, tools: ["mcp:github:list_pull_requests"] }
  - { id: lanes, kind: parallel, name: both, lanes: [{ name: a, sub: release-writer, kind: agent }, { name: b, sub: commit, kind: code }] }
  - { id: review, kind: gate, name: review the notes, back: write }
  - { id: pick, kind: branch, name: again?, when: { marker: OK, equals: "no" }, no: write }
"""


def test_lint_a_good_workflow_and_its_review(tmp_path, run):
    f = write(tmp_path / "release-notes-1.2.0.yaml", GOOD)
    report = workflow.lint(f)
    assert report.ok, report.errors
    assert (report.name, report.version, report.title) == ("release-notes", "1.2.0", "Release notes")
    assert report.review == {"steps": 5, "gates": 1, "agents": ["librarian", "release-writer"], "mcp": ["github"],
                             "commands": ["git log --merges --oneline"], "edits_files": True, "keel_rules": False}
    assert report.needs_plugins == ["git"]
    assert any("1 shell command" in w for w in report.warnings)
    assert any("release-writer" in w for w in report.warnings)
    code, out, _ = run("workflow", "lint", f)
    assert code == 0
    assert "release-notes 1.2.0" in out and "run:     git log --merges --oneline" in out and "agents   librarian, release-writer" in out
    # a file kept in the marketplace repo: workflows/<name>/<version>.yaml
    g = write(tmp_path / "workflows/release-notes/1.2.0.yaml", GOOD)
    assert workflow.name_version(g) == ("release-notes", "1.2.0")


def test_the_review_is_keels_a_reader_only_workflow_changes_no_files():
    doc = {"name": "x", "steps": [{"id": "a", "kind": "agent", "name": "a", "agent": "explorer"},
                                  {"id": "g", "kind": "gate", "name": "g"}]}
    assert workflow.review(doc) == {"steps": 2, "gates": 1, "agents": ["explorer"], "mcp": [], "commands": [],
                                    "edits_files": False, "keel_rules": True}
    doc["steps"].append({"id": "c", "kind": "code", "name": "c", "action": "commit"})
    assert workflow.review(doc)["edits_files"] is True


def test_lint_finds_what_keel_would_refuse(tmp_path, run):
    bad = """name: ""
version: 1.0.0
keel_rules: maybe
needs_plugins: [Not A Plugin]
steps:
  - { id: a, kind: agent, name: a }
  - { id: a, kind: magic, name: b }
  - { kind: code, action: "run:" , name: c}
  - { id: d, kind: gate, name: d, back: nowhere }
"""
    f = write(tmp_path / "broken-1.0.0.yaml", bad)
    report = workflow.lint(f)
    text = "\n".join(report.errors)
    for words in ("name is missing", "version: '1.0.0' is not a whole number", "keel_rules must be true or false",
                  "needs_plugins must be a list of plugin names", "step a: an agent step names its agent",
                  "step a: two steps share this id", "kind 'magic'", "steps[2] has no id", "run: needs a command",
                  "back: nowhere is not a step"):
        assert words in text, words
    code, out, _ = run("workflow", "lint", f)
    assert code == 1 and "error(s)" in out
    assert workflow.lint(write(tmp_path / "noname.yaml", GOOD)).errors[0].startswith("the file name must be")
    assert workflow.lint(write(tmp_path / "noname.yaml", GOOD), "notes", "2.0.0").ok
    assert not workflow.lint(write(tmp_path / "x-1.0.0.yaml", "name: x\nsteps: []\n")).ok
    big = write(tmp_path / "big-1.0.0.yaml", GOOD + "# " + "x" * (256 << 10) + "\n")
    assert any("bigger than 256 KB" in e for e in workflow.lint(big).errors)
    code, _, err = run("workflow", "lint", tmp_path / "nope-1.0.0.yaml")
    assert code == 1 and "there is no file" in err


def _market(root: Path, keel_key: minisign.SecretKey) -> Path:
    write(root / "publishers/keel.yml", f"name: keel\ntitle: keel\nverified: true\nkeys: [{keel_key.public().line()}]\n")
    (root / "plugins").mkdir(parents=True)
    write(root / "revoked.yml", 'revoked:\n  - { name: notes, version: "1.0.0", why: "it deletes files", kind: workflow }\n')
    write(root / "workflows/release-notes.yml", "\n".join([
        "name: release-notes", "title: Release notes", "publisher: keel", "repo: https://github.com/keel-studio/keel-workflows",
        "category: docs", "summary: Notes from the merged pull requests.", "tags: [release]", "keel: '>=0.16.1'"]) + "\n")
    write(root / "workflows/notes.yml", "name: notes\ntitle: Notes\npublisher: keel\ncategory: other\nsummary: Notes.\n")
    return root


def _sign(f: Path, key: minisign.SecretKey) -> Path:
    f.with_name(f.name + ".minisig").write_text(minisign.sign(f.read_bytes(), key, f.name))
    return f


def test_index_lists_workflows_from_releases_and_from_the_marketplace_repo(tmp_path, run, monkeypatch):
    keel_key, other, catalog_key = (minisign.SecretKey.generate() for _ in range(3))
    root = _market(tmp_path / "market", keel_key)
    rel = tmp_path / "releases"
    good = _sign(write(rel / "release-notes/release-notes-v1.2.0/release-notes-1.2.0.yaml", GOOD), keel_key)
    write(good.with_name(good.name + ".json"), json.dumps({
        "url": "https://github.com/keel-studio/keel-workflows/releases/download/release-notes-v1.2.0/release-notes-1.2.0.yaml",
        "released": "2026-10-15T10:00:00Z"}))
    _sign(write(rel / "release-notes/v1.3.0/release-notes-1.3.0.yaml", GOOD), other)           # not the publisher's key
    write(rel / "release-notes/v1.4.0/release-notes-1.4.0.yaml", GOOD)                          # no signature
    _sign(write(rel / "release-notes/v1.5.0/release-notes-1.5.0.yaml", "name: x\nversion: 1.5.0\nsteps: []\n"), keel_key)
    _sign(write(rel / "stranger/stranger-1.0.0.yaml", GOOD), keel_key)                         # no workflows/stranger.yml
    _sign(write(root / "workflows/notes/1.0.0.yaml", GOOD.replace("Release notes", "Notes")), keel_key)
    monkeypatch.setenv("PB_CATALOG_KEY", catalog_key.text())
    code, out, err = run("index", root, "--releases", rel, "--key-env", "PB_CATALOG_KEY", "--out", tmp_path / "site/v1",
                         "--files-url", "https://keel-studio.github.io/keel-marketplace")
    assert code == 0, err
    index = json.loads((tmp_path / "site/v1/index.json").read_text())
    minisign.verify((tmp_path / "site/v1/index.json").read_bytes(), (tmp_path / "site/v1/index.json.minisig").read_text(),
                    [catalog_key.public()])
    assert index["rules"] == [] and index["plugins"] == []
    assert index["revoked"] == [{"name": "notes", "version": "1.0.0", "why": "it deletes files", "kind": "workflow"}]
    [notes, rn] = index["workflows"]
    assert rn == {**rn, "name": "release-notes", "kind": "workflow", "title": "Release notes", "publisher": "keel",
                  "category": "docs", "tags": ["release"], "repo": "https://github.com/keel-studio/keel-workflows"}
    assert "keel" not in rn
    [v] = rn["versions"]
    assert v == {"version": "1.2.0", "released": "2026-10-15",
                 "requires": {"keel": ">=0.16.1", "plugins": {"git": ""}, "agents": ["release-writer"]},
                 "url": "https://github.com/keel-studio/keel-workflows/releases/download/release-notes-v1.2.0/release-notes-1.2.0.yaml",
                 "sha256": file_sha256(good), "size": good.stat().st_size, "review": workflow.lint(good).review}
    assert notes["versions"][0]["url"] == "https://keel-studio.github.io/keel-marketplace/workflows/notes/1.0.0.yaml"
    assert "repo" not in notes
    for words in ("release-notes-1.3.0.yaml left out", "release-notes-1.4.0.yaml left out: there is no signature",
                  "release-notes-1.5.0.yaml left out", "stranger-1.0.0.yaml left out: there is no workflows/stranger.yml"):
        assert words in out, words
    assert "2 workflows, 2 workflow versions" in out
    # without --files-url the marketplace repo's own file has no address: left out, and said
    code, out, _ = run("index", root, "--releases", rel, "--no-sign", "--out", tmp_path / "check")
    assert "workflows/notes/1.0.0.yaml left out: keel would not know where to download it" in out
    code, out, _ = run("index", root, "--check")
    assert code == 0 and "; 2 workflows" in out


def test_the_marketplace_files_are_checked(tmp_path, run):
    key = minisign.SecretKey.generate()
    root = _market(tmp_path / "market", key)
    write(root / "workflows/broken.yml", "name: broken\ntitle: B\npublisher: nobody\ncategory: games\nsummary: x\nrepo: http://x\n")
    write(root / "plugins/workflows.yml", "\n".join([
        "name: workflows", "title: W", "publisher: keel", "repo: https://github.com/a/b", "category: other",
        "summary: x", "trust: content"]) + "\n")
    cat = catalog.read_catalog(root)
    text = "\n".join(cat.errors)
    for words in ("workflows/broken.yml: the publisher 'nobody'", "category must be one of code, review, docs",
                  "repo must be a https://github.com", "plugins/workflows.yml: 'workflows' is taken by keel"):
        assert words in text, words
    code, _, _ = run("index", root, "--check")
    assert code == 1


def test_the_marketplace_repo_example_workflow_is_valid():
    cat = catalog.read_catalog(REPO / "docs/plugins/marketplace-repo")
    # (keel's key is written by setup-signing-keys.sh: until then publishers/keel.yml has none)
    assert [e for e in cat.errors if not e.startswith("publishers/keel.yml: keys")] == []
    assert cat.workflows["release-notes"]["keel"] == ">=0.16.1" and cat.warnings == []
