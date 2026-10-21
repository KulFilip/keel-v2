"""Git core, small checks on a real repository in a temp folder: status with renames and odd names, a log range that is
an option, the pages of `gh api --paginate`, and a sync whose fetch fails."""

import json
import subprocess

import pytest

from keel_plugin_git import core

ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]


def sh(root, *args):
    return subprocess.run(["git", *ID, *args], cwd=root, check=True, capture_output=True, text=True)


@pytest.fixture
def work(tmp_path):
    root = tmp_path / "w"
    root.mkdir()
    sh(root, "init", "-q", "-b", "main")
    (root / "old.txt").write_text("hello\n" * 5)
    (root / "keep.txt").write_text("k\n")
    sh(root, "add", "-A")
    sh(root, "commit", "-q", "-m", "one")
    return root


def test_status_reports_a_rename_by_its_new_path_and_unicode_names_as_they_are(work):
    sh(work, "mv", "old.txt", "new name.txt")
    (work / "café.txt").write_text("x\n")
    (work / "q\"uote.txt").write_text("x\n")
    got = {c["path"]: c["status"] for c in core.status(str(work))["changes"]}
    assert got["new name.txt"] == "R" and "old.txt" not in got and "old.txt -> new name.txt" not in got
    assert got["café.txt"] == "??" and got['q"uote.txt'] == "??"


def test_log_refuses_a_range_that_is_an_option(work):
    for bad in ("--output=/tmp/keel-x", "-p", "--all", "main..HEAD --stat"):
        with pytest.raises(core.GitError) as e:
            core.log(str(work), rng=bad)
        assert e.value.status == 400
    assert core.log(str(work), rng="HEAD")[0]["subject"] == "one"
    assert core.log(str(work), rng="main..HEAD") == []


def _page(start, n):
    return [{"user": {"login": "r"}, "body": f"c{i}", "path": "a.py", "line": i} for i in range(start, start + n)]


def _pr(monkeypatch, work, inline_out, inline_code=0):
    pr = {"number": 7, "title": "t", "url": "u", "state": "OPEN", "isDraft": False, "reviewDecision": "", "statusCheckRollup": [],
          "comments": [], "baseRefName": "main", "headRefName": "x"}

    def fake_gh(root, token, cmd, timeout=60):
        return (0, json.dumps(pr)) if cmd.startswith("gh pr view") else (inline_code, inline_out)

    monkeypatch.setattr(core, "_gh", fake_gh)
    return core.pr_status(str(work), "tok")


def test_review_comments_survive_more_than_one_page_of_gh_api_paginate(monkeypatch, work):
    out = json.dumps(_page(0, 30)) + json.dumps(_page(30, 12))            # [..][..]: what gh prints for two pages
    got = _pr(monkeypatch, work, out)
    assert [c["body"] for c in got["comments"]] == [f"c{i}" for i in range(42)]
    assert got["comments"][3]["path"] == "a.py"


def test_unreadable_review_comments_are_an_error_not_silence(monkeypatch, work):
    with pytest.raises(core.GitError) as e:
        _pr(monkeypatch, work, '[{"body": "x"}][{"body": ')
    assert e.value.status == 502


def test_a_failed_fetch_stops_sync_instead_of_merging_a_stale_ref(tmp_path, work):
    origin = tmp_path / "origin.git"
    sh(tmp_path, "clone", "-q", "--bare", str(work), str(origin))
    sh(work, "remote", "add", "origin", str(origin))
    sh(work, "fetch", "-q", "origin")
    sh(work, "checkout", "-q", "-b", "feat")
    sh(work, "remote", "set-url", "origin", str(tmp_path / "gone.git"))     # the remote cannot be reached any more
    with pytest.raises(core.GitError) as e:
        core.sync(str(work))
    assert e.value.status == 502 and "fetch" in str(e.value)
