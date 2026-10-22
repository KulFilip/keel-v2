"""keel Product's business flows: what a repo carries out for its users, as the flow analyst found it.

The analyst ends its answer with a ```json block:

    {"flows": [{"id": "checkout", "name": "Checkout", "summary": "...",
                "steps": [{"text": "The cart is priced", "cite": "src/Cart.kt:40"}],
                "endpoints": ["POST /orders"], "tables": ["orders"]}]}

check() keeps what is well formed and drops every cite that does not point at a line of a file in the repo (an agent's
guess is not shown as a fact). write() keeps a repo's flows as flows/<project>.json in the product repo (a commit).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from . import docs
from .plan import BLOCK

SLUG = re.compile(r"[^a-z0-9]+")
PROJECT = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
CITE = re.compile(r"^(?P<path>[^:]+):(?P<line>\d{1,7})$")
MAX_FLOWS, MAX_STEPS, MAX_LIST = 12, 8, 20


def parse(text: str) -> list[dict] | None:
    """The flows in the last ```json block of a text (or the text itself as JSON); None when there are none."""
    for raw in reversed(BLOCK.findall(text or "") or [text or ""]):
        try:
            data = json.loads(raw)
        except ValueError:
            continue
        if isinstance(data, dict) and isinstance(data.get("flows"), list):
            return [f for f in data["flows"] if isinstance(f, dict)]
    return None


def _cite(root: Path, cite: object) -> str | None:
    m = CITE.match(str(cite or "").strip())
    if not m:
        return None
    rel = m.group("path").strip().removeprefix("./")
    f = (root / rel).resolve()
    try:
        f.relative_to(root.resolve())
    except ValueError:
        return None
    if not f.is_file():
        return None
    line = int(m.group("line"))
    with f.open("rb") as fh:
        lines = sum(1 for _ in fh)
    return f"{rel}:{line}" if 1 <= line <= max(lines, 1) else None


def _strings(v: object, cap: int = MAX_LIST, size: int = 120) -> list[str]:
    return [str(x).strip()[:size] for x in (v if isinstance(v, list) else []) if str(x).strip()][:cap]


def check(flows: list[dict], root: str) -> tuple[list[dict], int]:
    """(the clean flows, how many cites were dropped)."""
    base = Path(root)
    out, seen, dropped = [], set(), 0
    for f in flows[:MAX_FLOWS]:
        name = str(f.get("name") or "").strip()[:80]
        if not name:
            continue
        fid = SLUG.sub("-", str(f.get("id") or name).lower()).strip("-")[:40] or "flow"
        while fid in seen:
            fid = f"{fid}-2"
        seen.add(fid)
        steps = []
        for s in (f.get("steps") if isinstance(f.get("steps"), list) else [])[:MAX_STEPS]:
            if not isinstance(s, dict) or not str(s.get("text") or "").strip():
                continue
            cite = _cite(base, s.get("cite"))
            if s.get("cite") and cite is None:
                dropped += 1
            steps.append({"text": str(s["text"]).strip()[:300], "cite": cite})
        out.append({"id": fid, "name": name, "summary": str(f.get("summary") or "").strip()[:400], "steps": steps,
                    "endpoints": _strings(f.get("endpoints")), "tables": _strings(f.get("tables"), size=80)})
    return out, dropped


def write(root: str, project: str, flows: list[dict]) -> dict:
    """flows/<project>.json in the product repo, committed. Returns {path, sha}."""
    if not PROJECT.match(project or ""):
        raise docs.DocError(f"not a project id: {project!r}")
    f = Path(root) / "flows" / f"{project}.json"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({"project": project, "flows": flows}, indent=2) + "\n")
    rel = str(f.relative_to(root))
    return {"path": rel, "sha": docs.commit(root, [rel], f"flows: {project}")}
