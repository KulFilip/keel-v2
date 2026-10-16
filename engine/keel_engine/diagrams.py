"""keel's ASCII diagrams: one renderer for every client that draws in text (keel TUI, keel2 mcp's diagram tools).

    render(kind, data, width=100, max_lines=60, zoom=None) -> str

Pure and deterministic: the same input gives the same bytes. Plain ASCII only (every character < 128), every line at
most `width` characters, at most `max_lines` lines; a longer picture ends with one "... N more (zoom with id=...)"
line, and `zoom` draws only that part.

    kind          data                                         picture
    workflow      {workflow}                                   the web's flow map (web/src/components/flowmap.ts,
                                                               buildFlowMap): main path, side paths, if/else arms,
                                                               loops, included flows folded, orphans
    flow          {workflow, thread, visited?}                 the same with each step's state, what waits and the
                                                               criteria strip (visited: step ids or names that ran,
                                                               from GET /threads/{tid}/history)
    map-system    a map level {nodes, edges}                   boxes in rows and the links between them
    map-modules   (same)
    map-er        {schema, focus?}                             tables, columns and foreign keys (a focus table and its
                                                               neighbours; a short list for more than 12 tables)
    graph         a /graph/node focus {focus, nodes, edges}    callers <- focus -> callees (columns -2..2)

Engine route POST /diagrams/ascii and api route POST /api/diagrams/ascii (docs/plans/keel-tui.md).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

KINDS = ("workflow", "flow", "map-system", "map-modules", "map-er", "graph")
MAX_WIDTH = 200
END = "end"


class DiagramError(ValueError):
    """The data cannot be drawn (unknown kind, wrong shape)."""


# ------------------------------------------------------------------ text helpers

_ASCII = {"…": "...", "·": "-", "→": "->", "←": "<-", "↔": "<->", "—": "-", "–": "-",
          "‘": "'", "’": "'", "“": '"', "”": '"', "›": ">", "‹": "<", "✓": "v",
          "✗": "x", "×": "x", "≥": ">=", "≤": "<=", " ": " "}


def ascii_text(s: Any) -> str:
    """Any value as one line of plain ASCII (other characters spelled out, or '?')."""
    text = "" if s is None else str(s)
    text = text.replace("\r", " ").replace("\n", " ").replace("\t", " ")
    out = []
    for ch in text:
        if ord(ch) < 128:
            out.append(ch if ch.isprintable() else " ")
        elif ch in _ASCII:
            out.append(_ASCII[ch])
        else:
            base = unicodedata.normalize("NFKD", ch).encode("ascii", "ignore").decode()
            out.append(base or "?")
    return "".join(out)


def clip(s: str, width: int) -> str:
    s = s.rstrip()
    return s if len(s) <= width else s[: max(0, width - 3)] + "..."


def wrap(text: str, width: int, first: str = "", rest: str | None = None) -> list[str]:
    """Words of `text` in lines of at most `width`, the first starting with `first`, the others with `rest`."""
    rest = " " * len(first) if rest is None else rest
    words = ascii_text(text).split()
    lines: list[str] = []
    cur, fresh = first, True          # fresh: no word on this line yet
    for w in words:
        if len(w) > width - len(rest):
            w = clip(w, width - len(rest))
        if not fresh and len(cur) + 1 + len(w) > width:
            lines.append(cur.rstrip())
            cur = rest + w
        else:
            cur = cur + w if fresh else cur + " " + w
        fresh = False
    if not fresh or not lines:
        lines.append(cur.rstrip())
    return lines


@dataclass
class Out:
    """Lines with the zoom id of the part each belongs to (for the '... N more (zoom with id=...)' line)."""

    width: int
    lines: list[tuple[str, str | None]] = field(default_factory=list)

    def add(self, text: str, zoom: str | None = None) -> None:
        self.lines.append((clip(ascii_text(text), self.width), zoom))

    def text(self, max_lines: int) -> str:
        rows = self.lines
        if len(rows) > max_lines:
            keep = rows[: max(1, max_lines - 1)]
            rest = rows[len(keep):]
            zid = next((z for _, z in rest if z), None) or next((z for _, z in reversed(keep) if z), None)
            more = f"... {len(rest)} more" + (f" (zoom with id={zid})" if zid else "")
            rows = keep + [(clip(more, self.width), None)]
        return "\n".join(t for t, _ in rows) + "\n"


# ------------------------------------------------------------------ the flow map (a port of web flowmap.ts)

PHASES: dict[str, tuple[str, str]] = {
    "none": ("Start", ""),
    "setup": ("Setup", "configure the project, the run ladder and the knowledge base"),
    "preflight": ("Preflight", "check the repo and move to the flow's own branch"),
    "workspace": ("Workspace", "prepare the branch and the working copy"),
    "triage": ("Triage", "size the change and list its criteria"),
    "spec": ("Spec", "write and approve what to build"),
    "contract": ("Contract", "write the API surface the criteria change"),
    "red": ("Red", "write a failing test for the criterion"),
    "green": ("Green", "make that test pass with the least code"),
    "ac": ("Criterion", "tests and code for one criterion"),
    "refactor": ("Refactor", "improve the code, the behaviour stays the same"),
    "gate": ("Review", "a reviewer, then you, check the work"),
    "review-fix": ("Review fix", "fix what a review or a check found"),
    "integration": ("Integration", "wire the real parts together"),
    "e2e": ("End-to-end", "browser tests for the user journeys"),
    "smoke": ("Smoke", "quick checks that also run after a deploy"),
    "lint-fix": ("Lint fix", "fix what the static checks found"),
    "coverage-fix": ("Coverage", "measure coverage and close the gaps"),
    "trivial": ("Trivial change", "a change no test could notice"),
    "small-change": ("Small change", "prepare a small change"),
    "bug-report": ("Bug report", "take in the bug report"),
    "bug-repro": ("Reproduce", "prove the bug with a failing test"),
    "bug-investigate": ("Investigate", "find the root cause from evidence"),
    "gate-r": ("Gate R", "you confirm the bug is reproduced"),
    "gate-f": ("Gate F", "you approve the fix plan"),
    "bug-fix": ("Fix", "fix the bug while the tests stay frozen"),
    "reset": ("Reset", "put back uncommitted work and try again"),
    "security": ("Security", "audit the branch and its dependencies"),
    "ship": ("Ship", "checks, reviews and the pull request"),
    "final-review": ("Final review", "you read every verdict before the PR"),
    "memory": ("Knowledge", "update what keel knows about the project"),
    "close": ("Close", "decision records and the closing note"),
    "hunt-scope": ("Hunt scope", "choose what to look at"),
    "hunt-sweep": ("Hunt sweep", "hunters propose candidate bugs"),
    "hunt-prove": ("Prove", "try to reproduce each candidate"),
    "hunt-report": ("Hunt report", "write the report"),
    "hunt-triage": ("Hunt triage", "decide what to fix first"),
    "review": ("Review", "a read-only review"),
    "verify": ("Verify", "run the checks"),
}
INCLUDES = {"ship": "checks, reviews and the pull request", "cover": "measure coverage and close the gaps"}


def phase_title(p: str) -> str:
    return PHASES.get(p, (p, ""))[0]


def _pretty(key: str) -> str:
    return re.sub(r"[_.-]+", " ", re.sub(r"^data\.", "", key)).strip()


def singular(key: str) -> str:
    p = _pretty(key)
    if p.endswith("ies"):
        return p[:-3] + "y"
    if p.endswith("s") and not p.endswith("ss"):
        return p[:-1]
    return p


def _js(v: Any) -> str:
    """A value as JavaScript's String() writes it (the web's words)."""
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def when_text(w: Any, name) -> str | None:
    if not isinstance(w, dict) or not w:
        return None
    src = w.get("step")
    who = " or ".join(name(str(x)) for x in src) if isinstance(src, list) else name(src) if isinstance(src, str) else ""
    eq = _js(w["equals"]) if w.get("equals") is not None else None
    among = ", ".join(_js(x) for x in w["in"]) if isinstance(w.get("in"), list) else None
    if isinstance(w.get("marker"), str):
        if w["marker"] == "CHOICE":
            return (f"you chose {eq}" + (f" at {who}" if who else "")) if eq else ("you chose" + (f" at {who}" if who else ""))
        said = (f"{who}{' (any of them)' if w.get('any') else ''} says " if who else "") + w["marker"]
        return f"{said} = {eq}" if eq else f"{said} is {among}" if among else said
    path = w["data"] if isinstance(w.get("data"), str) else w["state"] if isinstance(w.get("state"), str) else None
    if not path:
        return None
    if path == "acs" and eq is None and not among:
        return "there are criteria"
    p = _pretty(path)
    return f"{p} = {eq}" if eq is not None else f"{p} is {among}" if among else f"{p} is set"


@dataclass
class Exit:
    kind: str
    label: str
    to: str | None
    to_name: str
    back: bool


def exits_of(steps: list[dict], i: int, by_id: dict[str, int]) -> list[Exit]:
    s = steps[i]
    out: list[Exit] = []

    def add(kind: str, label: str, to: Any) -> None:
        if to is _MISSING:
            return
        if to is None:
            out.append(Exit(kind, label, None, "", False))
            return
        if to == END:
            out.append(Exit(kind, label, END, "end of the flow", False))
            return
        j = by_id.get(to)
        out.append(Exit(kind, label, to, to if j is None else steps[j].get("name", to), j is not None and j <= i))

    nxt = steps[i + 1]["id"] if i + 1 < len(steps) else END
    kind = s.get("kind")
    choices = s.get("choices")
    if kind == "gate":
        if isinstance(choices, dict):
            for k, v in choices.items():
                add("choice", k, v)
        elif isinstance(choices, list) and choices:
            out.append(Exit("list", "per item" if s.get("per_item") or s.get("per_ac") else "choices", None,
                            " / ".join(str(c) for c in choices), False))
        if s.get("back"):
            add("back", "send back", s["back"])
    elif kind == "branch":
        add("yes", "yes", nxt)
        add("no", "no", s.get("no") or nxt)
    else:
        if s.get("back"):
            add("fails" if kind == "code" else "back", "fails" if kind == "code" else "blocking findings", s["back"])
        if s.get("after_rounds"):
            r = s.get("rounds")
            add("rounds", f"after {r} round{'s' if r > 1 else ''}" if r else "after the rounds", s["after_rounds"])
        if s.get("redo"):
            add("redo", "after a fix", s["redo"])
        if s.get("action") == "start_flow" and s.get("flow"):
            out.append(Exit("flow", "starts", None, f"the {s['flow']} flow", False))
        if s.get("then") and s.get("then") != "continue":
            add("then", "then", s["then"])
    return out


_MISSING = object()


def _routes(steps: list[dict], i: int, by_id: dict[str, int]) -> list[int]:
    s = steps[i]
    n = len(steps)
    nxt = i + 1 if i + 1 < n else n

    def at(x: Any) -> int:
        if x == END:
            return n
        return by_id[x] if isinstance(x, str) and x in by_id else -1

    choices = s.get("choices")
    if s.get("kind") == "gate":
        if isinstance(choices, dict):
            exits = list(choices.items())
            first = next((e for e in exits if e[0] == "approve"), exits[0] if exits else None)
            rest = [at(e[1]) for e in exits if e is not first]
            return [at(first[1]) if first else -1, *([nxt] if s.get("when") else []), *rest]
        return [nxt]
    if s.get("kind") == "branch":
        return [nxt, at(s["no"]) if s.get("no") else nxt]
    if s.get("then") == END:
        return [n]
    if s.get("then") and s.get("then") != "continue":
        return [at(s["then"])]
    return [nxt]


@dataclass
class Row:
    step: dict
    index: int
    exits: list[Exit]
    side: list["Row"]


@dataclass
class Loop:
    id: str
    kind: str
    key: str
    title: str


@dataclass
class Arm:
    t: str                       # nodes | jump | go
    nodes: list[dict] = field(default_factory=list)
    side: bool = False
    key: str = ""
    exit: Exit | None = None


def _inc_path(s: dict) -> list[str]:
    return [x for x in str(s.get("included_from") or "").split("/") if x]


@dataclass
class FlowMap:
    sections: list[dict]
    orphans: list[Row]
    by_id: dict[str, int]
    main: list[str]
    parent_of: dict[str, str]
    phase_of: list[str]

    def ids_of(self, nd: dict) -> list[str]:
        return ids_of(nd)


def ids_of(nd: dict) -> list[str]:
    if nd["t"] == "step":
        return [nd["row"].step["id"], *[r.step["id"] for r in nd["row"].side]]
    if nd["t"] == "if":
        def arm(a: Arm) -> list[str]:
            return [x for n in a.nodes for x in ids_of(n)] if a.t == "nodes" else []
        return [nd["row"].step["id"], *[r.step["id"] for r in nd["row"].side], *arm(nd["yes"]), *arm(nd["no"])]
    return list(nd["ids"])


def build_flow_map(steps: list[dict]) -> FlowMap:
    """buildFlowMap of web/src/components/flowmap.ts, step by step (the shared fixtures keep the two the same)."""
    n = len(steps)
    by_id = {s["id"]: i for i, s in enumerate(steps)}
    exits = [exits_of(steps, i, by_id) for i in range(n)]

    phase_of: list[str] = []
    for i, s in enumerate(steps):
        phase_of.append(s.get("phase") or (phase_of[i - 1] if i else "none"))

    loop_of: list[Loop | None] = []
    each: Loop | None = None
    for s in steps:
        if s.get("for_each"):
            each = Loop(s["id"], "each", s["for_each"], f"For each {singular(s['for_each'])}")
        elif not s.get("per_item"):
            each = None
        loop_of.append(Loop("ac", "ac", "acs", "For each criterion") if s.get("per_ac") else each if s.get("per_item") else None)

    NEG = float("-inf")
    best = [NEG] * (n + 1)
    pick = [-1] * n
    best[n] = 0
    for i in range(n - 1, -1, -1):
        for j in _routes(steps, i, by_id):
            if j <= i or j > n:
                continue
            if best[j] + 1 > best[i]:
                best[i] = best[j] + 1
                pick[i] = j
    main_idx: list[int] = []
    if n and best[0] > NEG:
        i = 0
        while i < n:
            main_idx.append(i)
            i = pick[i]
    elif n:
        seen: set[int] = set()
        i = 0
        while 0 <= i < n and i not in seen:
            seen.add(i)
            main_idx.append(i)
            r = _routes(steps, i, by_id)
            i = r[0] if r else -1
        main_idx.sort()
    on_main = set(main_idx)

    owner: dict[int, int] = {}

    def targets(i: int) -> list[int]:
        out = [j for j in _routes(steps, i, by_id) if 0 <= j < n]
        for e in exits[i]:
            j = by_id.get(e.to) if e.to else None
            if j is not None:
                out.append(j)
        return out

    for m in main_idx:
        queue = [j for j in targets(m) if j not in on_main and j not in owner]
        for j in queue:
            owner[j] = m
        while queue:
            k = queue.pop(0)
            for j in targets(k):
                if j in on_main or j in owner:
                    continue
                owner[j] = m
                queue.append(j)
    side_of: dict[int, list[int]] = {}
    for j, m in sorted(owner.items()):
        side_of.setdefault(m, []).append(j)

    def plain(i: int) -> Row:
        return Row(steps[i], i, exits[i], [])

    def reach(m: int, entry: int) -> list[int]:
        got = {entry}
        queue = [entry]
        while queue:
            k = queue.pop(0)
            for j in targets(k):
                if owner.get(j) == m and j not in got:
                    got.add(j)
                    queue.append(j)
        return sorted(got)

    def here(j: int, depth: int) -> bool:
        return len(_inc_path(steps[j])) <= depth

    def name_of(x: str) -> str:
        j = by_id.get(x)
        return steps[j].get("name", x) if j is not None else x

    def if_node(i: int, idx: list[int], k: int, depth: int):
        s = steps[i]
        yes_j = i + 1
        no_j = by_id.get(s["no"]) if s.get("no") else None
        used: set[int] = set()
        yes = Arm("go")
        no = Arm("go")
        nxt = k + 1

        def side_arm(entry: int, arm: str) -> Arm:
            got = [j for j in reach(i, entry) if j not in used]
            used.update(got)
            return Arm("nodes", [{"t": "step", "key": f"step:{steps[j]['id']}", "row": plain(j)} for j in got], True,
                       f"arm:{s['id']}:{arm}")

        if yes_j < n and owner.get(yes_j) == i:
            yes = side_arm(yes_j, "yes")
        elif no_j is not None and no_j > i and no_j in on_main:
            try:
                p = idx.index(no_j, k + 1)
            except ValueError:
                p = -1
            rng = idx[k + 1:p] if p > k + 1 else []
            own = loop_of[i].id if loop_of[i] else None

            def cuts(j: int) -> bool:
                lp = loop_of[j].id if loop_of[j] else None
                return bool(lp) and lp != own and any((loop_of[x].id if loop_of[x] else None) == lp and x not in rng for x in idx)

            if rng and not any(cuts(j) for j in rng) and all(len(_inc_path(steps[j])) >= depth for j in rng):
                yes = Arm("nodes", seq(rng, depth, own), False, f"arm:{s['id']}:yes")
                nxt = p
        if no_j is not None and owner.get(no_j) == i and no_j not in used:
            no = side_arm(no_j, "no")
        elif yes.t == "nodes" and not yes.side:
            no = Arm("go")
        else:
            e = next((x for x in exits[i] if x.kind == "no"), None)
            if e and e.to and not (no_j is not None and k + 1 < len(idx) and no_j == idx[k + 1]):
                no = Arm("jump", exit=e)
        if yes.t != "nodes" and no.t != "nodes":
            return None
        rest = [j for j in side_of.get(i, []) if j not in used]
        row = Row(s, i, [e for e in exits[i] if e.kind not in ("yes", "no")], [plain(j) for j in rest])
        return {"t": "if", "key": f"if:{s['id']}", "row": row, "cond": when_text(s.get("when"), name_of), "yes": yes, "no": no}, nxt

    def seq(idx: list[int], depth: int, loop_id: str | None) -> list[dict]:
        out: list[dict] = []
        k = 0
        while k < len(idx):
            i = idx[k]
            segs = _inc_path(steps[i])
            if len(segs) > depth:
                path = segs[: depth + 1]

                def same(j: int, path=path) -> bool:
                    return _inc_path(steps[j])[: depth + 1] == path

                e = k
                while e < len(idx) and same(idx[e]):
                    e += 1
                inner = idx[k:e]
                every = [j for j in range(n) if same(j)]
                out.append({"t": "include", "key": "inc:" + "/".join(path), "flow": segs[depth], "path": "/".join(path),
                            "count": len(every), "body": sections(inner, depth + 1), "ids": [steps[j]["id"] for j in every]})
                k = e
                continue
            lp = loop_of[i]
            if lp and lp.id != loop_id:
                e = k
                while e < len(idx) and here(idx[e], depth) and loop_of[idx[e]] and loop_of[idx[e]].id == lp.id:
                    e += 1
                body = seq(idx[k:e], depth, lp.id)
                out.append({"t": "loop", "key": f"loop:{lp.id}:{steps[i]['id']}", "loop": lp, "body": body,
                            "ids": [x for b in body for x in ids_of(b)]})
                k = e
                continue
            if steps[i].get("kind") == "branch":
                r = if_node(i, idx, k, depth)
                if r:
                    out.append(r[0])
                    k = r[1]
                    continue
            row = plain(i)
            row.side = [plain(j) for j in side_of.get(i, [])]
            out.append({"t": "step", "key": f"step:{steps[i]['id']}", "row": row})
            k += 1
        return out

    def sections(idx: list[int], depth: int) -> list[dict]:
        out: list[dict] = []
        for node in seq(idx, depth, None):
            if node["t"] in ("loop", "include"):
                out.append({"key": f"sec:{node['key']}", "kind": node["t"],
                            "phase": node["flow"] if node["t"] == "include" else node["loop"].id, "nodes": [node], "ids": ids_of(node)})
                continue
            phase = phase_of[node["row"].index]
            last = out[-1] if out else None
            if last and last["kind"] == "phase" and last["phase"] == phase:
                last["nodes"].append(node)
                last["ids"].extend(ids_of(node))
            else:
                out.append({"key": f"sec:{node['key']}", "kind": "phase", "phase": phase, "nodes": [node], "ids": ids_of(node)})
        return out

    secs = sections(main_idx, 0)
    placed = {x for sec in secs for x in sec["ids"]}
    orphans = [plain(i) for i in range(n) if steps[i]["id"] not in placed]
    parent_of = {steps[j]["id"]: steps[m]["id"] for j, m in owner.items()}
    return FlowMap(secs, orphans, by_id, [steps[i]["id"] for i in main_idx], parent_of, phase_of)


def summary(fm: FlowMap) -> dict:
    """What the shared fixtures compare between this port and the web's buildFlowMap."""
    def node(nd: dict) -> Any:
        if nd["t"] == "step":
            return {"step": nd["row"].step["id"], "side": [r.step["id"] for r in nd["row"].side]}
        if nd["t"] == "if":
            def arm(a: Arm) -> Any:
                return {"nodes": [node(x) for x in a.nodes], "side": a.side} if a.t == "nodes" else \
                    {"jump": a.exit.to} if a.t == "jump" else "go"
            return {"if": nd["row"].step["id"], "cond": nd["cond"], "side": [r.step["id"] for r in nd["row"].side],
                    "yes": arm(nd["yes"]), "no": arm(nd["no"])}
        if nd["t"] == "loop":
            return {"loop": nd["loop"].id, "body": [node(x) for x in nd["body"]]}
        return {"include": nd["path"], "count": nd["count"], "body": [sec(x) for x in nd["body"]]}

    def sec(s: dict) -> dict:
        return {"kind": s["kind"], "phase": s["phase"], "nodes": [node(x) for x in s["nodes"]]}

    return {"main": fm.main, "sections": [sec(s) for s in fm.sections], "orphans": [r.step["id"] for r in fm.orphans],
            "parent_of": dict(sorted(fm.parent_of.items()))}


