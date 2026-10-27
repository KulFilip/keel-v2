"""keel 0.18.62 "what does this branch do?": keel reads the branch's facts from git itself (commits ahead, files,
lines, pushed or not, uncommitted files, specs) and gives them to KeelBot with the answer's order, so the model does
not guess "about 60 commits"."""

import subprocess

from keel_plugin_keelbot.chat import branch_facts

from test_memory import Script, new_session, turn


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


def feature_branch(repo, tmp_path):
    """The demo repo on main with a remote, then a feature branch: two pushed commits, one not pushed, one dirty file."""
    git(repo, "branch", "-M", "main")
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "-q", "--bare", str(remote)], check=True)
    git(repo, "remote", "add", "origin", str(remote))
    git(repo, "push", "-q", "-u", "origin", "main")
    git(repo, "checkout", "-q", "-b", "feat/parcel-push")
    (repo / "docs" / "specs").mkdir(parents=True, exist_ok=True)
    (repo / "docs" / "specs" / "parcel-push.md").write_text("# Parcel push\n\n## Known limitations\n- no backfill\n")
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "spec")
    (repo / "push.py").write_text("a = 1\nb = 2\nc = 3\n")
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "push")
    git(repo, "push", "-q", "-u", "origin", "feat/parcel-push")
    (repo / "retry.py").write_text("x = 1\n")
    git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "retry")
    (repo / "push.py").write_text("a = 1\n")      # uncommitted


def test_the_facts_are_exact(repo, tmp_path):
    feature_branch(repo, tmp_path)
    f = branch_facts.facts(str(repo))
    assert f["branch"] == "feat/parcel-push" and f["base"] == "origin/main"
    assert (f["ahead"], f["behind"], f["files"]) == (3, 0, 3)
    assert f["added"] == 4 + 3 + 1 and f["removed"] == 0
    assert f["upstream"] == "origin/feat/parcel-push" and f["unpushed"] == 1
    assert f["uncommitted"] == ["M push.py"] and f["specs"] == ["docs/specs/parcel-push.md"]
    line = branch_facts.prompt_lines(f)[0]
    assert "3 commit(s) ahead of origin/main" in line and "+8/-0 lines" in line
    assert "1 commit(s) are not pushed" in line and "uncommitted: M push.py" in line


def test_no_facts_on_the_base_or_a_branch_never_pushed_says_so(repo, tmp_path):
    git(repo, "branch", "-M", "main")
    assert branch_facts.facts(str(repo)) is None              # on main itself
    git(repo, "checkout", "-q", "-b", "local-only")
    f = branch_facts.facts(str(repo))
    assert f["base"] == "main" and f["upstream"] is None
    assert "never pushed" in branch_facts.prompt_lines(f)[0]


def test_which_questions_ask_about_the_branch():
    yes = ["what does this branch do?", "Summarize this MR", "explain my PR", "what changes are in this branch",
           "review the pull request"]
    no = ["what branch am I on?", "where is the cart total computed?", "fix the failing test"]
    assert all(branch_facts.asks_about_branch(q) for q in yes)
    assert not any(branch_facts.asks_about_branch(q) for q in no)


def test_the_facts_and_the_order_reach_keelbots_prompt_only_for_that_question(client, repo, tmp_path, monkeypatch):
    feature_branch(repo, tmp_path)
    sc = Script(monkeypatch, "ok", "ok")
    sid = new_session(client, repo)["id"]
    turn(client, sid, "What does this branch do?")
    p = sc.reqs[0].prompt
    assert "Facts keel read from git for branch feat/parcel-push" in p and "3 commit(s) ahead" in p
    assert "known limitations" in p and "Specs this branch adds or changes: docs/specs/parcel-push.md" in p
    turn(client, sid, "Where is retry handled?")
    assert "Facts keel read from git" not in sc.reqs[1].prompt
