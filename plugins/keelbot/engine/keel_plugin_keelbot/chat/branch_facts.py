"""keel 0.18.62 the branch's own facts, for a question about what a branch does ("what does this branch do?").

The model guessed them from `git log` ("about 60 commits" for 58) and left out what a reviewer asks first: is it
pushed, what is not committed, what the spec says it does not do. keel reads them itself (exact, no tokens) and puts
them in the turn's prompt with a short guide for the answer's order.

    asks_about_branch(question)   a question about a branch as a whole
    facts(root)                   {branch, base, ahead, behind, files, added, removed, upstream, unpushed, uncommitted,
                                   specs}; None outside git, on the base itself or with no base found
    prompt_lines(f)               what the turn's prompt says
"""

from __future__ import annotations

import re

from keel_engine.tools import git

# "what does this branch do?", "summarize this MR", "explain my PR"; not "what branch am I on?"
_ASK = re.compile(r"\b(branch|pr|mr|pull request|merge request)\b", re.I)
_WHAT = re.compile(r"\b(summar\w*|explain|overview|describe|about|does|do|purpose|changes?|review)\b", re.I)
BASES = ("main", "master", "develop")
UNCOMMITTED_MAX = 12
SPECS_MAX = 6
SPEC_DIRS = ("docs/specs/", "specs/", ".keel/specs/")


def asks_about_branch(question: str) -> bool:
    q = question or ""
    return bool(_ASK.search(q) and _WHAT.search(q))


def _ok(root: str, *args: str) -> str | None:
    r = git.git(root, *args, timeout=20)
    return r.stdout.strip() if r.returncode == 0 else None


def base(root: str, branch: str) -> str | None:
    """The branch this one is compared with: origin's default branch, else main, master or develop (remote first)."""
    head = _ok(root, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
    names = ([head] if head else []) + [f"origin/{b}" for b in BASES] + list(BASES)
    for n in dict.fromkeys(names):
        if n not in (branch, f"origin/{branch}") and _ok(root, "rev-parse", "--verify", "--quiet", f"{n}^{{commit}}"):
            return n
    return None


def facts(root: str) -> dict | None:
    if not git.is_repo(root):
        return None
    branch = git.branch(root) or ""
    if not branch or branch == "HEAD" or branch in BASES:
        return None
    b = base(root, branch)
    if not b:
        return None
    counts = (_ok(root, "rev-list", "--left-right", "--count", f"{b}...HEAD") or "0\t0").split()
    behind, ahead = (int(x) for x in counts[:2])
    added = removed = files = 0
    specs: list[str] = []
    for line in (_ok(root, "diff", "--numstat", f"{b}...HEAD") or "").splitlines():
        cols = line.split("\t")
        if len(cols) < 3:
            continue
        files += 1
        added += int(cols[0]) if cols[0].isdigit() else 0
        removed += int(cols[1]) if cols[1].isdigit() else 0
        if cols[2].endswith(".md") and cols[2].startswith(SPEC_DIRS):
            specs.append(cols[2])
    upstream = _ok(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
    unpushed = int(_ok(root, "rev-list", "--count", "@{upstream}..HEAD") or 0) if upstream else None
    dirty = sorted(git.dirty(root).items())
    return {"branch": branch, "base": b, "ahead": ahead, "behind": behind, "files": files, "added": added,
            "removed": removed, "upstream": upstream, "unpushed": unpushed,
            "uncommitted": [f"{xy.strip() or '?'} {p}" for p, xy in dirty], "specs": specs[:SPECS_MAX]}


def prompt_lines(f: dict | None) -> list[str]:
    if not f:
        return []
    if f["upstream"] is None:
        pushed = "it has no upstream branch: it was never pushed"
    elif f["unpushed"]:
        pushed = f"{f['unpushed']} commit(s) are not pushed to {f['upstream']}"
    else:
        pushed = f"everything committed is pushed to {f['upstream']}"
    left = f["uncommitted"]
    dirty = ("uncommitted: " + ", ".join(left[:UNCOMMITTED_MAX]) + (f" and {len(left) - UNCOMMITTED_MAX} more"
             if len(left) > UNCOMMITTED_MAX else "")) if left else "nothing uncommitted"
    lines = [f"Facts keel read from git for branch {f['branch']} (exact; use these numbers, do not count again): "
             f"{f['ahead']} commit(s) ahead of {f['base']}, {f['behind']} behind; {f['files']} file(s) changed, "
             f"+{f['added']}/-{f['removed']} lines; {pushed}; {dirty}."]
    if f["specs"]:
        lines.append("Specs this branch adds or changes: " + ", ".join(f["specs"]) + ".")
    lines.append("The person asks what the branch does. Answer in this order: (1) one line with the facts above; "
                 "(2) its purpose in two or three sentences; (3) how it works as numbered steps in the order things "
                 "happen (each step: the class or file, with file:line, and the rule that matters, with real values "
                 "such as retry times or limits); (4) the later fixes, if any; (5) safety and what is switched off; "
                 "(6) the known limitations and what was not tested, from the spec's own words; (7) what you read "
                 "(spec, log, diff, code) and what you did not. Read the spec first when there is one.")
    return lines
