"""The pull request read when GitHub does not answer: gh runs once more after ~2 s on a network error (TLS handshake
timeout, connection reset, 502/503/504) and the route marks what still fails as transient, so Source control offers
"Try again" instead of an error. A real error (bad credentials, no repository) is not retried. Also the line counts
of the uncommitted files and "mine" on a branch, which Source control shows."""

import json
import subprocess

import pytest

from keel_plugin_git import core

ID = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]
TLS = "Post \"https://api.github.com/graphql\": net/http: TLS handshake timeout\n"
PR = {"number": 7, "title": "Euro prices", "url": "https://github.com/o/r/pull/7", "state": "OPEN", "isDraft": False,
      "reviewDecision": "REVIEW_REQUIRED", "statusCheckRollup": [{"name": "ci", "conclusion": "SUCCESS"}], "comments": [],
      "baseRefName": "main", "headRefName": "feat/euro", "reviewRequests": [{"login": "ann"}, {"name": "Core team"}],
      "updatedAt": "2026-10-22T09:00:00Z"}


def sh(root, *args):
    return subprocess.run(["git", *ID, *args], cwd=root, check=True, capture_output=True, text=True)


@pytest.fixture
def work(tmp_path):
    root = tmp_path / "w"
    root.mkdir()
    sh(root, "init", "-q", "-b", "main")
    (root / "a.txt").write_text("one\ntwo\nthree\n")
    (root / "b.txt").write_text("b\n")
    sh(root, "add", "-A")
    sh(root, "commit", "-q", "-m", "one")
    return root


@pytest.fixture
def gh(monkeypatch):
    """A fake gh: `answers` is the list of (exit code, output) each call gives in turn; `calls` the commands it got;
    `slept` the waits between tries (none really happen)."""
    state = {"answers": [], "calls": [], "slept": []}

    def run(root, cmd, timeout=600, env=None):
        state["calls"].append(cmd)
        assert env and env.get("GH_TOKEN") == "tok"
        if cmd.startswith("gh api"):
            return 0, "[]"
        return state["answers"].pop(0)

    monkeypatch.setattr(core.testcmd, "run", run)
    monkeypatch.setattr(core, "_sleep", lambda s: state["slept"].append(s))
    return state


def views(state):
    return [c for c in state["calls"] if c.startswith("gh pr view")]


def test_a_tls_timeout_once_is_retried_after_two_seconds_and_the_pr_comes(gh, work):
    gh["answers"] = [(1, TLS), (0, json.dumps(PR))]
    got = core.pr_status(str(work), "tok")
    assert got["number"] == 7 and got["checks_done"] == 1
    assert got["review_requests"] == ["ann", "Core team"] and got["updated_at"] == "2026-10-22T09:00:00Z"
    assert len(views(gh)) == 2 and gh["slept"] == [core.RETRY_AFTER_S] and core.RETRY_AFTER_S == pytest.approx(2.0)


@pytest.mark.parametrize("out", [TLS, "read tcp 10.0.0.2:5050->140.82.112.6:443: read: connection reset by peer",
                                 "dial tcp 140.82.112.6:443: connect: connection refused", "dial tcp: i/o timeout",
                                 "HTTP 502: Bad Gateway (https://api.github.com/graphql)", "HTTP 503", "HTTP 504"])
def test_failing_twice_on_the_network_is_a_transient_error(gh, work, out):
    gh["answers"] = [(1, out), (1, out)]
    with pytest.raises(core.GitError) as e:
        core.pr_status(str(work), "tok")
    assert e.value.transient is True and e.value.status == 504
    assert "GitHub did not answer in time" in str(e.value) and "branch and its commits are fine" in e.value.hint
    assert len(views(gh)) == 2 and gh["slept"] == [core.RETRY_AFTER_S]


@pytest.mark.parametrize("out", ["HTTP 401: Bad credentials (https://api.github.com/graphql)",
                                 "GraphQL: Could not resolve to a Repository with the name 'o/r'. (repository)"])
def test_a_real_error_is_not_retried_and_not_transient(gh, work, out):
    gh["answers"] = [(1, out)]
    with pytest.raises(core.GitError) as e:
        core.pr_status(str(work), "tok")
    assert e.value.transient is False and e.value.status == 502
    assert len(views(gh)) == 1 and gh["slept"] == []


