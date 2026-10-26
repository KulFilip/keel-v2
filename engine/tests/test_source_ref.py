"""0.18.57 keel_engine.tools.source_ref: the ref an answer, a finding or a flow's citation was made from, so its
file:line links open the file there (the Code page's ?ref=)."""

import subprocess

from keel_engine.tools import source_ref


def git(root, *args):
    subprocess.run(["git", "-c", "user.name=T", "-c", "user.email=t@example.com", *args], cwd=root, check=True,
                   capture_output=True)


def repo(tmp_path):
    r = tmp_path / "shop"
    r.mkdir()
    git(r, "init", "-q", "-b", "main")
    (r / "README.md").write_text("# shop\n")
    git(r, "add", "-A")
    git(r, "commit", "-q", "-m", "first")
    return r


def test_read_refs_finds_files_read_at_another_ref():
    f = "src/Orders/ExportService.php"
    assert source_ref.read_refs(f"git show feature/SHOPS-1234-export:{f} | sed -n '1,40p'") == {f: "feature/SHOPS-1234-export"}
    assert source_ref.read_refs(f"git -C /x --no-pager show refs/keel/review-pr/7:./{f}") == {f: "refs/keel/review-pr/7"}
    assert source_ref.read_refs(f"git cat-file -p origin/feature/x:{f} && git show main:README.md") == \
        {f: "origin/feature/x", "README.md": "main"}
    assert source_ref.read_refs(f"git show 3f2a9c1:{f}") == {f: "3f2a9c1"}
    # the folder's own HEAD, revision expressions, ranges and other commands are not a ref to open
    for cmd in (f"git show HEAD:{f}", f"git show main~1:{f}", f"git show HEAD^:{f}", f"git diff main...feature -- {f}",
                f"cat {f}", f"git log -p {f}", "echo a:b", f"git show feature/x:../../etc/passwd", f"git show x:/etc/passwd",
                "git show 'unclosed"):
        assert source_ref.read_refs(cmd) == {}, cmd


def test_checkout_ref_is_the_branch_or_the_commit_and_names_a_linked_worktree(tmp_path):
    r = repo(tmp_path)
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=r, capture_output=True, text=True).stdout.strip()
    assert source_ref.checkout_ref(str(r)) == {"ref": "main", "sha": head}
    wt = tmp_path / "side"
    git(r, "worktree", "add", "-q", "-b", "keel/helper/abc", str(wt))
    got = source_ref.checkout_ref(str(wt))
    assert got["ref"] == "keel/helper/abc" and got["worktree"] == str(wt)
    git(r, "checkout", "-q", "--detach")
    assert source_ref.checkout_ref(str(r)) == {"ref": head, "sha": head}
    assert source_ref.checkout_ref(str(tmp_path)) == {}                  # not a repo


def test_a_flows_citations_are_about_the_reviewed_head_or_its_worktrees_branch(tmp_path):
    r = repo(tmp_path)
    review = {"ticket_review": {"source": {"pr": 7, "ref": "refs/keel/review-pr/7", "base_ref": "refs/keel/review-pr/7-base"}}}
    assert source_ref.flow_source_ref(str(r), review) == "refs/keel/review-pr/7"
    assert source_ref.flow_source_ref(str(r), {"ticket_review": {"source": {"ref": "origin/feature/x"}}}) == "origin/feature/x"
    assert source_ref.flow_source_ref(str(r), {"worktree": {"name": "fix-1", "branch": "fix/totals"}}) == "fix/totals"
    assert source_ref.flow_source_ref(str(r), {}) is None                  # a flow in the project folder
    wt = tmp_path / "flow"
    git(r, "worktree", "add", "-q", "-b", "feat/export", str(wt))
    assert source_ref.flow_source_ref(str(wt), None) == "feat/export"
    assert source_ref.flow_source_ref(str(r), {"ticket_review": {"source": {"ref": "--output=x"}}}) is None
