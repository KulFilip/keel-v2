"""The security phase's verdicts (keel v1 phase 5.5): what the audit and the dependency triage found, for the push gate.

    after_review(key, root, results)        after the security step: verdict `security` (clean / findings) from the
                                            auditor's answer; the triager's "not reachable" lines clear the failed
                                            `deps` verdict, each with its reason (data.deps_triage)
    accepted(key, root, decided)            the person decided every blocking finding at the findings gate (none to
                                            fix): verdict `security` ok, with what was accepted and why
    worst_severity(text) / blocks(sev, fail_on)   the deps audit's threshold (security.deps.fail_on, default high)

blockers.py reads these verdicts: with a verdict, the push gate says what it found instead of "not run".
"""
from __future__ import annotations

import re

from . import findings, markers
from .verdict_actions import record_verdict
from . import verdicts

SEVERITIES = ("info", "low", "moderate", "high", "critical")       # "medium" is read as moderate
FAIL_ON = "high"
_UNREACHABLE = re.compile(r"reachable\s*:\s*no\b|\bnot\s+reachable\b|\bunreachable\b|\bdev[- ]only\b|\bnot\s+blocking\b", re.I)
_REACHABLE = re.compile(r"reachable\s*:\s*yes\b|(?<!not )\bblocking\.?\s*$", re.I)


def _sev(word: str) -> str | None:
    w = word.lower()
    return "moderate" if w == "medium" else w if w in SEVERITIES else None


def worst_severity(text: str) -> str | None:
    """The most severe level an audit's output reports (npm audit text or json, OSV/Gradle reports), None when it
    names none. "0 critical" counts as none of that level."""
    found: set[str] = set()
    t = text or ""
    for m in re.finditer(r'"severity"\s*:\s*"(\w+)"', t, re.I):
        found.add(_sev(m.group(1)) or "")
    for m in re.finditer(r"\bseverity\s*[:=]\s*(\w+)", t, re.I):
        found.add(_sev(m.group(1)) or "")
    for m in re.finditer(r"\b(\d+)\s+(critical|high|moderate|medium|low)\b", t, re.I):
        if int(m.group(1)) > 0:
            found.add(_sev(m.group(2)) or "")
    for m in re.finditer(r"\b(CRITICAL|HIGH|MODERATE|MEDIUM|LOW)\b", t):
        found.add(_sev(m.group(1)) or "")
    found.discard("")
    return max(found, key=SEVERITIES.index) if found else None


def fail_on(cfg: dict) -> str:
    """security.deps.fail_on in .keel/config.yml (critical, high, moderate/medium, low, info), default high."""
    raw = str((((cfg.get("security") or {}).get("deps") or {}).get("fail_on")) or FAIL_ON)
    return _sev(raw) or FAIL_ON


def blocks(severity: str | None, threshold: str) -> bool:
    """A failed audit blocks when its worst level is at or above the threshold, or when no level can be read from it
    (keel cannot tell, so it stays strict)."""
    return severity is None or SEVERITIES.index(severity) >= SEVERITIES.index(threshold)


def _triage(text: str) -> tuple[list[dict], bool]:
    """The triager's lines that clear an advisory (unreachable, dev-only, not blocking) with the line as the reason,
    and whether anything it reports still blocks."""
    cleared = []
    for line in (text or "").splitlines():
        s = line.strip().lstrip(">-*• ").strip()
        if not s or markers.parse(s, ["DEPS"]):
            continue
        if _UNREACHABLE.search(s) and not _REACHABLE.search(s):
            name = re.split(r"\s+[—–-]\s+|:\s", s, maxsplit=1)[0].strip("`* ")
            cleared.append({"advisory": name[:120], "reason": s[:400]})
    verdict = (markers.parse(text or "", ["DEPS"]) or {}).get("DEPS")
    still = verdict == "findings" or (verdict != "clean" and bool(findings.blocking(text or "")))
    return cleared, still


def after_review(key: str, root: str, results: list[tuple[dict, str]]) -> tuple[dict, str]:
    """(data updates, a note) after the security step. results = [(its item, the agent's answer)]; an item of the
    auditor writes verdict `security`, one of the triager may clear the failed `deps` verdict."""
    data: dict = {}
    notes = []
    for item, text in results:
        agent = (item or {}).get("agent") or "security-auditor"
        if agent == "security-auditor":
            found = findings.blocking(text)
            record_verdict(key, "security", not found, {
                "summary": "security audit: clean" if not found else f"security audit: {len(found)} blocking finding(s)",
                "findings": found[:20]}, root=root)
            notes.append("security verdict: " + ("clean" if not found else f"{len(found)} finding(s)"))
        elif agent == "dependency-triager":
            cleared, still = _triage(text)
            data["deps_triage"] = {"cleared": cleared, "blocking": still}
            before = verdicts.latest(key, "deps")
            if before and not before.get("ok") and not still:
                detail = dict(before.get("detail") or {})
                detail.pop("tree", None)
                record_verdict(key, "deps", True, {**detail, "summary": "audit findings not reachable (dependency triage)",
                                                   "cleared": cleared}, root=root)
                notes.append(f"deps: {len(cleared) or 'all'} advisory(ies) cleared by the triage")
    return data, "; ".join(notes)


def accepted(key: str, root: str, decided: list[dict]) -> None:
    """Every blocking finding of the audit was accepted or called not a finding: the review is done, with reasons."""
    record_verdict(key, "security", True, {
        "summary": f"security audit: {len(decided)} finding(s) accepted by the person",
        "accepted": [{"finding": d.get("text"), "decision": d.get("decision"), "why": d.get("reason")} for d in decided]},
        root=root)
