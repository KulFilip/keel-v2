"""keel 0.18.28 a stack brings its language support: `languages:` (highlight.js names and file endings), derived from
detect.extensions when a pack has none, checked by keel, and served per project (GET /stacks/languages)."""
from pathlib import Path

import yaml

from keel_engine.runtime import stack_edit, stacks

REPO = Path(__file__).resolve().parents[2]
MARKET = REPO / "docs/plugins/marketplace-repo/stacks"


def builtin_files() -> list[Path]:
    return sorted((REPO / "content/stacks").glob("*.yml")) + sorted((REPO / "content/packs").glob("*/stack.yml"))


def test_every_shipped_pack_names_its_languages_and_keel_can_load_them():
    known = set(stacks.highlight_table()["names"])
    for f in builtin_files():
        doc = yaml.safe_load(f.read_text())
        assert doc.get("languages"), f
        assert stacks.validate_languages(doc["languages"]) == ([], []), f
        assert {x["name"] for x in doc["languages"]} <= known, f
    sym = yaml.safe_load((REPO / "content/packs/symfony/stack.yml").read_text())
    assert sym["languages"] == [{"name": "php", "ext": ["php", "phtml"]}, {"name": "twig", "ext": ["twig"]},
                                {"name": "yaml", "ext": ["neon"]}, {"name": "xml", "ext": ["xlf"]}]


def test_the_marketplace_copies_are_the_same_files():
    for f in builtin_files():
        name = yaml.safe_load(f.read_text())["name"]
        copy = MARKET / name / "1.0.0.yaml"
        assert copy.is_file(), name
        assert copy.read_text() == f.read_text(), f"{copy} differs from {f}"


def test_the_languages_list_validates():
    assert stacks.validate_languages(None) == ([], [])
    errs, _ = stacks.validate_languages({"name": "php"})
    assert errs and "not a list" in errs[0]
    errs, _ = stacks.validate_languages([{"name": "PHP!", "ext": ["php"]}, {"name": "php", "ext": "php"}, {"name": "php", "ext": ["php"], "x": 1}])
    assert len(errs) == 3
    errs, warns = stacks.validate_languages([{"name": "cobol", "ext": ["cbl"]}])
    assert not errs and "no highlight for cobol" in warns[0]
    # keel's stack check carries them
    bad = "name: zig\nlane: api\ndetect: {files: [build.zig]}\nlayers: [{id: unit, what: x}]\nlanguages: [{name: zig, ext: zig}]\n"
    assert any("ext is a list of file endings" in e for e in stack_edit.check(None, bad)["errors"])


def test_without_a_list_the_languages_come_from_detect_extensions():
    assert stacks.languages_of({"detect": {"extensions": [".php", ".twig", ".nope"]}}) == [
        {"name": "php", "ext": ["php"]}, {"name": "twig", "ext": ["twig"]}]
    assert stacks.languages_of({"languages": [{"name": "go", "ext": [".GO"]}]}) == [{"name": "go", "ext": ["go"]}]


def test_a_symfony_project_gets_php(tmp_path, client):
    root = tmp_path / "shop"
    (root / "src").mkdir(parents=True)
    (root / "composer.json").write_text('{"require": {"symfony/framework-bundle": "^7"}}')
    (root / "symfony.lock").write_text("{}")
    (root / "src/Kernel.php").write_text("<?php\n")
    stacks.forget()
    langs = client.get("/stacks/languages", params={"root": str(root)}).json()["languages"]
    php = next(x for x in langs if x["name"] == "php")
    assert php["ext"] == ["php", "phtml"] and php["stacks"] == ["symfony"]
    assert {"twig", "yaml", "xml"} <= {x["name"] for x in langs}
