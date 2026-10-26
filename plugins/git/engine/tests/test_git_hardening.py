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


def test_a_branch_only_origin_has_is_checked_out_as_a_tracking_branch(tmp_path, work):
    origin = tmp_path / "origin.git"
    sh(tmp_path, "clone", "-q", "--bare", str(work), str(origin))
    sh(work, "remote", "add", "origin", str(origin))
    mate = tmp_path / "mate"
    sh(tmp_path, "clone", "-q", str(origin), str(mate))
    sh(mate, "switch", "-q", "-c", "feature/SHOPS-1810-sonar")
    (mate / "s.txt").write_text("s\n")
    sh(mate, "add", "-A")
    sh(mate, "commit", "-q", "-m", "sonar")
    sh(mate, "push", "-q", "origin", "feature/SHOPS-1810-sonar")
    sh(work, "fetch", "-q", "origin")
    assert core.switch(str(work), "feature/SHOPS-1810-sonar")["branch"] == "feature/SHOPS-1810-sonar"
    assert core.status(str(work))["upstream"] == "origin/feature/SHOPS-1810-sonar"
    with pytest.raises(core.GitError) as e:
        core.switch(str(work), "feature/nowhere")
    assert e.value.status == 404


TOKEN = "gho_FAKEtoken1234567890abcdef"  # a fake for the tests  keel:allow-secret


def _record_network(monkeypatch, said):
    """git push / fetch record argv, env and the token file, then fail with `said` (no network); other git runs."""
    from keel_engine.tools import git as git_tool

    calls, real = [], git_tool.git

    def fake(root, *args, **kw):
        if "push" in args or "fetch" in args:
            env = kw.get("env") or {}
            f = env.get("KEEL_GIT_TOKEN_FILE")
            calls.append({"args": list(args), "env": dict(env), "file": open(f).read() if f else None})
            return subprocess.CompletedProcess(["git", *args], 128, "", said)
        return real(root, *args, **kw)
    monkeypatch.setattr(git_tool, "git", fake)
    return calls


def test_push_and_sync_give_the_login_to_its_own_host_only_and_never_show_it(monkeypatch, work):
    from keel_engine.tools import git_auth

    sh(work, "checkout", "-q", "-b", "feature/SHOPS-1234-export")
    sh(work, "remote", "add", "origin", "git@ghe.acme.test:acme/shop.git")
    calls = _record_network(monkeypatch, f"remote: denied for {TOKEN}")
    ghe = git_auth.login({"github": TOKEN, "github_host": "ghe.acme.test"})
    with pytest.raises(core.GitError) as e:
        core.push(str(work), ghe)
    assert TOKEN not in str(e.value) and "***" in str(e.value)
    c = calls[-1]
    assert "https://ghe.acme.test/acme/shop.git" in c["args"] and c["env"]["KEEL_GIT_HOST"] == "ghe.acme.test"
    assert c["file"] == TOKEN and not any(TOKEN in a for a in c["args"]) and TOKEN not in json.dumps(c["env"])
    with pytest.raises(core.GitError) as e:
        core.sync(str(work), ghe)
    assert TOKEN not in str(e.value) and calls[-1]["env"]["KEEL_GIT_HOST"] == "ghe.acme.test"
    # a github.com login is not sent to the Enterprise origin: plain origin, no helper
    core_calls = len(calls)
    with pytest.raises(core.GitError):
        core.push(str(work), git_auth.login({"github": TOKEN}))
    c = calls[core_calls]
    assert c["args"][-2] == "origin" and c["file"] is None and not any("credential.helper=!" in a for a in c["args"])
    assert TOKEN not in (work / ".git" / "config").read_text()


# ------------------------------------------------------------------ the PR card's gh calls, through a fake gh on PATH

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
d = os.environ["FAKE_GH_DIR"]
with open(os.path.join(d, "env.log"), "a") as f:
    f.write(json.dumps({k: os.environ.get(k) for k in ("GH_TOKEN", "GH_HOST", "GH_ENTERPRISE_TOKEN")}) + "\n")
kind = "view" if sys.argv[1:3] == ["pr", "view"] else "api"
def read(name):
    p = os.path.join(d, f"{kind}.{name}")
    return open(p).read() if os.path.exists(p) else None
