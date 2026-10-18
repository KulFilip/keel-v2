"""The knowledge check (keel v1 lib/memory.js `check`, ported): is docs/knowledge/ still checkable evidence?

Nothing here can tell whether a claim is true. It refuses the claims that cannot even be checked:
  - a `path:line` citation (backticked, with a line number) whose file is gone or shorter than the line. A shorthand
    path (`.../owner/OwnerRepository.java:36`) or a bare file name (`MySqlIntegrationTests.java:50`) counts when exactly
    one tracked file ends with it (its line is checked in that file); more than one match is a problem,
  - a template placeholder ({{LIKE_THIS}}) nobody filled in,
  - a section with no citation at all (written from memory),
  - a chosen section that does not exist,
  - a line naming one of `memory.proof_required_terms` with neither a citation into a test nor an `unverified:` marker.

Which sections count: the ones chosen at init (.keel/config.yml init.knowledge_sections), plus every section that
exists (it is read back as project authority either way). Never chosen and nothing on disk is its own state.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from .. import layout, rules
from ..tools import git

SECTIONS = ["architecture", "domain", "conventions", "data", "integrations", "journeys"]

# A citation is a backticked path with a line number; prose that merely names a file is not evidence.
CITATION = re.compile(r"`([A-Za-z0-9_@./-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?`")
PLACEHOLDER = re.compile(r"\{\{[A-Z_]+\}\}")
PROOF = [re.compile(p) for p in (r"(^|/)(test|tests)/", r"(^|/)src/(test|integrationTest)/", r"Tests?\.(kt|java)$",
                                 r"\.(test|spec)\.(ts|tsx|js|jsx)$", r"^\.keel/hunt/repro/")]


def section_file(root: str, name: str) -> Path:
    """The section's file where the project's layout keeps it (docs/knowledge, .keel/knowledge; keel_engine/layout.py)."""
    return Path(root) / layout.resolve(root).knowledge_file(root, name)


def knowledge_dir(root: str) -> str:
    """Where the knowledge sections go in this project's layout, e.g. docs/knowledge or .keel/knowledge."""
    return layout.resolve(root).knowledge


def is_proof(rel: str) -> bool:
    """A citation into a test (or a hunt's repro recipe) is a proof: somebody ran it."""
    return any(p.search(rel) for p in PROOF)


def citations(text: str) -> list[dict]:
    return [{"rel": m.group(1), "line": int(m.group(2)), "end": int(m.group(3)) if m.group(3) else None}
            for m in CITATION.finditer(text)]


def _lines(p: Path) -> int | None:
    try:
        return len(p.read_text(errors="replace").split("\n"))
    except (OSError, IsADirectoryError):
        return None


def resolve(root: str, rel: str, files: list[str] | None) -> tuple[str | None, str | None]:
    """(the file a citation names, the problem). A path that exists is itself. A shorthand (`.../a/B.java`, `B.java`)
    is the one tracked file that ends with it: agents shorten long paths, and one match names the file as well as the
    full path does. None of them, or two, is a problem the librarian can fix."""
    if (Path(root) / rel).is_file():
        return rel, None
    tail = re.sub(r"^(\.\.\./|…/)+", "", rel).lstrip("/")
    if files is None or not tail:
        return None, "does not exist"
    hits = [f for f in files if f == tail or f.endswith("/" + tail)]
    if len(hits) == 1:
        return hits[0], None
    if hits:
        return None, f"matches {len(hits)} files ({', '.join(hits[:3])}{', …' if len(hits) > 3 else ''}); give the full path"
    return None, "does not exist"


def built(root: str) -> list[str]:
    return [n for n in SECTIONS if section_file(root, n).is_file()]


def selection(root: str, cfg: dict | None = None) -> list[str] | None:
    """The sections this project maintains; None = never asked and nothing written."""
    cfg = cfg if cfg is not None else rules.load_config(root)
    chosen = ((cfg.get("init") or {}).get("knowledge_sections"))
    if isinstance(chosen, list):
        return list(dict.fromkeys([n for n in chosen if n in SECTIONS] + built(root)))
    return built(root) or None


def check_section(root: str, name: str, cfg: dict, files: list[str] | None = None) -> dict:
    rel = layout.resolve(root).knowledge_file(root, name)
    f = Path(root) / rel
    if not f.is_file():
        return {"name": name, "missing": True, "problems": [f"{rel} is missing"], "citations": 0, "proofs": 0, "unverified": 0}
    text = f.read_text(errors="replace")
    problems = []
    left = PLACEHOLDER.findall(text)
    if left:
        problems.append(f"{rel}: {len(left)} template placeholder(s) never filled in: {', '.join(list(dict.fromkeys(left))[:4])}")
    cites = citations(text)
    for c in cites:
        path, why = resolve(root, c["rel"], files)
        n = _lines(Path(root) / path) if path else None
        if n is None:
            problems.append(f"{rel}: cites `{c['rel']}:{c['line']}`, which {why or 'does not exist'}")
            continue
        last = c["end"] or c["line"]
        if last > n:
            problems.append(f"{rel}: cites `{c['rel']}:{last}` but that file has {n} line(s)"
                            + (f" ({path})" if path != c["rel"] else ""))
    if not cites:
        problems.append(f"{rel}: no citations at all; every claim here is unsourced")
    terms = (cfg.get("memory") or {}).get("proof_required_terms") or []
    unverified = 0
    for i, line in enumerate(text.split("\n"), 1):
        hit = next((t for t in terms if t in line), None)
        if not hit:
            continue
        if re.search(r"\bunverified:", line, re.I):
            unverified += 1
        elif not any(is_proof(c["rel"]) for c in citations(line)):
            problems.append(f"{rel}:{i}: mentions {hit} with no proof and no `unverified:` marker; cite a test, "
                            "or say it is unverified")
    return {"name": name, "missing": False, "problems": problems, "citations": len(cites),
            "proofs": sum(is_proof(c["rel"]) for c in cites), "unverified": unverified}


def check(root: str, only: list[str] | None = None) -> dict:
    """{pass, problems, sections: [...], selected, unanswered}. `only` overrides the chosen sections."""
    cfg = rules.load_config(root)
    sel = selection(root, cfg) if only is None else only
    unanswered = sel is None
    chosen = sel or []
    sections = []
    files = git.tracked(root) if git.is_repo(root) else None   # for shorthand citations (resolve)
    for n in SECTIONS:
        if n in chosen or section_file(root, n).is_file():
            sections.append({**check_section(root, n, cfg, files), "selected": n in chosen})
        else:
            sections.append({"name": n, "selected": False, "not_selected": True, "missing": True, "problems": [],
                             "citations": 0, "proofs": 0, "unverified": 0})
    problems = [p for s in sections for p in s["problems"]]
    # keel v2 before 0.4 failed an empty knowledge base; a project that chose no sections (init) passes.
    if unanswered:
        problems.append(f"{knowledge_dir(root)}/ has no sections")
    return {"pass": not problems, "problems": problems, "sections": sections, "selected": chosen, "unanswered": unanswered}


def content_hash(root: str) -> str:
    """What the knowledge base says now: a verdict for the same text is current at any later commit."""
    h = hashlib.sha1()
    for n in SECTIONS:
        h.update(n.encode())
        f = section_file(root, n)
        h.update(f.read_bytes() if f.is_file() else b"<missing>")
    return h.hexdigest()[:12]
