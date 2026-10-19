"""Permission cards for KeelBot's Fix mode: a command that changes something waits for the person's OK.

Who asks: keel's PreToolUse hook (claude, and opencode through its plugin) and keel's own ToolBox (API-key models).
How: an HTTP call to the URL in the run's ask settings `{url, key, session}` (KeelBot names its
`POST /helper/permissions/ask`, which checks the turn's key and asks keel_engine/approvals.py). It waits until the
person answers in the panel or the Inbox (Allow once, Always for this command, Deny with a reason), or until
ASK_TIMEOUT. The call carries the turn's own ask key: it can only ask; answering takes keel's internal token, which no
agent has.

Stdlib only (plus run_mode, itself stdlib): the hook imports this on every tool call.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request

from . import run_mode

ASK_TIMEOUT = 600           # seconds a command waits for the person
HOOK_TIMEOUT = ASK_TIMEOUT + 60


# keel 0.18.18 commands that throw work away: always asked (an "always" grant never covers them), with a warning that
# says what is lost. (pattern, warning)
_GIT = r"(?:^|[;&|(]\s*|\s)git(?:\s+-C\s+\S+)?\s+"
DESTRUCTIVE = [
    (re.compile(_GIT + r"reset\b[^;&|]*--hard\b"),
     "git reset --hard throws away every uncommitted change in the folder; it cannot be undone."),
    (re.compile(_GIT + r"checkout\b[^;&|]*(?:\s--(?:\s|$)|\s\.(?:\s|$)|\s-f\b|\s--force\b)"),
     "This checkout overwrites files with their committed version: their uncommitted changes are lost."),
    (re.compile(_GIT + r"restore\b(?![^;&|]*--staged(?![^;&|]*--worktree))"),
     "git restore puts files back to their committed version: their uncommitted changes are lost."),
    (re.compile(_GIT + r"switch\b[^;&|]*(?:--discard-changes|\s-f\b|\s--force\b)"),
     "This switch throws away the uncommitted changes in the folder."),
    (re.compile(_GIT + r"clean\b"),
     "git clean deletes the files git does not track (new files nobody committed); they do not come back."),
    (re.compile(_GIT + r"stash\s+(?:drop|clear)\b"),
     "This deletes stashed changes for good."),
    (re.compile(_GIT + r"branch\s+[^;&|]*-D\b"),
     "git branch -D deletes a branch even when its commits are on no other branch."),
    (re.compile(r"(?:^|[;&|(]\s*|\s)(?:sudo\s+)?rm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b"),
     "rm -r deletes these files and folders for good."),
]
# commands that change the files of the folder they run in (a flow working in the project folder sees them change)
_TREE = re.compile(_GIT + r"(?:checkout|switch|pull|merge|rebase|reset|stash|restore|cherry-pick|revert|am|apply)\b")


def destructive(command: str) -> str:
    """The warning for a command that throws work away (always asked, never covered by "always"), else ""."""
    cmd = str(command or "")
    return next((why for pat, why in DESTRUCTIVE if pat.search(cmd)), "")


def changes_tree(command: str) -> bool:
    """A git command that changes the folder's files (a branch switch, a pull, a stash ...)."""
    return bool(_TREE.search(str(command or "")))


# keel 0.18.18 "always" for a command family, not one exact line: how many words name the command (from opencode (MIT),
# packages/core/src/shell/parse.ts ARITY, trimmed): `git checkout main` → `git checkout *`, `npm run build` →
# `npm run build *`. A command not listed keeps its first word (`ruff check src` → `ruff *`).
ARITY: dict[str, int] = {
    "cat": 1, "cd": 1, "chmod": 1, "chown": 1, "cp": 1, "echo": 1, "grep": 1, "ln": 1, "ls": 1, "mkdir": 1, "mv": 1,
    "rm": 1, "rmdir": 1, "touch": 1, "which": 1,
    "bun": 2, "bun run": 3, "bun x": 3, "cargo": 2, "cargo add": 3, "cargo run": 3, "deno": 2, "deno task": 3,
    "docker": 2, "docker compose": 3, "docker container": 3, "docker image": 3, "gh": 3, "git": 2, "git config": 3,
    "git remote": 3, "git stash": 3, "go": 2, "gradle": 2, "helm": 2, "kubectl": 2, "make": 2, "mvn": 2, "npm": 2,
    "npm exec": 3, "npm init": 3, "npm run": 3, "npx": 2, "pip": 2, "pnpm": 2, "pnpm dlx": 3, "pnpm exec": 3,
    "pnpm run": 3, "poetry": 2, "python": 2, "terraform": 2, "uv": 2, "uv run": 3, "yarn": 2, "yarn dlx": 3,
    "yarn run": 3, "./gradlew": 2, "./mvnw": 2,
}
_COMPOUND = re.compile(r"[;&|<>`$()]|\n")


def always_pattern(command: str) -> str:
    """What "Allow in this chat" keeps for this command: its family (`git checkout *`), or the exact command when it is
    more than one simple command (`a && b`, a pipe, a redirect) or throws work away (that one is asked every time)."""
    cmd = " ".join(str(command or "").split())
    if not cmd or _COMPOUND.search(cmd) or destructive(cmd):
        return cmd
    words = cmd.split(" ")
    for n in range(len(words), 0, -1):
        arity = ARITY.get(" ".join(words[:n]))
        if arity is not None:
            return " ".join(words[:arity]) + " *" if len(words) > arity else cmd
    return words[0] + " *" if len(words) > 1 else cmd


def needs_ask(command: str) -> bool:
    """A command that changes nothing (ls, cat, grep, git status / diff / log ...) runs without a card."""
    return run_mode.readonly_bash(command or "") is not None


def granted(command: str, grants: list[str] | None) -> bool:
    """"Always" was said for this exact command (or for a `prefix *` grant). Never for a command that throws work
    away (`destructive`): that one is asked every time."""
    cmd = (command or "").strip()
    if destructive(cmd):
        return False
    for g in grants or []:
        g = str(g).strip()
        if cmd == g or (g.endswith(" *") and (cmd == g[:-2] or cmd.startswith(g[:-1]))):
            return True
    return False


def ask_engine(ask: dict | None, kind: str, command: str, path: str = "") -> tuple[bool, str]:
    """(allowed, why not). No ask settings: nothing to ask, the rules alone decide. `url` is where to ask, in full."""
    a = ask or {}
    url, key, sid = a.get("url"), a.get("key"), a.get("session")
    if not (url and key and sid):
        return True, ""
    body = json.dumps({"session": sid, "key": key, "kind": kind, "command": str(command)[:4000], "path": path}).encode()
    req = urllib.request.Request(url, data=body,
                                 headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=ASK_TIMEOUT + 30) as r:
            ans = json.loads(r.read() or b"{}")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return False, f"keel could not ask the person about this command ({type(exc).__name__}), so it does not run."
    if ans.get("decision") == "allow":
        return True, ""
    return False, str(ans.get("why") or "The person said no to this command.")
