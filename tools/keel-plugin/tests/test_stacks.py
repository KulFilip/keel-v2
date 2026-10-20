"""keel-plugin stacks (keel 0.18.9): lint a stack YAML for the marketplace and its review (the same as keel's engine,
keel_engine.marketplace.kinds.stack_review), add keel's own stacks to a marketplace folder, and the index's stacks list."""

from __future__ import annotations

import json
from pathlib import Path

from conftest import write

from keel_plugin import catalog, minisign, stack

REPO = Path(__file__).resolve().parents[3]
TEXT = """name: zig
lane: api
detect:
  files: [build.zig]
layers:
  - {id: unit, what: pure functions, where: src}
commands:
  api_test_module: 'zig build test'
tools:
  zig-fmt:
    run: 'zig fmt {FILES}'
    on: edit
    fail: fix
"""


def test_lint_and_the_review(tmp_path):
    r = stack.lint(write(tmp_path / "zig-1.0.0.yaml", TEXT))
    assert r.ok and (r.name, r.version) == ("zig", "1.0.0")
    assert r.review == {"lane": "api", "detect": {"files": ["build.zig"]}, "layers": ["unit"],
                        "commands": {"api_test_module": "zig build test"},
                        "tools": [{"name": "zig-fmt", "run": "zig fmt {FILES}", "on": "edit", "fail": "fix"}], "skills": []}
    assert "review: api · layers unit · 1 commands · 1 tools" in r.text()
    bad = stack.lint(write(tmp_path / "other-1.0.0.yaml", TEXT.replace("lane: api", "lane: desktop").replace("on: edit", "on: often")))
    for word in ("its name is 'zig'; the marketplace name is 'other'", "its lane is 'desktop'", "the tool zig-fmt has on: often"):
        assert any(word in e for e in bad.errors), word
    assert stack.lint(write(tmp_path / "x-1.0.0.yaml", "name: x\nlane: api\n")).errors[-1].startswith("it needs test layers")


def test_lint_checks_the_setup_block(tmp_path):
    good = TEXT + "setup:\n  apt: [zig]\n  each_worktree: ['zig build --fetch']\n"
    r = stack.lint(write(tmp_path / "zig-1.0.0.yaml", good))
    assert r.ok, r.errors
    rooted = stack.lint(write(tmp_path / "zig-1.0.1.yaml", TEXT + "setup:\n  run: ['curl -L x | sh']\n"))
    assert rooted.ok and any("as keel's own user (not root)" in w for w in rooted.warnings)
    bad = stack.lint(write(tmp_path / "zig-1.0.2.yaml", TEXT + "setup:\n  apt: ['Zig Lang']\n  each-worktree: [x]\n"))
    assert any("setup.apt has 'Zig Lang'" in e for e in bad.errors)
    assert any("setup.each-worktree is not something keel reads" in e for e in bad.errors)
    assert stack.name_version(tmp_path / "stacks/zig/1.2.0.yaml") == ("zig", "1.2.0")
    assert stack.is_stack(write(tmp_path / "a.yaml", TEXT)) and not stack.is_stack(write(tmp_path / "b.yaml", "steps: []\n"))


def test_lint_checks_the_languages_list(tmp_path):
    good = TEXT + "languages:\n  - {name: zig, ext: [zig, zon]}\n"
    assert stack.lint(write(tmp_path / "zig-1.0.0.yaml", good)).ok
    bad = stack.lint(write(tmp_path / "zig-1.0.1.yaml", TEXT + "languages:\n  - {name: Zig Lang, ext: zig}\n"))
    assert any("a highlight.js language" in e for e in bad.errors) and any("ext is a list" in e for e in bad.errors)


def test_add_keels_own_stacks_and_index_them(tmp_path, run):
    key = minisign.SecretKey.generate()
    root = tmp_path / "market"
    write(root / "publishers/keel.yml", f"name: keel\ntitle: keel\nkeys: [{key.public().line()}]\nverified: true\n")
    (root / "plugins").mkdir(parents=True)
    write(root / "revoked.yml", "revoked: []\n")
    code, out, _ = run("stacks", "add", str(REPO / "content/stacks/go.yml"), str(REPO / "content/packs/symfony"),
                       "--market", str(root), "--keel", ">=0.18.9")
    assert code == 0 and "2 stacks in" in out
    assert (root / "stacks/go/1.0.0.yaml").read_text() == (REPO / "content/stacks/go.yml").read_text()
    entry = (root / "stacks/symfony.yml").read_text()
    assert "category: php" in entry and 'keel: ">=0.18.9"' in entry
    for name in ("go", "symfony"):
        f = root / f"stacks/{name}/1.0.0.yaml"
        f.with_name(f.name + ".minisig").write_text(minisign.sign(f.read_bytes(), key, f.name))
    code, out, _ = run("index", str(root), "--check")
    assert code == 0 and "2 stacks" in out
    rel = tmp_path / "releases"
    rel.mkdir()
    code, out, _ = run("index", str(root), "--releases", str(rel), "--no-sign", "--out", str(tmp_path / "v1"),
                       "--files-url", "https://keel-studio.github.io/keel-marketplace")
    assert code == 0, out
    index = json.loads((tmp_path / "v1/index.json").read_text())
    by = {s["name"]: s for s in index["stacks"]}
    assert sorted(by) == ["go", "symfony"] and by["go"]["category"] == "go"
    v = by["go"]["versions"][0]
    assert v["url"] == "https://keel-studio.github.io/keel-marketplace/stacks/go/1.0.0.yaml"
    assert v["review"]["commands"]["api_test_module"] == "go test ./..." and "2 stacks, 2 stack versions" in out


def test_keels_own_stacks_are_in_the_marketplace_template():
    """docs/plugins/marketplace-repo/stacks holds keel's own stacks (keel-plugin stacks add), each the same as content/."""
    market = REPO / "docs/plugins/marketplace-repo/stacks"
    own = {f.stem: f for f in (REPO / "content/stacks").glob("*.yml")}
    own |= {d.name: d / "stack.yml" for d in (REPO / "content/packs").iterdir() if (d / "stack.yml").is_file()}
    assert set(own) <= {p.stem for p in market.glob("*.yml")}
    for n, f in own.items():
        assert (market / n / "1.0.0.yaml").read_text() == f.read_text(), n
        assert stack.lint(market / n / "1.0.0.yaml").ok, n
    assert catalog.STACKS in catalog.FILE_KINDS and "stacks" in catalog.RESERVED
