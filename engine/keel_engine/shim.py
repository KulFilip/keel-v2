"""keel's command wrappers: `python -I -m keel_engine.shim <name> [args...]`.

codex (without hooks) and copilot have no pre-action hook keel can load, so their runs get a folder of small
wrappers first on the PATH (runtime/guard_ctx.py write_shims): git, gh, the package managers and the file printers.
Each wrapper asks keel's hook (`decide`, as for a Bash call) about `<name> <args>` and then runs the real program.

    allowed   exec the real program (the next one on the PATH after the wrappers' folder)
    refused   "[keel guard] <reason>" on stderr, exit 126

A wrapper is not a sandbox: an agent can still call /usr/bin/git. The after-step diff guard stays the backstop.
Inside a program a wrapper already let through (git calling `less`), KEEL_SHIM_ACTIVE skips the check.
Stdlib + keel_engine.hook only: this runs for every wrapped command.
"""

from __future__ import annotations

import os
import shlex
import sys

from .hook import MARKER, NoContext, decide, fail_closed, load_context
from .runtime.guard_ctx import ENV

DIR_ENV = "KEEL_SHIM_DIR"
ACTIVE_ENV = "KEEL_SHIM_ACTIVE"
NAMES = ["git", "gh", "npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "poetry", "cargo", "go", "gem",
         "cat", "head", "tail", "less", "more"]
REFUSED = 126


def real_program(name: str, shim_dir: str | None) -> str | None:
    skip = os.path.realpath(shim_dir) if shim_dir else None
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if not d or (skip and os.path.realpath(d) == skip):
            continue
        p = os.path.join(d, name)
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def judge(command: str, ctx_path: str | None) -> str | None:
    """None to run it, else why not (the same decision as a Bash call in the agent's guard context)."""
    try:
        ctx = load_context(ctx_path)
    except NoContext as exc:
        return fail_closed("Bash", {"command": command}, str(exc))
    ctx.pop("ask", None)      # the agent's whole command was asked about already (KeelBot's Fix mode)
    try:
        return decide("Bash", {"command": command}, ctx)
    except Exception as exc:  # noqa: BLE001  a broken guard refuses
        return f"the guard failed ({type(exc).__name__}: {exc})"


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        sys.stderr.write(f"{MARKER} usage: python -m keel_engine.shim <program> [args...]\n")
        return 2
    name, args = argv[0], argv[1:]
    shim_dir = os.environ.get(DIR_ENV)
    real = real_program(name, shim_dir)
    if not os.environ.get(ACTIVE_ENV):
        reason = judge(shlex.join([name, *args]), os.environ.get(ENV))
        if reason:
            sys.stderr.write(f"{MARKER} {reason}\n")
            return REFUSED
    if not real:
        sys.stderr.write(f"{name}: command not found\n")
        return 127
    os.environ[ACTIVE_ENV] = "1"
    os.execv(real, [name, *args])
    return 0  # not reached


if __name__ == "__main__":
    sys.exit(main())