def test_no_pull_request_is_none_not_an_error(gh, work):
    gh["answers"] = [(1, "no pull requests found for branch \"main\"")]
    assert core.pr_status(str(work), "tok") is None and gh["slept"] == []


def test_opening_a_pull_request_never_runs_twice(gh, work, monkeypatch):
    monkeypatch.setattr(core, "pr_status", lambda root, token: None)
    sh(work, "switch", "-q", "-c", "feat/x")
    bare = work.parent / "o.git"
    subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True)
    sh(work, "remote", "add", "origin", str(bare))
    sh(work, "push", "-q", "-u", "origin", "feat/x")
    gh["answers"] = [(1, TLS)]
    with pytest.raises(core.GitError):
        core.pr(str(work), "tok", "A title", "body")
    assert [c for c in gh["calls"] if c.startswith("gh pr create")] and len(gh["calls"]) == 1 and gh["slept"] == []


def test_the_route_answers_a_transient_error_as_data_and_a_real_one_as_an_error(client, gh, work):
    gh["answers"] = [(1, TLS), (1, TLS)]
    r = client.post("/plugins/git/pr_status", json={"root": str(work), "keys": {"github": "tok"}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["pr"] is None and body["error"]["transient"] is True
    assert "TLS handshake timeout" in body["error"]["message"] and body["error"]["hint"]

    gh["answers"] = [(1, "HTTP 401: Bad credentials")]
    r = client.post("/plugins/git/pr_status", json={"root": str(work), "keys": {"github": "tok"}})
    assert r.status_code >= 400 and "Bad credentials" in r.json()["error"]

    gh["answers"] = [(1, TLS), (0, json.dumps(PR))]
    r = client.post("/plugins/git/pr_status", json={"root": str(work), "keys": {"github": "tok"}})
    assert r.status_code == 200 and r.json()["pr"]["number"] == 7 and "error" not in r.json()


def test_wait_checks_keeps_waiting_through_a_transient_error(gh, work):
    done = {**PR, "statusCheckRollup": [{"name": "ci", "conclusion": "SUCCESS"}]}
    gh["answers"] = [(1, TLS), (1, TLS), (0, json.dumps(done))]
    waits = []
    out = core.wait_checks(str(work), "tok", timeout_s=600, every_s=30, sleep=waits.append)
    assert out["ok"] is True and waits == [30]


def test_status_counts_the_lines_of_each_tracked_change(work):
    (work / "a.txt").write_text("one\nTWO\nthree\nfour\n")       # 2 added, 1 deleted
    sh(work, "rm", "-q", "b.txt")                                # 1 deleted
    (work / "new.txt").write_text("x\n")                         # untracked: no counts
    got = {c["path"]: c for c in core.status(str(work))["changes"]}
    assert (got["a.txt"]["added"], got["a.txt"]["deleted"]) == (2, 1)
    assert (got["b.txt"]["added"], got["b.txt"]["deleted"]) == (0, 1)
    assert "added" not in got["new.txt"] and got["new.txt"]["status"] == "??"


def test_status_counts_a_renamed_file_under_its_new_name(work):
    sh(work, "mv", "a.txt", "c.txt")
    got = {c["path"]: c for c in core.status(str(work))["changes"]}
    assert got["c.txt"]["status"].startswith("R") and (got["c.txt"]["added"], got["c.txt"]["deleted"]) == (0, 0)


def test_branches_say_whose_they_are_when_git_has_a_user(work):
    sh(work, "config", "user.email", "me@example.com")
    sh(work, "switch", "-q", "-c", "feat/mine")
    (work / "m.txt").write_text("m\n")
    sh(work, "add", "-A")
    subprocess.run(["git", "-c", "user.name=Me", "-c", "user.email=ME@example.com", "-c", "commit.gpgsign=false", "commit", "-q",
                    "-m", "mine"], cwd=work, check=True)
    got = {b["name"]: b for b in core.branches(str(work))}
    assert got["feat/mine"]["mine"] is True and got["feat/mine"]["author"] == "Me"
    assert got["main"]["mine"] is False and got["feat/mine"]["ahead"] == 1


def test_branches_leave_mine_out_without_a_git_user(work, monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "none"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    assert all("mine" not in b for b in core.branches(str(work)))
