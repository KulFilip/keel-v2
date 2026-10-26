"""Result markers: one-line verdicts an agent ends its answer with, read into the flow state.

    REPRO: confirmed | not-reproducible        (reproducer)
    ROOT-CAUSE: confirmed | unconfirmed        (investigator)
    BLOCKING: yes | no                         (reviewers; findings.py reads the findings themselves)
    E2E-RESULT: pass | fail                    (e2e-author)
    CODE-REVIEW: pass | findings               (branch-reviewer)
    AC-REVIEW: pass | findings                 (criterion-reviewer)
    SECURITY: clean | findings                 (security-auditor)
    DEPS: clean | findings                     (dependency-triager)
    CONFIDENCE: high | medium | low            (web-researcher, 0.18.20)
    WEB: yes | no                              (feature's web_check, 0.18.21: does the spec need outside docs?)
    REFACTOR: done | none                      (feature's optional refactor step: did it tidy anything?)
    VERDICT: promising | possible | no         (spike: each angle's researcher, 0.18.23: counted, never glued)
    CONFLICTS: none | found                    (spike's findings, 0.18.23: the angles' contradictions, listed under it)
    AMEND: <what the frozen spec gets wrong>   (feature: test-author / implementer, only when the spec is wrong)
    BLOCKED: <tooling | needs AC-x>: <what>    (feature: test-author / implementer, only when they cannot go on;
                                                the implementer's `GREEN-RESULT: stalled` counts as BLOCKED too)
    NAME: any value                            any other name a step declares in `markers: [NAME]`

A registered marker with values keeps only its first word, lower case (`REPRO: Confirmed — the test fails` ->
"confirmed"); any other marker keeps the rest of its line. A registered marker without values (AMEND) is free text the
agent writes only when it applies, so a step that reads it does not ask for the line. The last line that names a marker
wins. A step can also collect a JSON
list from its answer (`collect: <key>`): the last ```json (or ```keel-items) block that holds a list.
"""

from __future__ import annotations

import json
import re

REGISTRY: dict[str, tuple[str, ...]] = {
    "REPRO": ("confirmed", "not-reproducible"),
    "ROOT-CAUSE": ("confirmed", "unconfirmed"),
    "BLOCKING": ("yes", "no"),
    "E2E-RESULT": ("pass", "fail"),
    "CODE-REVIEW": ("pass", "findings"),
    "AC-REVIEW": ("pass", "findings"),
    "SECURITY": ("clean", "findings"),
    "DEPS": ("clean", "findings"),
    "CONFIDENCE": ("high", "medium", "low"),
    "WEB": ("yes", "no"),
    "REFACTOR": ("done", "none"),
    "VERDICT": ("promising", "possible", "no"),
    "CONFLICTS": ("none", "found"),
    "INTENT": ("met", "missed"),          # 0.18.57 address: does the change do what the reviewer asked?
    "AMEND": (),
    "BLOCKED": (),
}

_FENCE = re.compile(r"```(?:json|keel-items)\s*\n(.*?)```", re.S)


def _line(name: str) -> re.Pattern:
    return re.compile(rf"^\s*(?:[-*>]\s*)?(?:\*\*|__|`)?\s*{re.escape(name)}\s*(?:\*\*|__|`)?\s*:\s*(?:\*\*|__|`)?\s*(.*?)\s*(?:\*\*|__|`)?\s*$",
                      re.I | re.M)


def parse(text: str, names: list[str] | None = None) -> dict[str, str]:
    """{NAME: value} for each declared (default: registered) marker found in the text."""
    out: dict[str, str] = {}
    for name in [n.upper() for n in (names or REGISTRY)]:
        found = _line(name).findall(text or "")
        if not found:
            continue
        value = found[-1].strip()
        if REGISTRY.get(name):
            word = re.match(r"[\w-]+", value)
            value = word.group(0).lower() if word else ""
        if value:
            out[name] = value
    return out


def blocked(text: str) -> str | None:
    """v0.17.5 BLOCKED, or the implementer's `GREEN-RESULT: stalled` read as BLOCKED (with the answer's last lines)."""
    found = parse(text, ["BLOCKED"]).get("BLOCKED")
    if found:
        return found
    result = parse(text, ["GREEN-RESULT"]).get("GREEN-RESULT", "")
    if result.lower().startswith("stalled"):
        lines = [x for x in (text or "").strip().splitlines() if x.strip() and not _line("GREEN-RESULT").match(x)]
        return ("stalled: " + " ".join(lines[-3:]))[:600]
    return None


# 0.18.28 a `when` may compare a number: `when: {marker: GAPS, gt: 0}` (gt, gte, lt, lte). The value's first number
# counts ("GAPS: 9 (3 high)" is 9); a value without a number does not hold.
COMPARE = ("gt", "gte", "lt", "lte")
WHEN_KEYS = frozenset({"marker", "data", "state", "step", "equals", "in", "absent", "any", *COMPARE})
_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")


def number(value) -> float | None:
    """The first number in a value (9 for "9 (3 high)", 0 for "0"), else None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    m = _NUMBER.search(str(value or ""))
    return float(m.group(0)) if m else None


def matches(value: str | None, when: dict) -> bool:
    """A branch's `when`: equals (one value) or in (a list); case does not matter. gt / gte / lt / lte compare the
    value's first number. None of these: the value is set, and False, 0, "0", "", [] and {} are not (str(False) is
    "false", which used to count as set; a marker's "GAPS: 0" is the text "0", which did too)."""
    if value is None:
        return False
    cmp = [k for k in COMPARE if k in when]
    if cmp:
        n = number(value)
        if n is None:
            return False
        ops = {"gt": n.__gt__, "gte": n.__ge__, "lt": n.__lt__, "lte": n.__le__}
        return all(ops[k](float(number(when[k]) or 0)) for k in cmp)
    if "equals" not in when and "in" not in when:
        if value is False or value in (0, "", [], {}) or value == ():
            return False
        if isinstance(value, str) and re.fullmatch(r"\s*0+(?:\.0+)?\s*", value):
            return False
    v = str(value).strip().lower()
    if "equals" in when:
        return v == str(when["equals"]).strip().lower()
    if "in" in when:
        return v in {str(x).strip().lower() for x in when.get("in") or []}
    return bool(v)


def collect(text: str, key: str) -> list[dict]:
    """The last JSON list in a fenced block of the answer, as items with an id (`<key>-<n>` when missing)."""
    found = None
    for block in _FENCE.findall(text or ""):
        try:
            data = json.loads(block)
        except ValueError:
            continue
        if isinstance(data, dict) and isinstance(data.get(key), list):
            data = data[key]
        if isinstance(data, list):
            found = data
    out = []
    for n, x in enumerate(found or []):
        item = dict(x) if isinstance(x, dict) else {"title": str(x)}
        item["id"] = str(item.get("id") or f"{key}-{n + 1}")
        out.append(item)
    return out
