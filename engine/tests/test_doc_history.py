"""v0.15.9 keel's file history: doc.version events for keel's files, keel.applied for commits."""

import subprocess
from pathlib import Path

from keel_engine.runtime import doc_history


def _repo(root: Path, files: dict[str, str]) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=root, check=True)
    for rel, text in files.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text)
    return root


class Bus:
    def __init__(self):
        self.events = []

    def __call__(self, type_, step=None, data=None):
        self.events.append((type_, step, data))


def test_snapshot_follows_the_layout(tmp_path):
    r = _repo(tmp_path / "p", {".keel/config.yml": "layout: keel\n", ".keel/specs/a.md": "# A\n",
                               ".keel/knowledge/data.md": "# D\n", "docs/specs/old.md": "# Old\n", "src/x.py": "x = 1\n"})
    assert set(doc_history.snapshot(str(r))) == {".keel/specs/a.md", ".keel/knowledge/data.md", "docs/specs/old.md"}


def test_a_step_records_who_changed_what(tmp_path):
    r = _repo(tmp_path / "p", {".keel/config.yml": "layout: keel\n", ".keel/specs/a.md": "# A\n"})
    bus = Bus()
    before = doc_history.before_step(bus, str(r), "spec", "explore")
    assert [d["by_kind"] for _, _, d in bus.events] == ["outside"]          # first sight: what is there
    (r / ".keel/specs/a.md").write_text("# A\n- **AC-1** [API] a\n")
    (r / ".keel/specs/b.md").write_text("# B\n")
    bus.events.clear()
    doc_history.after_step(bus, str(r), before, "agent", "explorer", "spec", "explore", "mcp")
    got = {d["path"]: d for _, _, d in bus.events}
    assert set(got) == {".keel/specs/a.md", ".keel/specs/b.md"}
    assert got[".keel/specs/b.md"]["content"] == "# B\n" and got[".keel/specs/b.md"]["kind"] == "spec"
    assert {d["by_kind"] for d in got.values()} == {"agent"} and got[".keel/specs/a.md"]["via"] == "mcp"

    # the person edits while a gate waits, then deletes one: both show up before the next step, as outside keel
    (r / ".keel/specs/a.md").write_text("# A edited\n")
    (r / ".keel/specs/b.md").unlink()
    bus.events.clear()
    doc_history.before_step(bus, str(r), "spec", "spec_gate")
    got = {d["path"]: d for _, _, d in bus.events}
    assert got[".keel/specs/a.md"]["by_kind"] == "outside" and got[".keel/specs/b.md"]["deleted"] is True


def test_secrets_are_masked_and_big_files_have_no_content(tmp_path):
    r = _repo(tmp_path / "p", {".keel/config.yml": "layout: keel\n",
                               ".keel/specs/s.md": "# S\naws_secret_access_key = AKIAABCDEFGHIJKLMNOP\nok line\n",  # keel:allow-secret (a fake key: the masking test)
                               ".keel/specs/big.md": "x" * (doc_history.MAX_CONTENT + 1)})
    ev = {d["path"]: d for d in doc_history.changes(str(r), {})}
    assert "AKIA" not in ev[".keel/specs/s.md"]["content"] and "ok line" in ev[".keel/specs/s.md"]["content"]
    assert "content" not in ev[".keel/specs/big.md"] and ev[".keel/specs/big.md"]["size"] == doc_history.MAX_CONTENT + 1


def test_commits_and_records_are_sent_as_keel_applied(tmp_path, monkeypatch):
    from keel_engine.events import bus
    from keel_engine.runtime.actions import ActionInput, commit

    r = _repo(tmp_path / "p", {".keel/config.yml": "layout: keel\n", ".keel/specs/x.md": "# X\n"})
    res = commit(ActionInput(root=str(r), phase="spec", title="x", ac=None, acs=[], fake=True, flow="feature",
                             paths=[".keel/specs/x.md"], thread_id="t-h", project="p"))
    assert res.ok
    ev = [e for e in bus.of("t-h", "keel.applied")]
    assert ev and ev[-1]["data"]["kind"] == "recorded" and ev[-1]["data"]["files"] == [".keel/specs/x.md"]