def step_states(steps: list[dict], fm: FlowMap, current: str | None, status: str | None) -> dict[str, str]:
    out = {s["id"]: "todo" for s in steps}
    if status == "done":
        for i in fm.main:
            out[i] = "done"
        return out
    cur = re.sub(r"__fix$", "", current) if current else None
    ci = fm.by_id.get(cur) if cur else None
    if not cur or ci is None:
        return out
    anchor = fm.parent_of.get(cur, cur)
    pos = fm.main.index(anchor) if anchor in fm.main else -1
    for k, sid in enumerate(fm.main):
        if k < pos or (k == pos and anchor != cur):
            out[sid] = "done"
    if anchor != cur:
        for j, s in enumerate(steps):
            if j < ci and fm.parent_of.get(s["id"]) == anchor:
                out[s["id"]] = "done"
    s = steps[ci]
    out[cur] = ("fail" if status == "failed" else "stop" if status == "stopped"
                else "wait" if s.get("kind") == "gate" or status == "waiting" else "run")
    return out


def arms_taken(fm: FlowMap, states: dict[str, str], visited: set[str] | None) -> tuple[dict[str, str], set[str]]:
    taken: dict[str, str] = {}
    skipped: set[str] = set()

    def live(i: str) -> bool:
        return states.get(i) in ("run", "wait", "fail", "stop")

    def walk(nodes: list[dict]) -> None:
        for nd in nodes:
            if nd["t"] == "loop":
                walk(nd["body"])
                continue
            if nd["t"] == "include":
                for x in nd["body"]:
                    walk(x["nodes"])
                continue
            if nd["t"] != "if":
                continue

            def arm(a: Arm) -> list[str]:
                return [x for m in a.nodes for x in ids_of(m)] if a.t == "nodes" else []

            yes, no = arm(nd["yes"]), arm(nd["no"])
            sid = nd["row"].step["id"]
            if any(live(x) for x in yes):
                taken[sid] = "yes"
            elif any(live(x) for x in no):
                taken[sid] = "no"
            elif states.get(sid) == "done" and visited:
                if any(x in visited for x in yes):
                    taken[sid] = "yes"
                elif any(x in visited for x in no):
                    taken[sid] = "no"
                elif nd["yes"].t == "nodes" and not nd["yes"].side:
                    taken[sid] = "no"
            if taken.get(sid) == "no" and nd["yes"].t == "nodes" and not nd["yes"].side:
                skipped.update(x for x in yes if states.get(x) == "done")
            if nd["yes"].t == "nodes":
                walk(nd["yes"].nodes)
            if nd["no"].t == "nodes":
                walk(nd["no"].nodes)

    for sec in fm.sections:
        walk(sec["nodes"])
    return taken, skipped


