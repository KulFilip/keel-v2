"""A config section with no value (`backend:` / `loops:` alone) is an empty section, not None: the hook must not refuse every edit."""
from keel_engine import rules


def test_null_sections_keep_the_defaults(tmp_path):
    (tmp_path / ".keel").mkdir()
    (tmp_path / ".keel" / "config.yml").write_text("backend:\nloops:\nweb:\ne2e:\nguards:\n")
    cfg = rules.load_config(tmp_path)
    for key in ("backend", "loops", "e2e", "guards"):
        assert isinstance(cfg[key], dict), key
    for path in ("src/app/Main.kt", "web/src/App.tsx", "tests/e2e/a.spec.ts"):
        assert isinstance(rules.classify(cfg, path), str)       # no AttributeError on a None section
    assert cfg["loops"].get("stall_repeats", 3) >= 1
