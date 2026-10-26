"""0.18.57 An answer remembers what it was made from (keel_engine.tools.source_ref): the branch of the folder it worked
in, a side session's worktree, and the files it read at another ref with `git show <ref>:<path>`. Its file:line links
then open the file as that ref has it, not "file not found" on the project folder's checkout."""

import subprocess
from pathlib import Path

from test_helper import ask, new_session, side_session


def _git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True).stdout


def test_an_answer_records_its_branch_and_the_files_it_read_at_another_ref(client, repo, monkeypatch):
    from keel_engine.models import fake

    real = fake.FakeRunner.run

    async def run(self, req, emit):
        # KeelBot reads a PR's file without checking it out, as it does for a review
        emit("tool", "git --no-pager show feature/SHOPS-1234-export:src/Orders/ExportService.php | sed -n '1,40p'",
             tool="Bash", ok=True)
        emit("tool", "git show HEAD:README.md", tool="Bash", ok=True)          # HEAD is the folder's: no ref
        return await real(self, req, emit)

    monkeypatch.setattr(fake.FakeRunner, "run", run)
    s = new_session(client, repo)
    _, s = ask(client, s["id"], "What does the export do?")
    src = s["messages"][-1]["data"]["source"]
    assert src["ref"] == _git(repo, "symbolic-ref", "--short", "HEAD").strip()
    assert src["sha"] == _git(repo, "rev-parse", "HEAD").strip()
    assert "worktree" not in src
    assert src["paths"] == {"src/Orders/ExportService.php": "feature/SHOPS-1234-export"}


def test_a_side_sessions_answer_is_about_its_own_branch_and_worktree(client, repo):
    s = side_session(client, repo)
    _, got = ask(client, s["id"], "Add a small helper.")
    src = got["messages"][-1]["data"]["source"]
    assert src["ref"] == s["branch"] and src["ref"].startswith("keel/helper/")
    assert Path(src["worktree"]).resolve() == Path(s["worktree"]).resolve()
    assert "paths" not in src