# ------------------------------------------------------------------ workflow and flow pictures

STATE_MARK = {"done": "[x]", "run": "[>]", "wait": "[?]", "fail": "[!]", "stop": "[#]", "skip": "[-]", "todo": "[ ]"}
KIND_MARK = {"agent": " o ", "code": " # ", "gate": "[?]", "branch": " < ", "parallel": " = ", "include": "[+]"}
LEGEND_FLOW = "[x] done  [>] running  [?] waiting for you  [!] failed  [#] stopped  [-] skipped  [ ] to do"
LEGEND_WORKFLOW = " o  agent   #  code   [?] gate (you decide)   <  branch   =  parallel   [+] included flow"


def _steps_of(workflow: Any) -> list[dict]:
    if not isinstance(workflow, dict):
        raise DiagramError("data.workflow must be a workflow (an object with steps)")
    steps = workflow.get("steps") or []
    if not isinstance(steps, list) or not all(isinstance(s, dict) and s.get("id") for s in steps):
        raise DiagramError("data.workflow.steps must be a list of steps, each with an id")
    return [{**s, "name": s.get("name") or s["id"]} for s in steps]


def _kind_text(s: dict) -> str:
    k = s.get("kind", "agent")
    if k == "agent":
        return f"agent {s['agent']}" if s.get("agent") else "agent"
    if k == "code":
        return f"code {s['action']}" if s.get("action") else "code"
    if k == "gate":
        return "gate, you decide"
    if k == "parallel":
        lanes = s.get("lanes") or []
        if lanes:
            return "parallel: " + ", ".join(str(l.get("name")) for l in lanes if isinstance(l, dict))
        return f"parallel x{s['parallel']}" if s.get("parallel") else "parallel"
    return str(k)


