"""0.18.57 Which branch, review ref or commit an answer, a finding or a citation was made from.

A `file:line` link opens keel's Code page. When the text was written while looking at another branch than the one the
project folder has checked out (a KeelBot side session's worktree, a flow's worktree, a PR head the review fetched under
refs/keel/, a file KeelBot read with `git show <ref>:<path>`), the link carries that ref so the Code page shows the file
as that ref has it, not "file not found" (plugins/code RepoRefs, GET /repo/file-at).

    checkout_ref(root)            the branch (or commit) a folder has checked out, and whether it is a linked worktree
    read_refs(command)            {path: ref} for each `git show <ref>:<path>` / `git cat-file -p <ref>:<path>` in a command
    flow_source_ref(root, data)   the ref a flow's citations are about (a reviewed PR's head, a worktree flow's branch)
"""

from __future__ import annotations

import re
import shlex
from pathlib import Path

from . import git

# the same names the Code page's api accepts (RepoRefs.checkRef): never an option, a range or a revision expression
REF_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/+-]{0,250}$")
READ_SUBCOMMANDS = {"show", "cat-file"}
SEPARATORS = {"|", "||", "&&", ";", "&"}
MAX_PATHS = 200


def ok_ref(ref: str) -> bool:
    return bool(REF_NAME.match(ref)) and ".." not in ref and "//" not in ref and not ref.endswith("/") \
        and not ref.endswith(".lock") and not any(p.startswith(".") for p in ref.split("/")) and ref != "HEAD"


def checkout_ref(root: str) -> dict:
    """{ref, sha, worktree?}: the folder's branch (its commit id when detached); `worktree` is the folder when it is a
    linked worktree (a side session's, a flow's). {} when it is not a git repo."""
    try:
        sha = git.git(root, "rev-parse", "--verify", "-q", "HEAD").stdout.strip()
        if not sha:
            return {}
        branch = git.git(root, "symbolic-ref", "-q", "--short", "HEAD").stdout.strip()
    except Exception:  # noqa: BLE001  (where an answer came from is a nicety: never a turn's failure)
        return {}
    out: dict = {"ref": branch or sha, "sha": sha}
    if Path(root, ".git").is_file():           # a linked worktree's .git is a file that points at the main repo
        out["worktree"] = str(root)
    return out


def _tokens(command: str) -> list[str]:
    try:
        lex = shlex.shlex(command, posix=True, punctuation_chars=";&|")
        lex.whitespace_split = True
        return list(lex)
    except ValueError:                       # an unclosed quote: words are good enough
        return command.split()


def read_refs(command: str) -> dict[str, str]:
    """{path: ref} for each file a command reads at another ref: `git show <ref>:<path>`, `git cat-file -p|blob
    <ref>:<path>` (also `git -C dir --no-pager show …`). `HEAD:<path>` and anything that is not a plain ref name are
    left out: those links stay on the work tree."""
    if "git" not in command or ":" not in command:
        return {}
    out: dict[str, str] = {}
    toks = _tokens(command)
    i = 0
    while i < len(toks):
        if Path(toks[i]).name != "git":
            i += 1
            continue
        j = i + 1
        while j < len(toks) and toks[j].startswith("-"):          # git's own options: -C <dir>, -c k=v, --no-pager
            j += 2 if toks[j] in ("-C", "-c") else 1
        if j >= len(toks) or toks[j] not in READ_SUBCOMMANDS:
            i = j
            continue
        k = j + 1
        while k < len(toks) and toks[k] not in SEPARATORS:
            t = toks[k]
            k += 1
            if t.startswith("-") or ":" not in t:
                continue
            ref, _, path = t.partition(":")
            path = path.removeprefix("./")
            if ok_ref(ref) and path and not path.startswith("/") and ".." not in path.split("/") and len(out) < MAX_PATHS:
                out[path] = ref
        i = k
    return out


def flow_source_ref(root: str | None, data: dict | None) -> str | None:
    """The ref a flow's citations are about: the reviewed change's head (review-pr: refs/keel/review-pr/<n>, or the
    branch), a fix flow's own worktree branch, or the branch of the linked worktree the flow runs in; None for a flow
    in the project folder (its links open the folder's checkout)."""
    d = data or {}
    review = ((d.get("ticket_review") or {}).get("source") or {}) if isinstance(d.get("ticket_review"), dict) else {}
    ref = str(review.get("ref") or "")
    if ref and ok_ref(ref):
        return ref
    wt = d.get("worktree") if isinstance(d.get("worktree"), dict) else {}
    branch = str((wt or {}).get("branch") or "")
    if branch and ok_ref(branch):
        return branch
    if root and Path(root, ".git").is_file():
        got = checkout_ref(root).get("ref")
        return got if got and ok_ref(got) else None
    return None
