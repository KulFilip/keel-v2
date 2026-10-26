"""Stale configuration (keel 0.18.57): are the commands in .keel/config.yml still runnable?

A project's compose file renames a service, a composer or npm script goes, a Makefile target is dropped: the command in
.keel/config.yml then fails in the middle of a flow, far from its cause. This check reads the files instead of running
anything:

    docker compose exec/run <service>   the service is in the project's compose files (or the -f files the command names)
    composer <script> / run-script      composer.json has the script (composer's own commands are not scripts)
    npm|pnpm|yarn run <script>, npm test / start   package.json (in the command's folder, or --prefix / cd) has it
    make <target>                       the Makefile has the target
    ./scripts/x.sh, bin/console         the file is there (vendor/, node_modules/ and absolute paths are not checked)

    stale(root) -> [{key, command, problem, file, line, missing_in}]
    action(a)   the knowledge-refresh step "config_check" (soft: listed, never failing the flow)

keel2 doctor <project> and the project's doctor (GET /api/projects/{pid}/doctor/config) show the same list.
"""

from __future__ import annotations

import json
import re
import shlex
from pathlib import Path

import yaml

from .. import rules
from . import container

CONFIG = ".keel/config.yml"
COMPOSER_OWN = {"install", "i", "update", "u", "upgrade", "require", "r", "remove", "rm", "dump-autoload", "dumpautoload",
                "validate", "show", "info", "outdated", "audit", "config", "create-project", "global", "exec", "run-script",
                "run", "check-platform-reqs", "diagnose", "self-update", "selfupdate", "status", "why", "depends",
                "why-not", "prohibits", "licenses", "init", "search", "fund", "archive", "browse", "home", "suggests",
                "clear-cache", "clearcache", "list", "help", "bump", "reinstall", "about", "--version", "-V"}
NPM_SCRIPT_CMDS = {"test": "test", "t": "test", "start": "start", "stop": "stop", "restart": "restart"}
SEPARATORS = ("&&", "||", ";", "|")


def _line_of(root: str, key: str) -> int | None:
    """The line of `<key>:` under commands: in .keel/config.yml (1-based), or None."""
    try:
        lines = (Path(root) / CONFIG).read_text().splitlines()
    except OSError:
        return None
    rx = re.compile(rf"^\s+{re.escape(key)}\s*:")
    return next((n for n, line in enumerate(lines, 1) if rx.match(line)), None)


def _segments(cmd: str) -> list[list[str]]:
    """The command's simple commands: `cd web && npm run lint` -> [["cd", "web"], ["npm", "run", "lint"]]."""
    try:
        tokens = shlex.split(cmd)
    except ValueError:
        return []
    out, cur = [], []
    for t in tokens:
        if t in SEPARATORS:
            if cur:
                out.append(cur)
            cur = []
        else:
            cur.append(t)
    if cur:
        out.append(cur)
    return out


def _compose_services(root: str, named: list[str]) -> tuple[set[str], list[str]]:
    services: set[str] = set()
    files = container.compose_files(root, named)
    for f in files:
        try:
            doc = yaml.safe_load(f.read_text()) or {}
        except (OSError, yaml.YAMLError):
            continue
        if isinstance(doc, dict) and isinstance(doc.get("services"), dict):
            services |= set(doc["services"])
    return services, [f.name for f in files]


def _json_scripts(folder: Path, name: str) -> dict | None:
    try:
        doc = json.loads((folder / name).read_text())
    except (OSError, ValueError):
        return None
    scripts = doc.get("scripts") if isinstance(doc, dict) else None
    return scripts if isinstance(scripts, dict) else {}


def _make_targets(folder: Path) -> set[str] | None:
    for name in ("Makefile", "makefile", "GNUmakefile"):
        try:
            text = (folder / name).read_text()
        except OSError:
            continue
        return set(re.findall(r"^([A-Za-z0-9_.\-/]+)\s*:(?!=)", text, re.M))
    return None