class _Painter:
    def __init__(self, steps: list[dict], fm: FlowMap, out: Out, states: dict[str, str] | None, taken: dict[str, str],
                 acs: int, zoom: str | None):
        self.steps, self.fm, self.out, self.states, self.taken, self.acs, self.zoom = steps, fm, out, states, taken, acs, zoom

    def mark(self, s: dict) -> str:
        if self.states is not None:
            return STATE_MARK[self.states.get(s["id"], "todo")]
        return KIND_MARK.get(s.get("kind", "agent"), " o ")

    def row(self, r: Row, prefix: str, zid: str | None) -> None:
        s = r.step
        tail = ""
        if self.states is not None:
            st = self.states.get(s["id"])
            tail = {"wait": "   <-- waiting for you", "run": "   <-- now", "fail": "   <-- failed here",
                    "stop": "   <-- stopped here"}.get(st or "", "")
        self.out.add(f"{prefix}{self.mark(s)} {s['name']}  ({_kind_text(s)}){tail}", zid)
        for e in r.exits:
            if e.kind == "list":
                self.out.add(f"{prefix}      {e.label}: {e.to_name}", zid)
            elif e.kind == "flow":
                self.out.add(f"{prefix}      starts {e.to_name}", zid)
            else:
                self.out.add(f"{prefix}      {e.label} -> {e.to_name}" + ("  (loops back)" if e.back else ""), zid)
        for sr in r.side:
            self.row(sr, prefix + "    \\ ", zid)

    def nodes(self, nodes: list[dict], prefix: str, zid: str | None) -> None:
        for nd in nodes:
            t = nd["t"]
            if t == "step":
                self.row(nd["row"], prefix, zid)
            elif t == "if":
                s = nd["row"].step
                took = self.taken.get(s["id"])
                self.out.add(f"{prefix}{self.mark(s)} {s['name']}  (branch) if {nd['cond'] or 'yes'}?", zid)
                for word, arm in (("yes", nd["yes"]), ("no", nd["no"])):
                    flag = "  (taken)" if took == word else ""
                    if arm.t == "nodes":
                        self.out.add(f"{prefix}    {word}:{' side path' if arm.side else ''}{flag}", zid)
                        self.nodes(arm.nodes, prefix + "    |  ", zid)
                    elif arm.t == "jump":
                        self.out.add(f"{prefix}    {word}: -> {arm.exit.to_name}{flag}", zid)
                    else:
                        self.out.add(f"{prefix}    {word}: go on{flag}", zid)
                for sr in nd["row"].side:
                    self.row(sr, prefix + "    \\ ", zid)
            elif t == "loop":
                lp = nd["loop"]
                times = f"{max(self.acs, 1)} criteria" if lp.kind == "ac" and self.acs else "each item" if lp.kind == "each" else "each criterion"
                lid = lp.id
                self.out.add(f"{prefix}loop: {lp.title} ({times})  id={lid}", lid)
                self.nodes(nd["body"], prefix + "  : ", lid)
                self.out.add(f"{prefix}  `-- end of loop", lid)
            else:
                path = nd["path"]
                meaning = INCLUDES.get(nd["flow"], f"the steps of the {nd['flow']} workflow")
                open_ = self.zoom is not None and (self.zoom == path or self.zoom.startswith(path + "/") or self.zoom in nd["ids"])
                if not open_:
                    done = sum(1 for i in nd["ids"] if self.states and self.states.get(i) == "done")
                    now = next((i for i in nd["ids"] if self.states and self.states.get(i) in ("run", "wait", "fail", "stop")), None)
                    extra = f", {done} done" if done else ""
                    extra += f", now at {self.steps[self.fm.by_id[now]]['name']}" if now else ""
                    self.out.add(f"{prefix}[+] include {nd['flow']}: {meaning} ({nd['count']} steps{extra})  id={path}", path)
                    continue
                self.out.add(f"{prefix}[-] include {nd['flow']}: {meaning} ({nd['count']} steps)  id={path}", path)
                for sec in nd["body"]:
                    self.section(sec, prefix + "  | ", path)

    def section(self, sec: dict, prefix: str = "", parent: str | None = None) -> None:
        zid = parent or sec["phase"]
        if sec["kind"] == "phase":
            title, meaning = PHASES.get(sec["phase"], (sec["phase"], ""))
            self.out.add(f"{prefix}== {title}" + (f": {meaning}" if meaning else "") + f" ==  id={sec['phase']}", zid)
        self.nodes(sec["nodes"], prefix + ("  " if sec["kind"] == "phase" else ""), zid)


