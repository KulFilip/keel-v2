"""keel Product's documents: versioned Markdown in the product repo, one folder per initiative.

    initiatives/INI-12/brief-v1.md, brief-v2.md, impact-v1.md, decision-v1.md, plan-v1.json, plan-v1.md, deck-v1.html

Every save is a new version and a git commit in the product repo, so the history shows who changed what and when.
"""

from __future__ import annotations

import re
import subprocess
import time
from pathlib import Path

DOC_KINDS = ("brief", "impact", "decision", "plan", "deck", "outcome")
ID = re.compile(r"^INI-\d{1,6}$")
BEGIN, END = "BEGIN-DOC", "END-DOC"
LOCK_TRIES, LOCK_WAIT = 6, 0.25
QUESTIONS = re.compile(r"```[ \t]*keel-questions[ \t]*\n.*?\n[ \t]*```", re.S | re.I)
# the doc markers as a model may dress them: **BEGIN-DOC**, `BEGIN-DOC`, BEGIN DOC
BEGIN_RE = re.compile(r"[*_`]*\bBEGIN[- ]DOC\b[*_`]*")
END_RE = re.compile(r"[*_`]*\bEND[- ]DOC\b[*_`]*")
SECTION = re.compile(r"^[ \t]{0,3}#{1,6}[ \t]+\S", re.M)
ASK_LIMIT = 6

try:        # keel's clarify loop reads the questions (0.18.55: also the plain Markdown forms)
    from keel_engine.runtime import clarify as _clarify
except ImportError:     # pragma: no cover - the engine is always there when the add-on runs
    _clarify = None


class DocError(ValueError):
    pass


def folder(root: str, initiative: str) -> Path:
    if not ID.match(initiative or ""):
        raise DocError(f"not an initiative id: {initiative!r}")
    return Path(root) / "initiatives" / initiative


def versions(root: str, initiative: str, kind: str) -> list[int]:
    d = folder(root, initiative)
    found = [int(m.group(1)) for f in d.glob(f"{kind}-v*.*") if (m := re.match(rf"^{kind}-v(\d+)\.", f.name))] if d.is_dir() else []
    return sorted(set(found))


def next_version(root: str, initiative: str, kind: str) -> int:
    have = versions(root, initiative, kind)
    return (have[-1] + 1) if have else 1


def has_doc(text: str) -> bool:
    return bool(BEGIN_RE.search(text or ""))


def extract(text: str) -> str:
    """The document in an agent's answer: between BEGIN-DOC and END-DOC, else the whole answer without its questions
    (a keel-questions block, or the same questions written as Markdown: "# keel-questions" and a numbered list)."""
    text = text or ""
    if has_doc(text):
        body = BEGIN_RE.split(text, 1)[1]
        body = END_RE.split(body, 1)[0]
        return body.strip()
    text = QUESTIONS.sub("", text)
    if _clarify is not None and hasattr(_clarify, "strip_plain_questions"):
        text = _clarify.strip_plain_questions(text)
    return text.strip()


def questions(text: str) -> list[dict]:
    """The questions an answer asks: a keel-questions block, else its plain Markdown form; [] when there are none."""
    if _clarify is None:
        return []
    try:
        return _clarify.parse_questions(text or "", ASK_LIMIT, plain=True)
    except TypeError:       # a keel before 0.18.55: the fenced block only
        return _clarify.parse_questions(text or "", ASK_LIMIT)


def only_questions(text: str) -> bool:
    """An answer that asks instead of writing the document: no BEGIN-DOC, no section of its own once the questions are
    out, and at least one line that is a question."""
    text = text or ""
    if has_doc(text) or not text.strip():
        return False
    if questions(text):
        return not SECTION.search(extract(text))
    return not SECTION.search(text) and any(line.rstrip().endswith("?") for line in text.splitlines())


def write(root: str, initiative: str, kind: str, text: str, ext: str = "md", version: int | None = None,
          message: str | None = None) -> dict:
    """Write one version and commit it. Returns {kind, version, path, sha}."""
    if kind not in DOC_KINDS:
        raise DocError(f"unknown document kind: {kind!r}")
    v = version or next_version(root, initiative, kind)
    d = folder(root, initiative)
    d.mkdir(parents=True, exist_ok=True)
    f = d / f"{kind}-v{v}.{ext}"
    f.write_text(text if text.endswith("\n") else text + "\n")
    rel = str(f.relative_to(root))
    sha = commit(root, [rel], message or f"{initiative}: {kind} v{v}")
    return {"kind": kind, "version": v, "path": rel, "sha": sha}


def commit(root: str, paths: list[str], message: str) -> str | None:
    """git add + commit in the product repo (keel's own identity); None when it is not a git repo."""
    if not (Path(root) / ".git").exists():
        return None

    def git(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", "-c", "user.name=keel", "-c", "user.email=keel@localhost", "-c", "commit.gpgsign=false",
                               *args], cwd=root, capture_output=True, text=True, timeout=30)

    # Two stage flows (or a flow and the api) may commit at the same moment: git's index.lock makes one of them wait.
    for attempt in range(LOCK_TRIES):
        r = git("add", "--", *paths)
        if r.returncode == 0:
            r = git("commit", "-q", "-m", message, "--", *paths)
        if r.returncode == 0:
            out = git("rev-parse", "HEAD").stdout.strip()
            return out or None
        if "index.lock" not in (r.stderr or "") or attempt == LOCK_TRIES - 1:
            return None
        time.sleep(LOCK_WAIT * (attempt + 1))
    return None


RISK_SECTION = re.compile(r"^[ \t]{0,3}#{1,6}[ \t]*Risk\b[^\n]*\n+(?:[ \t]*[-*>][ \t]*)?[*_`]*(low|medium|high)\b", re.I | re.M)
RISK_LINE = re.compile(r"\brisk[*_`]*[ \t]*(?:is|level|:|\u2014|-)?[ \t]*[*_`]*[ \t]*(low|medium|high)\b", re.I)
RECOMMEND_SAID = re.compile(r"\brecommend(?:ation|ed|s)?\b[^.\n]{0,40}?\b(?:option[ \t]+)?([ABC])\b(?=[ \t]*(?:[\u00b7:.,)\-\u2014]|$|\s))", re.I | re.M)


def risk_of(text: str) -> str:
    """The risk an impact report names when its RISK: line is missing: its ## Risk section's first word, else a
    "Risk: high" phrase; "" when it names none."""
    m = RISK_SECTION.search(text or "") or RISK_LINE.search(text or "")
    return m.group(1).lower() if m else ""


def option_letter(value: str, memo: str = "") -> str:
    """The option (A, B or C) a RECOMMEND line names ("B", "Option B", "B · Full", "**A**"); with no line, the one the
    memo says it recommends ("I recommend option A"); else the line as it was."""
    v = (value or "").strip()
    m = re.match(r"^[*_`\s]*(?:option[ \t]+)?([ABC])(?![A-Za-z])", v, re.I)
    if m:
        return m.group(1).upper()
    if not v and memo:
        said = RECOMMEND_SAID.findall(memo)
        if said:
            return said[-1].upper()
    return v

