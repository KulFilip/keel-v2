"""keel's git helper: output in another encoding does not crash, a stuck git does not block for ever, no password prompt."""
import os
import stat
import subprocess

import pytest

from keel_engine.tools import git as g


def fake_git(tmp_path, monkeypatch, body: str):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    exe = bin_dir / "git"
    exe.write_text("#!/bin/sh\n" + body + "\n")
    exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")


def test_output_that_is_not_utf8_is_decoded_with_replacement(tmp_path, monkeypatch):
    fake_git(tmp_path, monkeypatch, r"printf 'caf\351.txt\n'")
    r = g.git(str(tmp_path), "ls-files")
    assert r.returncode == 0 and r.stdout.startswith("caf") and r.stdout.strip().endswith(".txt")


def test_git_never_prompts_for_a_password(tmp_path, monkeypatch):
    fake_git(tmp_path, monkeypatch, 'echo "$GIT_TERMINAL_PROMPT"')
    assert g.git(str(tmp_path), "fetch").stdout.strip() == "0"


def test_a_stuck_git_times_out_as_a_failed_command(tmp_path, monkeypatch):
    fake_git(tmp_path, monkeypatch, "sleep 5")
    r = g.git(str(tmp_path), "fetch", timeout=0.3)
    assert r.returncode == 124 and "timed out" in r.stderr
    with pytest.raises(subprocess.CalledProcessError):
        g.git(str(tmp_path), "fetch", timeout=0.3, check=True)