def _visited(steps: list[dict], visited: Any) -> set[str]:
    out: set[str] = set()
    by_name = {s.get("name"): s["id"] for s in steps}
    ids = {s["id"] for s in steps}
    for v in visited or []:
        if isinstance(v, dict):
            v = v.get("step")
        if not isinstance(v, str):
            continue
        v = re.sub(r"__fix$", "", v)
        if v in ids:
            out.add(v)
        elif v in by_name:
            out.add(by_name[v])
    return out


def _pick_sections(fm: FlowMap, zoom: str | None) -> list[dict]:
    if not zoom:
        return fm.sections
    picked = [s for s in fm.sections if s["phase"] == zoom or zoom in s["ids"]
              or any(n["t"] == "include" and (n["path"] == zoom or zoom.startswith(n["path"] + "/")) for n in s["nodes"])]
    if not picked:
        raise DiagramError(f'nothing called "{zoom}" in this workflow: zoom with a phase, a loop, an include or a step id')
    return picked


def _flow_head(out: Out, thread: dict, wf: dict) -> None:
    w = out.width
    title = thread.get("title") or ""
    st = thread.get("status") or "?"
    where = f" at {thread['current']}" if thread.get("current") else ""
    for line in wrap(f'flow {wf.get("id") or thread.get("workflow_id") or "?"} "{title}" - {st}{where} - phase '
                     f'{thread.get("phase") or "none"}', w):
        out.add(line, None)
    acs = thread.get("acs") or []
    if acs:
        done = sum(1 for a in acs if a.get("status") in ("done", "already-met"))
        cur = thread.get("ac")

        def m(a: dict) -> str:
            stt = a.get("status")
            if stt in ("done", "already-met"):
                return "[x]"
            if a.get("id") == cur:
                return "[>]"
            return {"red": "[r]", "green": "[g]"}.get(stt or "", "[ ]")

        strip = " ".join(f"{m(a)}{a.get('id')}" for a in acs)
        for line in wrap(strip, w, f"criteria {done}/{len(acs)}: ", " " * 10):
            out.add(line, None)
    wt = thread.get("waiting")
    if wt:
        for line in wrap(f'{wt.get("kind") or "gate"} "{wt.get("title") or ""}" at {wt.get("step") or "?"}', w, "waiting  "):
            out.add(line, None)
        for line in _answer_lines(wt):
            for l2 in wrap(line, w, "answer   "):
                out.add(l2, None)
    u = thread.get("usage") or {}
    tokens = int(u.get("tokens_in") or 0) + int(u.get("tokens_out") or 0)
    cap = f" of {int(u['cap_tokens']):,}" if u.get("cap_tokens") else ""
    out.add(f"usage    {tokens:,} tokens{cap} - ${float(u.get('cost_usd') or 0):.2f}", None)
    if thread.get("error"):
        for line in wrap(str(thread["error"]), w, "error    "):
            out.add(line, None)
    out.add("", None)


