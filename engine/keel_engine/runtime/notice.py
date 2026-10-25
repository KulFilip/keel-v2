"""Short lines for a notification (the toast and the bell list): at most three, each one fact with a mark.

The gate's full text stays its detail (the Inbox and an opened notification show it). These lines are made from
structured data (counts, names), never by cutting prose: a long line ends at a whole word with "…", and too many lines
become "+N more".

    OK ✓ done or passed · SKIP ⤼ skipped or kept · FAIL ✗ failed · ASK ◆ needs you
"""
from __future__ import annotations

import re

OK, SKIP, FAIL, ASK = "✓", "⤼", "✗", "◆"
MAX_LINES = 3
LINE = 80


def words(text: str, limit: int = LINE) -> str:
    """`text` on one line, at most `limit` characters, cut only after a whole word (with "…")."""
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(t) <= limit:
        return t
    room = t[: limit - 1]
    cut = room.rfind(" ")
    if cut < limit // 3:
        return room.rstrip() + "…"
    kept = room[:cut].rstrip(",;:·-— ")
    while (last := kept.rsplit(" ", 1)[-1]).lower() in _SMALL and len(kept) - len(last) > limit // 3:
        kept = kept[: len(kept) - len(last)].rstrip(",;: ")          # "… because a…" reads badly
    return kept + "…"


_SMALL = {"a", "an", "the", "of", "to", "and", "or", "in", "on", "at", "for", "with", "by", "because", "is", "are"}


def clip(lines: list[str], limit: int = MAX_LINES) -> list[str]:
    """At most `limit` lines: more become limit-1 lines and "+N more". Blank lines go."""
    kept = [words(x) for x in lines if str(x or "").strip()]
    if len(kept) <= limit:
        return kept
    return kept[: limit - 1] + [f"+{len(kept) - (limit - 1)} more"]


def names(items: list[str], limit: int = 3) -> str:
    """"a, b, c" or "a, b, c +2 more"."""
    items = [str(x) for x in items if str(x or "").strip()]
    shown = ", ".join(items[:limit])
    return shown + (f" +{len(items) - limit} more" if len(items) > limit else "")


def plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def hand_over(passed: int, skipped: int, failed: list[str], written: list[str], kept: list[str]) -> list[str]:
    """The init hand-over: the setup checks (the ladder's rungs) and the knowledge sections.

        ✓ 3 setup checks passed · 9 skipped
        ✓ Knowledge: architecture, domain, conventions
    """
    checks = f"{plural(passed, 'setup check')} passed" + (f" · {skipped} skipped" if skipped else "")
    lines = [f"{OK if passed or not failed else FAIL} {checks}"]
    if failed:
        lines.append(f"{FAIL} {plural(len(failed), 'setup check')} still {'fails' if len(failed) == 1 else 'fail'}: {names(failed)}")
    if written:
        lines.append(f"{OK} Knowledge: {names(written)}")
    elif kept:
        lines.append(f"{SKIP} Knowledge kept as it was: {names(kept)}")
    else:
        lines.append(f"{SKIP} Knowledge: no section written")
    return clip(lines)


def gate(*, ac: dict | None = None, acs: list[dict] | None = None, item: dict | None = None,
         no_criteria: bool = False, spec_phase: bool = False) -> list[str]:
    """A gate's short lines from what it is about: one criterion, the spec's criteria, or one item of a loop.
    Empty when there is nothing structured to say (the api then makes lines from the detail)."""
    if no_criteria:
        return [f"{FAIL} No acceptance criteria yet", f"{ASK} Send it back and say what to build"]
    if ac:
        return clip([f"{ASK} {ac.get('id')}: {ac.get('title') or 'check the criterion'}"])
    if item:
        about = item.get("title") or item.get("summary") or ""
        return clip([f"{ASK} {item.get('id')}" + (f": {about}" if about else "")])
    if spec_phase and acs:
        return clip([f"{ASK} {plural(len(acs), 'acceptance criterion', 'acceptance criteria')}"]
                    + [f"{ASK} {a.get('id')}: {a.get('title', '')}" for a in acs])
    return []


def questions(asked: list[dict]) -> list[str]:
    """A clarify gate: its questions, one line each."""
    return clip([f"{ASK} {q.get('question')}" for q in asked if q.get("question")])
