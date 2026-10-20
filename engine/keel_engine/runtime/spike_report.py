"""The spike's report (0.18.23): a short summary first, then the findings, then each angle's clean report.

A real spike report put the decision after 300 lines, pasted each angle's raw answer with its tool-call log
("● cd src; cat -n …", "│ …", "└ 220 lines…", "/ Search (grep)", "I'll start with …"), never said that two angles
contradicted each other (the column "exists on tracking_subscriptions, no migration" against "add it on trackings, a new
migration"), and glued the four VERDICT lines into one. Now:

    clean(text)          an answer without tool-call log lines and "I'll …" / "Now the …" narration
    angle_text(text)     an angle's ANGLE REPORT block when it wrote one (the rest is its working), else clean(text)
    facts(text)          its "- <topic>: <value> — <evidence>" lines under "Facts:", {topic: (value, line)}
    fact_conflicts(rs)   a topic two angles give different values for, with each side's line
    section(text, NAME)  a summary section the findings step writes (DECISION:, BEFORE BUILDING:, CONFLICTS: ...)
    verdict_line(rs, r)  "VERDICT: 3 of 4 angles promising (1 possible); recommendation: <RECOMMEND>", one computed line
    spike_report(a)      the action: summary (at most about 12 lines), findings, angles; the raw answers stay in the
                         flow's state (data.<step>_results) and each agent's own log, never in the report
"""

from __future__ import annotations

import re

# a tool call and its output as an agent CLI prints them, and the narration between them
_LOG = re.compile(r"^\s*(?:[●│└├┌┐┘╭╮╰╯⎿⏺]|/ (?:Search|Read|Glob|Grep|Bash|List)\b)")
_NARRATION = re.compile(r"^\s*(?:I'll|I will|I'm going to|Let me|Now (?:the|let me|I'll|I will|I)\b)", re.I)
_ANGLE = re.compile(r"^\s*(?:#+\s*)?(?:\*\*)?ANGLE REPORT(?:\*\*)?\s*:?\s*$", re.M)
_VERDICT_LINE = re.compile(r"^\s*(?:\*\*|__|`)?\s*VERDICT\s*(?:\*\*|__|`)?\s*:", re.I)
_FACT = re.compile(r"^\s*[-*]\s+(?:\*\*)?([^:*\n]{2,80}?)(?:\*\*)?\s*:\s*(.+?)\s*$")
SECTIONS = ("DECISION", "BEFORE BUILDING", "CONFLICTS", "COST", "NEXT")
VERDICTS = ("promising", "possible", "no")
SUMMARY_ITEMS = 3          # at most this many open questions (and conflicts) in the summary; the findings hold the rest


def clean(text: str) -> str:
    """The answer without the agent's tool-call log and its "I'll …" narration; blank runs squeezed."""
    out: list[str] = []
    fence = False
    for line in (text or "").splitlines():
        if line.lstrip().startswith("```"):
            fence = not fence
        if not fence and (_LOG.match(line) or (_NARRATION.match(line) and len(line) < 240)):
            continue
        out.append(line.rstrip())
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def angle_text(text: str) -> str:
    """An angle's report: from its last ANGLE REPORT line to the end (its working before that is left out), else the
    whole answer, cleaned."""
    found = list(_ANGLE.finditer(text or ""))
    body = (text or "")[found[-1].end():] if found else (text or "")
    return clean(body)


def facts(text: str) -> dict[str, tuple[str, str]]:
    """The "Facts:" list of an angle report: {topic in lower case: (value, the whole line)}. The value stops at its
    evidence (" — ", " (" or ", see")."""
    out: dict[str, tuple[str, str]] = {}
    inside = False
    for line in (text or "").splitlines():
        head = re.match(r"^\s*(?:#+\s*)?(?:\*\*)?([A-Za-z][A-Za-z ]+?)(?:\*\*)?\s*:\s*$", line)
        if head:
            inside = head[1].strip().lower() == "facts"
            continue
        if not inside:
            continue
        if not line.strip():
            continue
        m = _FACT.match(line)
        if not m:
            inside = bool(re.match(r"^\s+", line))      # an indented line goes on; anything else ends the list
            continue
        value = re.split(r"\s+[—–-]\s+|\s+\(|,\s+see\b", m[2], maxsplit=1)[0].strip().strip("`*").rstrip(".")
        out[m[1].strip().lower()] = (value, line.strip().lstrip("-* ").strip())
    return out


