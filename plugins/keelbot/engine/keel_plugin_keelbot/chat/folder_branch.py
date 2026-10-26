"""keel 0.18.57 the branch the project folder is on, for a KeelBot chat that reads the code there (Ask, Edit).

A flow started with its own branch in project-folder mode checks that branch out in the shared folder. A chat that
runs at the same time then reads other code without knowing it. So each answer records the branch it read
(`folder_branch` in its data); the next turn compares, and when the folder moved it tells KeelBot (prompt_lines) and
the person (`branch_switch` in the answer's data: the chat's banner "a flow switched this folder to <branch> at
<time>"). A side session has its own worktree and branch, and Fix works on the flow's own folder: neither is checked.

    current(root)                       the branch, "detached at <sha>", or "" outside git
    last_seen(sid, before_n)            the branch the chat's last answer read, "" when none recorded it
    switch(root, was, now, keel)        {from, to, at, by}: when the folder moved and which flow has that branch
    prompt_lines(now, sw)               what the turn's prompt says about it
"""

from __future__ import annotations

import re

from keel_engine.tools import git

from .sessions import get

WATCHED_MODES = ("ask", "edit")


def watched(s: dict) -> bool:
    """A chat that reads the project folder itself (not a side session's worktree)."""
    return s.get("mode") in WATCHED_MODES and not s.get("worktree")


def current(root: str) -> str:
    if not git.is_repo(root):
        return ""
    b = git.branch(root) or ""
    if b == "HEAD":
        sha = git.head(root) or ""
        return f"detached at {sha[:7]}" if sha else ""
    return b


def last_seen(sid: str, before_n: int) -> str:
    msgs = [m for m in get(sid)["messages"] if m["n"] < before_n and m["role"] in ("helper", "note")
            and (m.get("data") or {}).get("folder_branch")]
    return str(msgs[-1]["data"]["folder_branch"]) if msgs else ""


_MOVE = re.compile(r"^HEAD@\{(?P<at>[^}]+)\}\t(?:checkout|switch): moving from (?P<from>\S+) to (?P<to>\S+)")


def switched_at(root: str, to: str) -> str | None:
    """When the folder last moved to `to` (ISO time from git's reflog), None when the reflog does not say."""
    r = git.git(root, "reflog", "-n", "50", "--date=iso-strict", "--format=%gd%x09%gs", "HEAD")
    if r.returncode != 0:
        return None
    for line in r.stdout.splitlines():
        m = _MOVE.match(line.strip())
        if m and m.group("to") == to:
            return m.group("at")
    return None


def switch(root: str, was: str, now: str, keel: dict | None = None) -> dict | None:
    """{from, to, at, by} when the folder is on another branch than the chat's last answer read; by is the title of
    the project's flow on that branch (the api's view of keel), "" when none is known."""
    if not was or not now or was == now:
        return None
    by = next((str(f.get("title") or "") for f in (keel or {}).get("flows") or []
               if isinstance(f, dict) and f.get("branch") == now), "")
    return {"from": was, "to": now, "at": switched_at(root, now), "by": by}


def prompt_lines(now: str, sw: dict | None) -> list[str]:
    if not now:
        return []
    out = [f"The project folder is on branch {now}: the code you read is that branch's."]
    if sw:
        who = f"the flow \"{sw['by']}\"" if sw.get("by") else "something outside this chat (a flow, or the person)"
        out.append(f"Since your last answer the project folder moved from branch {sw['from']} to {sw['to']} "
                   f"({who} checked it out{' at ' + sw['at'] if sw.get('at') else ''}). What you read before may be "
                   "different now: read again what the question needs, and start your answer by saying the branch "
                   f"changed to {sw['to']}.")
    return out