def _check_tokens(root: Path, folder: Path, toks: list[str]) -> tuple[str, str] | None:
    """(problem, the file that lacks it) for one simple command, or None."""
    if not toks:
        return None
    prog = Path(toks[0]).name
    if prog == "composer" and len(toks) > 1:
        args = [t for t in toks[1:] if not t.startswith("-")]
        if not args:
            return None
        script = args[1] if args[0] in ("run-script", "run") and len(args) > 1 else None if args[0] in COMPOSER_OWN else args[0]
        if script:
            scripts = _json_scripts(folder, "composer.json")
            if scripts is not None and script not in scripts:
                return f"composer.json has no script {script!r}", str((folder / "composer.json").relative_to(root))
        return None
    if prog in ("npm", "pnpm", "yarn") and len(toks) > 1:
        args = list(toks[1:])
        where = folder
        if "--prefix" in args and args.index("--prefix") + 1 < len(args):
            i = args.index("--prefix")
            where = folder / args[i + 1]
            del args[i:i + 2]
        args = [t for t in args if not t.startswith("-")]
        if not args:
            return None
        if args[0] in ("run", "run-script") and len(args) > 1:
            script = args[1]
        elif args[0] in NPM_SCRIPT_CMDS and prog != "yarn":
            script = NPM_SCRIPT_CMDS[args[0]]
        elif prog == "yarn" and args[0] not in ("install", "add", "remove", "upgrade", "why", "dlx", "exec", "workspace",
                                                "workspaces", "init", "info", "config", "set", "cache", "node", "up"):
            script = args[0]
        else:
            return None
        scripts = _json_scripts(where, "package.json")
        if scripts is not None and script not in scripts:
            return f"package.json has no script {script!r}", str((where / "package.json").relative_to(root))
        return None
    if prog == "make":
        args = [t for t in toks[1:] if not t.startswith("-") and "=" not in t]
        targets = _make_targets(folder)
        if targets is not None:
            for t in args:
                if t not in targets:
                    return f"the Makefile has no target {t!r}", str((folder / "Makefile").relative_to(root))
        return None
    first = toks[0]
    if "/" in first and not first.startswith(("/", "~", "$")) and not re.match(r"^(\./)?(vendor|node_modules)/", first):
        if not (folder / first).exists() and not (root / first).exists():
            return f"{first} does not exist", first
    return None


def stale(root: str) -> list[dict]:
    """[{key, command, problem, file, line, missing_in}] for each configured command that cannot run as written."""
    from ..tools import testcmd

    r = Path(root)
    if not (r / CONFIG).is_file():
        return []
    cmds = rules.load_config(root).get("commands") or {}
    out = []
    for key, cmd in (cmds.items() if isinstance(cmds, dict) else []):
        items = cmd if isinstance(cmd, list) else [cmd]
        for c in items:
            if not isinstance(c, str) or not c.strip():
                continue
            rel = testcmd.dir_for_key(root, key) if key != "preflight" else ""
            folder = r / rel if rel and (r / rel).is_dir() else r
            found: tuple[str, str] | None = None
            ex = container.exec_of(c)
            if ex and ex["compose"]:
                services, files = _compose_services(root, ex["files"])
                if not files:
                    found = (f"it runs in the compose service {ex['service']!r}, but there is no compose file", "compose.yml")
                elif ex["service"] not in services:
                    found = (f"the compose service {ex['service']!r} is not in {', '.join(files)} "
                             f"(services: {', '.join(sorted(services)) or 'none'})", files[0])
                else:
                    found = _check_tokens(r, r, ex["rest"])     # in the container, the project folder is its folder
            else:
                for seg in _segments(c):
                    if seg and seg[0] == "cd" and len(seg) > 1:
                        folder = folder / seg[1]
                        continue
                    found = _check_tokens(r, folder, seg)
                    if found:
                        break
            if found:
                out.append({"key": key, "command": c, "problem": found[0], "missing_in": found[1],
                            "file": CONFIG, "line": _line_of(root, key)})
    return out


def lines(problems: list[dict]) -> list[str]:
    return [f"{CONFIG}:{p['line'] or '?'} commands.{p['key']}: {p['problem']} ({p['command']})" for p in problems]


def action(a):
    """knowledge-refresh's config_check: soft; the stale commands are listed (data.config_check_output) and shown."""
    from .actions import ActionResult

    found = stale(a.root)
    data = {**(a.data or {}), "config_stale": found}
    if not found:
        return ActionResult(True, "the configured commands are runnable as written", "", {"data": data})
    return ActionResult(False, f"{len(found)} configured command(s) look stale", "\n".join(lines(found)), {"data": data})
