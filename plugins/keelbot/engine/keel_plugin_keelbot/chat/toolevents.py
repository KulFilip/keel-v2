"""KeelBot's helper.tool events: one record per tool call (a part of helper.py)."""

from __future__ import annotations

import json
import re

from keel_engine.runtime import plugins

THINKING_MAX = 20_000             # 0.18.23 the thinking kept with an answer, for a reload (never sent to the model)

TOOL_KINDS = ("tool", "read", "write", "edit", "guard")   # the steps that are a tool call (helper.tool)
TOOL_OUTPUT_MAX = 20_000          # a helper.tool event's output, at most
TOOL_SUMMARY_MAX = 200
SHELL_TOOLS = ("Bash", "bash", "shell", "run_command", "exec_command")
FILE_TOOL = {"read": "Read", "write": "Write", "edit": "Edit"}
_MORE_LINES = re.compile(r"\n… \((\d+) more lines\)$")
_STAT = re.compile(r"\(([^()]*)\)\s*$")


def _first_line(text: str) -> str:
    line = next((x.strip() for x in str(text or "").splitlines() if x.strip()), "")
    return line if len(line) <= TOOL_SUMMARY_MAX else line[:TOOL_SUMMARY_MAX - 1].rstrip() + "…"


def _line_count(output: str) -> int:
    """How many lines the tool printed: the lines kept, plus the ones a runner cut ("… (N more lines)")."""
    if not output:
        return 0
    m = _MORE_LINES.search(output)
    kept = output[:m.start()] if m else output
    return len(kept.splitlines()) + (int(m.group(1)) if m else 0)


def tool_event(n: int, kind: str, text: str, extra: dict) -> dict:
    """One tool call of a turn as keel TUI shows it: {n (the step's), name, server, args, shell, status
    (ok | error | refused), summary (one line: "220 lines", the error, what changed), lines, output (at most
    TOOL_OUTPUT_MAX characters), path, ms}. From the step the runner emitted (tool, read, write, edit, guard)."""
    name = str(extra.get("tool") or FILE_TOOL.get(kind) or kind)
    path = extra.get("path")
    if kind == "guard":
        args, output = str(extra.get("command") or path or ""), text
    elif kind in FILE_TOOL:
        args = str(path or "")
        output = str(extra.get("diff") or extra.get("output") or (text if kind == "read" else ""))
    else:
        args, output = text, str(extra.get("output") or "")
    try:                                       # MCP and other tools: their arguments as JSON
        parsed = json.loads(args) if args.lstrip().startswith("{") else None
    except ValueError:
        parsed = None
    status = "refused" if kind == "guard" else "error" if extra.get("ok") is False else "ok"
    lines = _line_count(output)
    if status == "refused":
        summary = "refused: " + _first_line(text)
    elif status == "error":
        summary = _first_line(output) or "failed"
    elif kind in ("write", "edit"):
        m = _STAT.search(text)
        summary = m.group(1) if m else f"{lines} lines"
    else:
        summary = "" if not lines else _first_line(output) if lines == 1 else f"{lines} lines"
    if len(output) > TOOL_OUTPUT_MAX:
        output = output[:TOOL_OUTPUT_MAX].rstrip() + f"\n… ({len(output) - TOOL_OUTPUT_MAX} more characters)"
    return {"n": n, "name": name, "args": parsed if isinstance(parsed, dict) else args,
            "shell": name in SHELL_TOOLS, "status": status, "summary": summary, "lines": lines, "output": output,
            **({"server": extra["server"]} if extra.get("server") else {}), **({"path": path} if path else {}),
            **({"ms": extra["ms"]} if isinstance(extra.get("ms"), int) else {})}


def _thinking_data(thought: dict, t0: float) -> dict:
    """The answer's thinking for its stored data: the text (cut at THINKING_MAX) and how long it took (from the turn's
    start to its last thinking); {} for none."""
    text = str(thought.get("text") or "").strip()
    if not text:
        return {}
    cut = text if len(text) <= THINKING_MAX else text[:THINKING_MAX].rstrip() + " …"
    ms = int(((thought.get("last") or t0) - t0) * 1000)
    return {"thinking": cut, "thinking_ms": max(0, ms)}


def commands(root: str | None, enabled: list[str] | None = None) -> list[dict]:
    """The slash commands the panel offers (runtime/plugins.py): keel's, the project's plugins' and the project's own."""
    return [{k: c[k] for k in ("name", "description", "plugin", "source")} for c in plugins.commands(root, enabled)]
