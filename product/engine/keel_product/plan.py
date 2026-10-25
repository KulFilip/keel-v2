"""keel Product's plan: epics per team, stories with criteria, and what waits for what.

The story writer ends its answer with a ```json block:

    {"epics": [{"id": "PAY", "team": "payments", "title": "Prices API v2",
                "stories": [{"id": "PAY-S1", "title": "...", "repo": "payments-api", "criteria": ["AC-1 [API] ..."],
                             "depends_on": [], "estimate_days": [2, 3], "tasks": ["..."]}]}]}

check() returns the plan with its problems (unknown ids, loops), the critical path (the longest chain by the upper
estimate) and the totals per team.
"""

from __future__ import annotations

import json
import re

BLOCK = re.compile(r"```[ \t]*json[ \t]*\n(.*?)\n[ \t]*```", re.S | re.I)
# any fenced block (```json, ```JSON, ``` alone, ~~~json): a real model does not always name the language
FENCE = re.compile(r"(?:```|~~~)[ \t]*[\w-]*[ \t]*\n(.*?)\n[ \t]*(?:```|~~~)", re.S)
TRAILING_COMMA = re.compile(r",(\s*[}\]])")
CRITERION = re.compile(r"^AC-\d+\s*\[\w+]\s*\S")


def _loads(raw: str):
    try:
        return json.loads(raw)
    except ValueError:
        try:
            return json.loads(TRAILING_COMMA.sub(r"\1", raw))
        except ValueError:
            return None


def find_json(text: str, key: str) -> dict | None:
    """The last JSON object with a list under `key` in an agent's answer: in a fenced block (any or no language), the
    answer itself, or an object written in the prose without a fence. A bare list of such entries counts as {key: list}."""
    text = text or ""

    def fit(data) -> dict | None:
        if isinstance(data, dict) and isinstance(data.get(key), list):
            return data
        if isinstance(data, list) and data and all(isinstance(x, dict) for x in data):
            return {key: data}
        return None

    for raw in reversed(FENCE.findall(text)):
        found = fit(_loads(raw.strip()))
        if found is not None:
            return found
    found = fit(_loads(text.strip()))
    if found is not None:
        return found
    dec = json.JSONDecoder()
    best, at = None, text.find("{")
    while at >= 0:
        try:
            data, end = dec.raw_decode(text, at)
        except ValueError:
            at = text.find("{", at + 1)
            continue
        if isinstance(data, dict) and fit(data) is not None:
            best = data
        at = text.find("{", end)            # an object read whole: its inner objects are not read again
    return best


def parse(text: str) -> dict | None:
    """The plan in the last ```json block of a text (or the text itself as JSON, or a bare object in its prose); None
    when there is none."""
    found = find_json(text, "epics")
    if found is None:
        return None
    if not all(isinstance(e, dict) and ("stories" in e or "team" in e) for e in found["epics"]):
        return None
    return found


def stories(plan: dict) -> list[dict]:
    return [s for e in plan.get("epics") or [] for s in e.get("stories") or []]


def _days(s: dict) -> tuple[float, float]:
    est = s.get("estimate_days") or [0, 0]
    if isinstance(est, (int, float)):
        est = [est, est]
    lo, hi = (float(est[0]), float(est[-1])) if est else (0.0, 0.0)
    return (min(lo, hi), max(lo, hi))