sys.stdout.write(read("out") or "")
sys.stderr.write(read("err") or "")
sys.exit(int(read("code") or 0))
'''


@pytest.fixture
def fake_gh(tmp_path, monkeypatch, work):
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    (bin_ / "gh").write_text(FAKE_GH)
    (bin_ / "gh").chmod(0o755)
    d = tmp_path / "gh"
    d.mkdir()
    monkeypatch.setenv("PATH", f"{bin_}:{__import__('os').environ['PATH']}")
    monkeypatch.setenv("FAKE_GH_DIR", str(d))
    pr = {"number": 20, "title": "Export orders", "url": "https://github.com/acme/shop/pull/20", "state": "OPEN",
          "isDraft": False, "reviewDecision": "", "statusCheckRollup": [], "comments": [], "baseRefName": "main",
          "headRefName": "feature/SHOPS-1234-export"}
    (d / "view.out").write_text(json.dumps(pr))

    def answer(kind, out=None, err=None, code=0):
        for name, v in (("out", out), ("err", err), ("code", str(code))):
            p = d / f"{kind}.{name}"
            p.unlink(missing_ok=True)
            if v is not None:
                p.write_text(v)
    answer.dir = d
    answer.envs = lambda: [json.loads(x) for x in (d / "env.log").read_text().splitlines()]
    sh(work, "remote", "add", "origin", "git@github.com:acme/shop.git")
    return answer


def test_a_long_paginated_answer_is_read_whole_with_a_notice_on_stderr(fake_gh, work):
    big = [{"user": {"login": "r"}, "body": "x" * 400, "path": "a.py", "line": i} for i in range(60)]   # > 20 kB
    fake_gh("api", json.dumps(big[:30]) + "\n" + json.dumps(big[30:]),
            err="A new release of gh is available: 2.40.0 → 2.60.0\n")
    got = core.pr_status(str(work), "tok")
    assert got["comments_total"] == 60 and got["comments"][-1]["line"] == 59


def test_slurped_pages_and_no_output_are_read_as_lists(fake_gh, work):
    fake_gh("api", json.dumps([_page(0, 2), _page(2, 1)]))
    assert [c["body"] for c in core.pr_status(str(work), "tok")["comments"]] == ["c0", "c1", "c2"]
    fake_gh("api", "")
    assert core.pr_status(str(work), "tok")["comments"] == []


def test_gh_not_logged_in_or_not_json_says_what_gh_said_and_the_way_out(fake_gh, work):
    fake_gh("view", "", "To get started with GitHub CLI, please run:  gh auth login\n", 4)
    with pytest.raises(core.GitError) as e:
        core.pr_status(str(work), "tok")
    assert "gh auth login" in str(e.value) and "sign in again in Connections › GitHub" in e.value.hint
    assert "not JSON at character" not in str(e.value)
    fake_gh("view", json.dumps({"number": 20, "title": "t", "comments": []}))
    fake_gh("api", "Not Found <html>", err=f"HTTP 404 for {TOKEN}\n")
    with pytest.raises(core.GitError) as e:
        core.pr_status(str(work), "tok")
    assert "the review comments" in str(e.value) and "Not Found" in str(e.value)
    assert "not JSON at character" not in str(e.value) + e.value.hint
    fake_gh("api", "", err=f"HTTP 401: Bad credentials {TOKEN}\n", code=1)
    with pytest.raises(core.GitError) as e:
        core.pr_status(str(work), TOKEN)
    assert "Bad credentials" in str(e.value) and TOKEN not in str(e.value) + e.value.hint
    assert "Connections › GitHub" in e.value.hint


def test_gh_gets_the_login_only_for_the_origins_host(fake_gh, work):
    from keel_engine.tools import git_auth

    core.pr_status(str(work), git_auth.login({"github": TOKEN}))
    assert fake_gh.envs()[-1] == {"GH_TOKEN": TOKEN, "GH_HOST": None, "GH_ENTERPRISE_TOKEN": None}
    ghe = git_auth.login({"github": TOKEN, "github_host": "ghe.acme.test"})
    core.pr_status(str(work), ghe)                                  # origin is github.com: no token for gh at all
    assert fake_gh.envs()[-1] == {"GH_TOKEN": None, "GH_HOST": None, "GH_ENTERPRISE_TOKEN": None}
    sh(work, "remote", "set-url", "origin", "https://ghe.acme.test/acme/shop.git")
    core.pr_status(str(work), ghe)
    assert fake_gh.envs()[-1] == {"GH_TOKEN": None, "GH_HOST": "ghe.acme.test", "GH_ENTERPRISE_TOKEN": TOKEN}
