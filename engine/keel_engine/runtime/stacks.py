"""Stack packs: which of keel's stacks a project uses (the engine's twin of the api's StackService).

    defs(root)       every stack keel knows: content/stacks/*.yml, content/packs/<name>/stack.yml, then the project's
                     own <root>/.keel/stacks (a project stack with the same name wins)
    matched(root)    the ones this project uses: a project stack always, a shipped one when its `detect` block matches
                     (exclude_files first, then files / package_deps / extensions, in the root and one folder down);
                     never one the project turned off (keel 0.18.9: `stacks: {ignore: [name]}` in .keel/config.yml)
    turned_off(root) those names

Detection walks the tree for `extensions`, so the answer is kept for a minute per root.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import yaml

from .. import config

SKIP = {"node_modules", "build", ".git", ".venv", "venv", "dist", "target", ".gradle", "vendor", "__pycache__"}
TTL = 60.0
_CACHE: dict[str, tuple[float, list[dict]]] = {}


def _read(f: Path, source: str) -> dict | None:
    try:
        doc = yaml.safe_load(f.read_text())
    except (OSError, yaml.YAMLError):
        return None
    if not isinstance(doc, dict) or not doc.get("name"):
        return None
    return {**doc, "_source": source, "_file": str(f)}


def shipped() -> list[dict]:
    """keel's own stacks (source "keel") and packs (source "keel pack")."""
    base = config.content_dir()
    out = [d for f in sorted((base / "stacks").glob("*.yml")) if (d := _read(f, "keel"))]
    packs = base / "packs"
    if packs.is_dir():
        out += [d for p in sorted(packs.iterdir()) if (p / "stack.yml").is_file() and (d := _read(p / "stack.yml", "keel pack"))]
    return out


def project_defs(root: str) -> list[dict]:
    """<root>/.keel/stacks: a <name>.yml, a <dir>/stack.yml or yml files in <dir> (what installing a pack leaves)."""
    d = Path(root) / ".keel" / "stacks"
    if not d.is_dir():
        return []
    files = sorted(f for f in d.rglob("*.yml") if f.is_file() and len(f.relative_to(d).parts) <= 3)
    seen: set[str] = set()
    out = []
    for f in files:
        doc = _read(f, "project")
        if doc and doc["name"] not in seen:
            seen.add(doc["name"])
            out.append(doc)
    return out


def defs(root: str) -> list[dict]:
    project = project_defs(root)
    names = {d["name"] for d in project}
    return [d for d in shipped() if d["name"] not in names] + project


def _strings(v) -> list[str]:
    return [str(x) for x in v] if isinstance(v, list) else []


def _dirs(root: Path) -> list[Path]:
    try:
        kids = sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".") and p.name not in SKIP)
    except OSError:
        kids = []
    return [root, *kids]


def _package_deps(d: Path) -> set[str]:
    f = d / "package.json"
    if not f.is_file():
        return set()
    try:
        doc = json.loads(f.read_text())
    except (OSError, ValueError):
        return set()
    return {k for key in ("dependencies", "devDependencies") for k in (doc.get(key) or {})}


def _has_extension(d: Path, exts: list[str], budget: list[int]) -> bool:
    stack = [d]
    while stack:
        cur = stack.pop()
        try:
            entries = list(cur.iterdir())
        except OSError:
            continue
        for e in entries:
            budget[0] -= 1
            if budget[0] <= 0:
                return False
            if e.is_dir():
                if e.name not in SKIP and not e.name.startswith(".") and len(e.relative_to(d).parts) < 6:
                    stack.append(e)
            elif any(e.name.endswith(x) for x in exts):
                return True
    return False


def detects(detect: dict, root: str) -> bool:
    """The api's StackService.detects: `exclude_files` first; then any of files / package_deps / extensions."""
    detect = detect if isinstance(detect, dict) else {}
    exclude, wanted = _strings(detect.get("exclude_files")), _strings(detect.get("files"))
    deps, exts = _strings(detect.get("package_deps")), _strings(detect.get("extensions"))
    if not (wanted or deps or exts):
        return False
    budget = [20_000]
    for d in _dirs(Path(root)):
        if any((d / x).exists() for x in exclude):
            continue
        if any((d / x).exists() for x in wanted):
            return True
        if deps and _package_deps(d) & set(deps):
            return True
        if exts and _has_extension(d, exts, budget):
            return True
    return False


def turned_off(root: str) -> set[str]:
    """The stacks this project turned off (keel 0.18.9): `stacks: {ignore: [name, ...]}` in .keel/config.yml (not `off`:
    YAML 1.1 reads that key as false). keel's own stack that detection matched wrongly is turned off here; it stays in
    keel, only this project does not use it."""
    f = Path(root) / ".keel" / "config.yml"
    try:
        doc = yaml.safe_load(f.read_text()) if f.is_file() else None
    except (OSError, yaml.YAMLError):
        return set()
    block = doc.get("stacks") if isinstance(doc, dict) else None
    return set(_strings(block.get("ignore"))) if isinstance(block, dict) else set()


def matched(root: str) -> list[dict]:
    """The stacks this project uses, keel's first, then the project's own; none it turned off."""
    key = str(Path(root).resolve())
    hit = _CACHE.get(key)
    if hit and time.monotonic() - hit[0] < TTL:
        return hit[1]
    off = turned_off(root)
    out = [d for d in defs(root) if d["name"] not in off and (d["_source"] == "project" or detects(d.get("detect") or {}, root))]
    _CACHE[key] = (time.monotonic(), out)
    return out


def forget(root: str | None = None):
    """Drop the cached detection (tests, or after the project's files changed shape)."""
    if root is None:
        _CACHE.clear()
    else:
        _CACHE.pop(str(Path(root).resolve()), None)


WEB_TEST_KEYS = ("web_test_ac", "web_test_module", "web_test_paths")


def has_web_layer(root: str) -> bool:
    """Does the project test a web layer of its own (0.18.12)? Yes with a web test command (commands.web_test_* in
    .keel/config.yml), a frontend folder that exists (frontend.dir), or a stack in the web lane. A server-rendered app
    (Spring MVC with Thymeleaf, Django templates) has none: its pages are tested by backend tests in the api lane, so a
    [WEB] criterion there could never get a test past the guard."""
    from .. import rules
    from ..tools import testcmd

    cmds = rules.load_config(root).get("commands") or {}
    if any(str(cmds.get(k) or "").strip() for k in WEB_TEST_KEYS) or testcmd.part_dir(root, "frontend"):
        return True
    return any(str(d.get("lane") or "") == "web" or any(k in (d.get("commands") or {}) for k in WEB_TEST_KEYS)
               for d in matched(root))