def _norm(v: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", v.lower()).strip()


def fact_conflicts(results: list[dict]) -> list[str]:
    """Every topic two angles give different values for: "<topic>: <angle A> says <line>; <angle B> says <line>"."""
    seen: dict[str, list[tuple[str, str, str]]] = {}
    for r in results:
        title = str(r.get("title") or r.get("item") or "an angle")
        for topic, (value, line) in facts(angle_text(str(r.get("text") or ""))).items():
            seen.setdefault(topic, []).append((title, value, line))
    out = []
    for topic, said in seen.items():
        if len({_norm(v) for _, v, _ in said}) > 1:
            out.append(f"{topic}: " + "; ".join(f"\"{t}\" says {line}" for t, _, line in said))
    return out


def section(text: str, name: str) -> list[str]:
    """A summary section of the findings: the `NAME: value` line's value (when it has one) and the list under it, up
    to the next section, heading or blank line after the list."""
    lines = (text or "").splitlines()
    pat = re.compile(rf"^\s*(?:#+\s*)?(?:\*\*)?{re.escape(name)}(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*?)\s*$", re.I)
    other = re.compile(r"^\s*(?:#+\s|(?:\*\*)?(?:" + "|".join(re.escape(s) for s in SECTIONS)
                       + r"|RECOMMEND|VERDICT)(?:\*\*)?\s*:)", re.I)
    for i, line in enumerate(lines):
        m = pat.match(line)
        if not m:
            continue
        items: list[str] = []
        for nxt in lines[i + 1:]:
            if other.match(nxt):
                break
            if not nxt.strip():
                if items or m[1]:
                    break
                continue
            items.append(nxt.strip())
        return ([m[1]] if m[1] else []) + items
    return []


def verdict_line(results: list[dict], recommend: str) -> str:
    """One VERDICT line: how many angles said what, and the findings' one recommendation; never the angles' lines glued."""
    said = [str((r.get("markers") or {}).get("VERDICT") or "").split(" ")[0].lower() for r in results]
    n = len(said)
    counts = {v: said.count(v) for v in VERDICTS if said.count(v)}
    missing = n - sum(counts.values())
    if not n:
        tally = "no angle was researched"
    else:
        top = max(counts, key=lambda v: (counts[v], -VERDICTS.index(v))) if counts else None
        rest = [f"{c} {v}" for v, c in counts.items() if v != top] + ([f"{missing} without a verdict"] if missing else [])
        tally = (f"{counts[top]} of {n} angle{'s' if n != 1 else ''} {top}" if top else f"0 of {n} angles with a verdict") \
            + (f" ({', '.join(rest)})" if rest else "")
    rec = (recommend or "").strip()
    return f"VERDICT: {tally}" + (f"; recommendation: {rec}" if rec else "")


def _summary(findings: str, results: list[dict], recommend: str) -> list[str]:
    def one(name: str, fallback: str) -> str:
        got = section(findings, name)
        return " ".join(got[:2]) if got else fallback

    out = ["## Summary", "", f"- **DECISION:** {one('DECISION', recommend or 'the findings do not say')}"]
    before = [re.sub(r"^\s*(?:\d+[.)]|[-*])\s*", "", x) for x in section(findings, "BEFORE BUILDING")]
    before = [x for x in before if x and x.lower() not in ("none", "-")]
    if before:
        out += ["- **BEFORE BUILDING:**"] + [f"  {n}. {x}" for n, x in enumerate(before[:SUMMARY_ITEMS], start=1)]
    else:
        out.append("- **BEFORE BUILDING:** nothing blocks")
    said = [re.sub(r"^\s*[-*]\s*", "", x) for x in section(findings, "CONFLICTS")]
    said = [x for x in said if x and x.lower() not in ("none", "found", "-")]
    auto = [c for c in fact_conflicts(results) if not any(c.split(":")[0].lower() in s.lower() for s in said)]
    conflicts = said + [f"{c} (keel found it in the angles' facts; the findings do not settle it)" for c in auto]
    if conflicts:
        out += ["- **CONFLICTS:**"] + [f"  - {c}" for c in conflicts[:SUMMARY_ITEMS]]
        if len(conflicts) > SUMMARY_ITEMS:
            out.append(f"  - … {len(conflicts) - SUMMARY_ITEMS} more in the findings")
    else:
        out.append("- **CONFLICTS:** none: the angles agree")
    out.append(f"- **COST:** {one('COST', 'the findings do not say')}")
    nxt = one("NEXT", "")
    word = re.match(r"\W*(spec|drop)\b", nxt, re.I)
    out.append(f"- **NEXT:** {word[1].lower() if word else nxt or 'spec or drop: the findings do not say'}")
    out += ["", verdict_line(results, recommend)]
    return out


def report_text(title: str, findings: str, results: list[dict], recommend: str, lint: str = "") -> str:
    said = "\n".join(x for x in clean(findings).splitlines() if not _VERDICT_LINE.match(x))
    out = [f"# Spike: {title}", "", *_summary(findings, results, recommend), "", "## Findings", "",
           said.strip() or "(the findings step wrote nothing)", ""]
    if lint:
        out += ["## Static checks", "", lint.strip(), ""]
    if results:
        out += ["## Angles", "",
                "Each angle's report, without its working; its whole answer, tool calls and all, is in that agent's "
                "log (keel TUI /agent, the dashboard's Flow page).", ""]
        for r in results:
            v = str((r.get("markers") or {}).get("VERDICT") or "no verdict")
            # its verdict is on its title line: the report has one VERDICT line, the counted one in the summary
            body = "\n".join(x for x in angle_text(str(r.get("text") or "")).splitlines() if not _VERDICT_LINE.match(x))
            # folded: the dashboard shows the title line with its verdict, a click opens it; keel TUI shows the line
            out += ["<details><summary>" + f"{r.get('title') or r.get('item')} · VERDICT {v}" + "</summary>", "",
                    body.strip() or "(no answer)", "", "</details>", ""]
    return "\n".join(out).strip()


def spike_report(a):
    """The spike's report action: the summary first, then the findings, then each angle's clean report."""
    from .flow_actions import _ok

    data = a.data
    keys = [k for k, v in data.items() if k.endswith("_results") and isinstance(v, list)]
    results = [r for k in keys for r in data[k]]
    prev = a.state.get("current")
    findings = str(data.get(f"{prev}_text") or "").strip() if prev else ""
    findings = findings or str(a.state.get("last_answer") or "").strip()
    recommend = str(((a.state.get("markers") or {}).get(prev) or {}).get("RECOMMEND") or "") if prev else ""
    if not recommend:
        m = re.findall(r"^\s*(?:\*\*)?RECOMMEND(?:\*\*)?\s*:\s*(.+?)\s*$", findings, re.M | re.I)
        recommend = m[-1] if m else ""
    text = report_text(a.title or "the question", findings, results, recommend, str(data.get("lint_report") or ""))
    line = verdict_line(results, recommend)
    return _ok(line, update={"show": text, "data": {**data, "report": text}})