def check(plan: dict) -> dict:
    problems: list[str] = []
    epics = plan.get("epics") or []
    all_stories = stories(plan)
    ids = [s.get("id") for s in all_stories]
    for e in epics:
        if not e.get("team"):
            problems.append(f"epic {e.get('id') or e.get('title')}: no team")
        e.setdefault("id", re.sub(r"[^A-Z]", "", (e.get("team") or "EP").upper())[:4] or "EP")
    seen = set()
    for s in all_stories:
        sid = s.get("id")
        if not sid:
            problems.append(f"story {s.get('title')!r}: no id")
            continue
        if sid in seen:
            problems.append(f"story {sid}: the id is used twice")
        seen.add(sid)
        if not s.get("criteria"):
            problems.append(f"story {sid}: no acceptance criteria")
        for c in s.get("criteria") or []:
            if not CRITERION.match(str(c)):
                problems.append(f"story {sid}: criterion is not 'AC-<n> [LAYER] text': {str(c)[:60]}")
        for d in s.get("depends_on") or []:
            if d not in ids:
                problems.append(f"story {sid}: waits for {d}, which is not in the plan")
    by_id = {s["id"]: s for s in all_stories if s.get("id")}
    cycle = _cycle(by_id)
    if cycle:
        problems.append("these stories wait for each other in a loop: " + " → ".join(cycle))
    path, length = ([], 0.0) if cycle else _critical_path(by_id)
    team_of = {s["id"]: e.get("team") for e in epics for s in e.get("stories") or [] if s.get("id")}
    totals: dict[str, list[float]] = {}
    for sid, s in by_id.items():
        lo, hi = _days(s)
        t = totals.setdefault(team_of.get(sid) or "?", [0.0, 0.0])
        t[0] += lo
        t[1] += hi
    all_lo = sum(t[0] for t in totals.values())
    all_hi = sum(t[1] for t in totals.values())
    return {"plan": plan, "problems": problems, "ok": not problems, "critical_path": path, "critical_days": length,
            "teams": {k: v for k, v in sorted(totals.items())}, "total_days": [all_lo, all_hi],
            "counts": {"epics": len(epics), "stories": len(by_id),
                       "tasks": sum(len(s.get("tasks") or []) for s in by_id.values())}}


def _cycle(by_id: dict) -> list[str]:
    state: dict[str, int] = {}
    stack: list[str] = []

    def visit(n: str) -> list[str]:
        state[n] = 1
        stack.append(n)
        for d in by_id[n].get("depends_on") or []:
            if d not in by_id:
                continue
            if state.get(d) == 1:
                return stack[stack.index(d):] + [d]
            if not state.get(d):
                found = visit(d)
                if found:
                    return found
        stack.pop()
        state[n] = 2
        return []

    for n in by_id:
        if not state.get(n):
            found = visit(n)
            if found:
                return found
    return []


def _critical_path(by_id: dict) -> tuple[list[str], float]:
    best: dict[str, tuple[float, list[str]]] = {}

    def longest(n: str) -> tuple[float, list[str]]:
        if n in best:
            return best[n]
        own = _days(by_id[n])[1]
        before = [longest(d) for d in by_id[n].get("depends_on") or [] if d in by_id]
        prev = max(before, key=lambda x: x[0], default=(0.0, []))
        best[n] = (prev[0] + own, prev[1] + [n])
        return best[n]

    if not by_id:
        return [], 0.0
    length, path = max((longest(n) for n in by_id), key=lambda x: x[0])
    return path, length


def markdown(result: dict) -> str:
    """The plan as readable Markdown (plan-vN.md next to plan-vN.json)."""
    plan = result["plan"]
    lines = ["# Plan", ""]
    lo, hi = result["total_days"]
    lines.append(f"{result['counts']['epics']} epics · {result['counts']['stories']} stories · {result['counts']['tasks']} tasks · "
                 f"{lo:g}–{hi:g} developer days")
    if result["critical_path"]:
        lines.append(f"Critical path: {' → '.join(result['critical_path'])} ({result['critical_days']:g} days)")
    for e in plan.get("epics") or []:
        lines += ["", f"## {e.get('id')} · {e.get('title') or ''} ({e.get('team')})"]
        for s in e.get("stories") or []:
            lo, hi = _days(s)
            after = f" · after {', '.join(s.get('depends_on'))}" if s.get("depends_on") else ""
            lines.append(f"- **{s.get('id')}** {s.get('title')} · {s.get('repo') or '?'} · {lo:g}–{hi:g} d{after}")
            for c in s.get("criteria") or []:
                lines.append(f"  - {c}")
    if result["problems"]:
        lines += ["", "## Problems", *[f"- {p}" for p in result["problems"]]]
    return "\n".join(lines) + "\n"