def _answer_lines(wt: dict) -> list[str]:
    """How a person answers what waits, in words every client can map to its own buttons or commands."""
    kind = wt.get("kind") or "gate"
    labels = wt.get("labels") or {}
    opts = wt.get("options") or ["approve", "reject"]
    if kind == "clarify":
        out = [f"answer the {len(wt.get('questions') or [])} question(s), then approve with the answers"]
        for q in wt.get("questions") or []:
            choices = " / ".join(str(o.get("label")) + (" (recommended)" if o.get("recommended") else "") for o in q.get("options") or [])
            out.append(f"{q.get('id')}: {q.get('question')} [{choices}]")
        return out
    if wt.get("choices"):
        return ["choose one: " + " | ".join(str(c) for c in wt["choices"])]
    parts = []
    if "approve" in opts:
        parts.append("approve" + (f' ("{labels["approve"]}")' if labels.get("approve") else ""))
    if "reject" in opts:
        parts.append("reject with a reason" + (f' ("{labels["reject"]}")' if labels.get("reject") else ""))
    return [" or ".join(parts) or "-"]


def _flowmap_text(data: dict, width: int, max_lines: int, zoom: str | None, with_state: bool) -> str:
    wf = data.get("workflow")
    steps = _steps_of(wf)
    fm = build_flow_map(steps)
    out = Out(width)
    states: dict[str, str] | None = None
    taken: dict[str, str] = {}
    acs = 0
    if with_state:
        thread = data.get("thread")
        if not isinstance(thread, dict):
            raise DiagramError("data.thread must be the flow's state (GET /api/projects/{pid}/flow: thread)")
        acs = len(thread.get("acs") or [])
        states = step_states(steps, fm, thread.get("current"), thread.get("status"))
        taken, skipped = arms_taken(fm, states, _visited(steps, data.get("visited")))
        for i in skipped:
            states[i] = "skip"
        _flow_head(out, thread, wf)
    else:
        gates = sum(1 for s in steps if s.get("kind") == "gate")
        for line in wrap(f'workflow {wf.get("id") or "?"} "{wf.get("name") or wf.get("id") or ""}" - {len(steps)} steps, '
                         f'{gates} gates', width):
            out.add(line, None)
        out.add("", None)
    painter = _Painter(steps, fm, out, states, taken, acs, zoom)
    for sec in _pick_sections(fm, zoom):
        painter.section(sec)
    if fm.orphans and not zoom:
        out.add("== Not reached: no route leads here ==", "orphans")
        for r in fm.orphans:
            painter.row(r, "  ", "orphans")
    out.add("", None)
    out.add(LEGEND_FLOW if with_state else LEGEND_WORKFLOW, None)
    return out.text(max_lines)


# ------------------------------------------------------------------ boxes (map levels, ER)

def _box(title: str, rows: list[str], inner: int) -> list[str]:
    """A box `inner` characters wide inside: +- title -+, | row |, +----+."""
    t = clip(ascii_text(title), inner - 1)
    top = "+- " + t + " " + "-" * max(0, inner - len(t) - 2) + "+"
    body = ["| " + clip(ascii_text(r), inner - 1).ljust(inner) + "|" for r in rows]
    return [top, *body, "+" + "-" * (inner + 1) + "+"]


