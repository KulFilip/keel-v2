"""v0.15.8 keel v1's layouts (`layout:` in .keel/config.yml): where keel's files are, and what reads and writes them."""

import os
import subprocess
from pathlib import Path

from keel_engine import layout, rules
from keel_engine.runtime import knowledge


def _repo(root: Path, files: dict[str, str] | None = None) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=root, check=True)
    for rel, text in (files or {}).items():
        f = root / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text)
    return root


def test_repo_layout_paths(tmp_path):
    r = _repo(tmp_path / "p", {"docs/specs/a.md": "# A\n", "docs/RUNNING.md": "# run\n"})
    lay = layout.resolve(r)
    assert lay.name == "repo" and not lay.hidden
    assert (lay.specs, lay.knowledge, lay.adr, lay.runbook) == ("docs/specs", "docs/knowledge", "docs/adr", "docs/RUNNING.md")
    assert lay.runbooks == ("docs/RUNNING.md",)


def test_repo_layout_specs_folder(tmp_path):
    only_specs = _repo(tmp_path / "a", {"specs/x.md": "# X\n"})
    assert layout.resolve(only_specs).specs == "specs"
    configured = _repo(tmp_path / "b", {".keel/config.yml": "layout: repo\nspecs:\n  dir: design/specs\n"})
    assert layout.resolve(configured).specs == "design/specs"


def test_keel_layout(tmp_path):
    r = _repo(tmp_path / "p", {".keel/config.yml": "layout: keel\n", ".keel/specs/x.md": "# X\n- **AC-1** [API] x\n"})
    lay = layout.resolve(r)
    assert lay.name == "keel" and lay.hidden
    assert (lay.specs, lay.knowledge, lay.adr, lay.runbook) == (".keel/specs", ".keel/knowledge", ".keel/adr", ".keel/RUNNING.md")
    cfg = rules.load_config(r)
    assert cfg["layout"] == "keel" and cfg["specs"]["dir"] == ".keel/specs"
    assert rules.classify(cfg, ".keel/specs/x.md") == "specs"


def test_mixed_project_reads_both_spec_folders(tmp_path):
    r = _repo(tmp_path / "p", {".keel/config.yml": "layout: keel\n", ".keel/specs/new.md": "# N\n", "docs/specs/old.md": "# O\n"})
    lay = layout.resolve(r)
    assert lay.spec_dirs == (".keel/specs", "docs/specs")
    cfg = rules.load_config(r)
    assert rules.classify(cfg, "docs/specs/old.md") == "specs"      # the guard protects both
    assert rules.classify(cfg, ".keel/specs/new.md") == "specs"


def test_external_layout_follows_the_link(tmp_path):
    target = tmp_path / "home" / "projects" / "p1"
    (target / "specs").mkdir(parents=True)
    (target / "config.yml").write_text("layout: external\n")
    (target / "specs" / "e.md").write_text("# E\n")
    r = _repo(tmp_path / "p")
    os.symlink(target, r / ".keel")
    lay = layout.resolve(r)
    assert lay.name == "external" and lay.link == str(target) and lay.missing is None
    assert (r / lay.specs / "e.md").is_file()


def test_external_layout_whose_folder_is_not_visible(tmp_path):
    r = _repo(tmp_path / "p")
    os.symlink(tmp_path / "gone", r / ".keel")
    lay = layout.resolve(r)
    assert lay.name == "external"
    assert lay.missing == f"this project keeps keel's files in {tmp_path / 'gone'}; add that folder too: keel2 add {tmp_path / 'gone'}"


def test_no_layout_key(tmp_path):
    fresh = _repo(tmp_path / "new")
    assert layout.resolve(fresh).name == layout.NEW_PROJECT
    legacy = _repo(tmp_path / "old", {"docs/knowledge/data.md": "# Data\n"})
    assert layout.resolve(legacy).name == "repo"          # existing projects never move by themselves
    no_cfg = _repo(tmp_path / "plain", {".keel/config.yml": "version: 4\n", "docs/specs/s.md": "# S\n"})
    assert layout.resolve(no_cfg).name == "repo"


def test_hide_writes_git_exclude_once(tmp_path):
    r = _repo(tmp_path / "p", {".keel/config.yml": "layout: keel\n"})
    assert layout.hide(r)
    assert layout.hide(r)
    text = (r / ".git" / "info" / "exclude").read_text()
    assert text.count("/.keel/\n") == 1 and "/.keel\n" in text
    plain = _repo(tmp_path / "q")
    assert not layout.hide(plain, layout.Layout("repo", "docs/specs", "docs/knowledge", "docs/adr", "docs/RUNNING.md",
                                                 "CLAUDE.md", ("docs/specs",), ("docs/knowledge",), ("docs/adr",), ()))


def test_knowledge_follows_the_layout(tmp_path):
    r = _repo(tmp_path / "p", {".keel/config.yml": "layout: keel\n", ".keel/knowledge/domain.md": "# D\n`x.py:1`\n"})
    assert knowledge.section_file(str(r), "domain") == r / ".keel/knowledge/domain.md"
    assert knowledge.knowledge_dir(str(r)) == ".keel/knowledge"
    assert "domain" in knowledge.built(str(r))


def test_fake_model_writes_the_spec_where_the_layout_says(tmp_path):
    from keel_engine.models.base import AgentRequest
    from keel_engine.models.fake import _canned

    r = _repo(tmp_path / "p", {".keel/config.yml": "layout: keel\n"})
    req = AgentRequest(agent="explorer", system="", prompt="go", root=str(r), phase="spec", model={"provider": "fake"},
                       toolbox=None, title="Player scores")
    path, _text, _answer, data = _canned(req)
    assert path.startswith(".keel/specs/") and data["spec"] == path


def test_hidden_layout_records_instead_of_committing(tmp_path):
    from keel_engine.runtime.actions import ActionInput, commit

    r = _repo(tmp_path / "p", {".keel/config.yml": "layout: keel\n", ".keel/specs/x.md": "# X\n"})
    res = commit(ActionInput(root=str(r), phase="spec", title="x", ac=None, acs=[], fake=True, flow="feature",
                             paths=[".keel/specs/x.md"]))
    assert res.ok and "Recorded, not committed" in res.note


def test_a_worktrees_keel_files_come_back_to_the_project_folder(tmp_path):
    import time

    from keel_engine.tools import worktrees

    r = _repo(tmp_path / "p", {".keel/config.yml": "layout: keel\n", ".keel/specs/kept.md": "# newer in the folder\n"})
    wt = tmp_path / "wt"
    (wt / ".keel/specs").mkdir(parents=True)
    (wt / ".keel/specs/new.md").write_text("# New\n")
    old = wt / ".keel/specs/kept.md"
    old.write_text("# older in the worktree\n")
    past = time.time() - 60
    os.utime(old, (past, past))
    assert worktrees.keep_keel_files(str(r), wt) == [".keel/specs/new.md"]
    assert (r / ".keel/specs/new.md").read_text() == "# New\n"
    assert (r / ".keel/specs/kept.md").read_text() == "# newer in the folder\n"


def test_native_mode_gives_agents_their_own_home(tmp_path, monkeypatch):
    from keel_engine.models import cli

    monkeypatch.setenv("KEEL_DATA", str(tmp_path / "data"))
    monkeypatch.setenv("HOME", "/Users/someone")
    monkeypatch.delenv("KEEL_NATIVE", raising=False)
    assert cli.safe_env()["HOME"] == "/Users/someone"
    monkeypatch.setenv("KEEL_NATIVE", "1")
    env = cli.safe_env()
    assert env["HOME"].startswith(str(tmp_path / "data")) and env["XDG_CONFIG_HOME"].startswith(env["HOME"])