def _side_by_side(boxes: list[list[str]], width: int, gap: int = 2) -> list[str]:
    """Boxes in rows, as many as fit in `width`."""
    out: list[str] = []
    row: list[list[str]] = []
    used = 0
    for b in boxes:
        w = len(b[0])
        if row and used + gap + w > width:
            out += _join(row, gap)
            row, used = [], 0
        used += (gap if row else 0) + w
        row.append(b)
    if row:
        out += _join(row, gap)
    return out


def _join(row: list[list[str]], gap: int) -> list[str]:
    h = max(len(b) for b in row)
    lines = []
    for k in range(h):
        lines.append((" " * gap).join((b[k] if k < len(b) else " " * len(b[0])) for b in row).rstrip())
    return lines


def _map_level(data: dict, width: int, max_lines: int, zoom: str | None, kind: str) -> str:
    level = data.get("level") if isinstance(data.get("level"), dict) else data
    nodes = level.get("nodes")
    edges = level.get("edges") or []
    if not isinstance(nodes, list):
        raise DiagramError(f"data must be a map level ({kind}): {{nodes, edges}}")
    out = Out(width)
    title = "system" if kind == "map-system" else "modules"
    by_id = {str(n.get("id")): n for n in nodes if isinstance(n, dict)}
    if zoom:
        if zoom not in by_id:
            raise DiagramError(f'no node "{zoom}" on the {title} map')
        near = {zoom} | {str(e.get("to")) for e in edges if str(e.get("from")) == zoom} | \
               {str(e.get("from")) for e in edges if str(e.get("to")) == zoom}
        nodes = [n for n in nodes if str(n.get("id")) in near]
        edges = [e for e in edges if str(e.get("from")) == zoom or str(e.get("to")) == zoom]
    out.add(f"map {title}: {len(nodes)} parts, {len(edges)} links" + (f" (around {zoom})" if zoom else ""), None)
    out.add("", None)
    # rows by the map's own layout: top to bottom, then left to right
    ordered = sorted((n for n in nodes if isinstance(n, dict)), key=lambda n: (float(n.get("y") or 0), float(n.get("x") or 0), str(n.get("id"))))
    rows: list[list[dict]] = []
    for nd in ordered:
        if rows and abs(float(nd.get("y") or 0) - float(rows[-1][0].get("y") or 0)) < 1:
            rows[-1].append(nd)
        else:
            rows.append([nd])
    inner = max(14, min(30, (width - 4) // 3 - 3))
    for r in rows:
        boxes = []
        for nd in r:
            lines = []
            if nd.get("sub"):
                lines.append(str(nd["sub"]))
            for x in (nd.get("rows") or [])[:6]:
                lines.append(str(x.get("t") if isinstance(x, dict) else x))
            more = len(nd.get("rows") or []) - 6
            if more > 0:
                lines.append(f"... {more} more")
            lines.append(f"id={nd.get('id')}")
            boxes.append(_box(str(nd.get("title") or nd.get("id")), lines, inner))
        for line in _side_by_side(boxes, width):
            out.add(line, str(r[0].get("id")))
    if edges:
        out.add("", None)
        out.add("links:", None)
        names = {k: str(v.get("title") or k) for k, v in by_id.items()}
        for e in sorted(edges, key=lambda e: (str(e.get("from")), str(e.get("to")), str(e.get("label") or ""))):
            lab = f" ({e['label']})" if e.get("label") else f" ({e['kind']})" if e.get("kind") else ""
            out.add(f"  {names.get(str(e.get('from')), e.get('from'))} --> {names.get(str(e.get('to')), e.get('to'))}{lab}",
                    str(e.get("from")))
    return out.text(max_lines)


def _er(data: dict, width: int, max_lines: int, zoom: str | None) -> str:
    schema = data.get("schema") if isinstance(data.get("schema"), dict) else data
    tables = schema.get("tables")
    if not isinstance(tables, list):
        raise DiagramError("data.schema must be a database schema: {tables, relations}")
    rels = [r for r in schema.get("relations") or [] if isinstance(r, dict)]
    focus = zoom or data.get("focus")
    by_key: dict[str, dict] = {}
    for t in tables:
        by_key[str(t.get("id") or t.get("name"))] = t
    names = {k: str(t.get("name") or k) for k, t in by_key.items()}
    out = Out(width)
    if focus:
        key = next((k for k, t in by_key.items() if focus in (k, t.get("name"))), None)
        if key is None:
            raise DiagramError(f'no table "{focus}" in this schema')
        near = {key} | {str(r.get("to")) for r in rels if str(r.get("from")) == key} | {str(r.get("from")) for r in rels if str(r.get("to")) == key}
        show = [k for k in sorted(by_key, key=lambda k: (k != key, names[k])) if k in near]
        rels = [r for r in rels if key in (str(r.get("from")), str(r.get("to")))]
        out.add(f"database: {names[key]} and its {len(show) - 1} neighbour table(s)", None)
    else:
        show = sorted(by_key, key=lambda k: names[k])
        out.add(f"database: {len(show)} tables, {len(rels)} relations", None)
    out.add("", None)
    if not focus and len(show) > 12:
        for k in show:
            t = by_key[k]
            refs = sorted({names.get(str(r.get("to")), str(r.get("to"))) for r in rels if str(r.get("from")) == k})
            line = f"  {names[k]} ({len(t.get('columns') or [])} columns)" + (f" -> {', '.join(refs)}" if refs else "")
            out.add(line, names[k])
        out.add("", None)
        out.add("zoom with id=<table> to see one table, its columns and its neighbours", None)
        return out.text(max_lines)
    boxes = []
    for k in show:
        t = by_key[k]
        rows = []
        for c in t.get("columns") or []:
            tag = "PK" if c.get("pk") else "FK" if c.get("fk") else "  "
            extra = []
            if c.get("fk"):
                fk = c["fk"]
                extra.append(f"-> {fk.get('table')}" + (f".{fk['column']}" if fk.get("column") else ""))
            if c.get("unique") and not c.get("pk"):
                extra.append("UQ")
            if c.get("nullable") is False and not c.get("pk"):
                extra.append("not null")
            rows.append(f"{tag} {c.get('name')} {c.get('type') or ''}" + (" " + " ".join(extra) if extra else ""))
        if not rows:
            rows.append("(no columns)")
        kind = t.get("kind")
        boxes.append(_box(names[k] + ("" if kind in (None, "table") else f" ({kind})"), rows, max(22, min(46, (width - 2) // 2 - 3))))
    for line in _side_by_side(boxes, width):
        out.add(line, None)
    if rels:
        out.add("", None)
        out.add("relations:", None)
        for r in sorted(rels, key=lambda r: (str(r.get("from")), str(r.get("to")), ",".join(r.get("from_columns") or []))):
            fc = ",".join(r.get("from_columns") or [])
            tc = ",".join(r.get("to_columns") or [])
            card = "1:1" if r.get("one_to_one") else "n:1"
            od = f", on delete {r['on_delete']}" if r.get("on_delete") else ""
            kind = "" if r.get("kind") in (None, "fk") else f" [{r['kind']}]"
            out.add(f"  {names.get(str(r.get('from')), r.get('from'))}.{fc} --> {names.get(str(r.get('to')), r.get('to'))}"
                    f"{'.' + tc if tc else ''} ({card}{od}){kind}", names.get(str(r.get("from"))))
    return out.text(max_lines)


# ------------------------------------------------------------------ the code graph focus

def _graph(data: dict, width: int, max_lines: int) -> str:
    focus = data.get("focus")
    if not isinstance(focus, dict):
        if data.get("missing"):
            raise DiagramError(f"the code graph has no {data['missing']}")
        raise DiagramError("data must be a code graph focus (GET /api/projects/{pid}/graph/node): {focus, nodes, edges}")
    nodes = [n for n in data.get("nodes") or [] if isinstance(n, dict)]
    edges = [e for e in data.get("edges") or [] if isinstance(e, dict)]
    more = data.get("more") or {}
    out = Out(width)
    where = f"{focus.get('file')}:{focus.get('line')}" if focus.get("file") else ""
    out.add(f"{focus.get('kind') or 'symbol'} {focus.get('qualified') or focus.get('name')}  {where}".rstrip(), None)
    if focus.get("signature"):
        for line in wrap(str(focus["signature"]), width, "  "):
            out.add(line, None)
    if data.get("impact") is not None:
        out.add(f"  impact: {data['impact']}{'+' if data.get('impact_capped') else ''} places depend on it", None)
    out.add("", None)
    cols: dict[int, list[dict]] = {c: [] for c in (-2, -1, 1, 2)}
    for nd in nodes:
        c = int(nd.get("col") or 0)
        if c in cols:
            cols[c].append(nd)
    for c in cols:
        cols[c].sort(key=lambda n: (str(n.get("name")), str(n.get("id"))))
        cols[c] = cols[c][:24]
    label = {-2: "used two steps away by", -1: "used by (callers)", 1: "uses (callees)", 2: "and through them"}
    fname = str(focus.get("name") or focus.get("id"))
    # the middle: callers -> [focus] -> callees, side by side when both fit
    left = [f"{n.get('name')} ({n.get('kind')})" for n in cols[-1]]
    right = [f"{n.get('name')} ({n.get('kind')})" for n in cols[1]]
    half = max(10, (width - len(fname) - 14) // 2)
    centre = f"[ {fname} ]"
    h = max(len(left), len(right), 1)
    for k in range(h):
        a = clip(left[k], half) if k < len(left) else ""
        b = clip(right[k], half) if k < len(right) else ""
        mid = centre if k == 0 else " " * len(centre)
        la = " --> " if a else "     "
        rb = " --> " if b else ""
        out.add(f"{a.rjust(half)}{la}{mid}{rb}{b}", None)
    if more.get("-1") or more.get("1"):
        out.add(f"{('... ' + str(more['-1']) + ' more callers') if more.get('-1') else ''}"
                f"{'   ' if more.get('-1') and more.get('1') else ''}"
                f"{('... ' + str(more['1']) + ' more callees') if more.get('1') else ''}", None)
    for c in (-2, 2):
        if cols[c]:
            out.add("", None)
            out.add(label[c] + ":", None)
            for n in cols[c]:
                out.add(f"  {n.get('name')} ({n.get('kind')})  {n.get('file')}:{n.get('line')}", str(n.get("id")))
    if edges:
        out.add("", None)
        out.add("where:", None)
        for e in sorted(edges, key=lambda e: (str(e.get("from")), str(e.get("to"))))[:40]:
            k = ", ".join(f"{a} {b}" for a, b in sorted((e.get("k") or {}).items()))
            site = (e.get("sites") or [{}])[0]
            at = f"  {site.get('file')}:{site.get('line')}" if site.get("file") else ""
            out.add(f"  {_short(e.get('from'))} -> {_short(e.get('to'))} ({k or e.get('n')}){at}", str(e.get("from")))
    return out.text(max_lines)


def _short(sid: Any) -> str:
    s = str(sid)
    return s.split(":", 1)[1] if ":" in s else s


# ------------------------------------------------------------------ entry point

def render(kind: str, data: Any, width: int = 100, max_lines: int = 60, zoom: str | None = None) -> str:
    """The picture of `data` as `kind` (KINDS), in plain ASCII, at most `width` wide and `max_lines` long."""
    if kind not in KINDS:
        raise DiagramError(f'no diagram kind "{kind}". keel draws: {", ".join(KINDS)}')
    if not isinstance(data, dict):
        raise DiagramError("data must be an object")
    width = max(40, min(int(width or 100), MAX_WIDTH))
    max_lines = max(5, int(max_lines or 60))
    zoom = (zoom or data.get("zoom") or None)
    zoom = str(zoom) if zoom else None
    if kind == "workflow":
        if "workflow" not in data and "steps" in data:
            data = {"workflow": data}
        return _flowmap_text(data, width, max_lines, zoom, False)
    if kind == "flow":
        return _flowmap_text(data, width, max_lines, zoom, True)
    if kind in ("map-system", "map-modules"):
        return _map_level(data, width, max_lines, zoom, kind)
    if kind == "map-er":
        return _er(data, width, max_lines, zoom)
    return _graph(data, width, max_lines)
