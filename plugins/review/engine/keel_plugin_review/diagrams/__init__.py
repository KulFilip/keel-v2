"""The overview's diagrams for one review (the Code Review plugin's Database and System tabs), from git alone: no
model, nothing run, nothing written.

    build(root, base, head, files, live=None, live_name=None, pid=None) -> {base, head, database, system, text}

base and head are the review's two commits (base: the merge base). files are the changed files as the api lists them:
[{path, status, from}]. live is the Database plugin's schema when the project has a connection (read only), used as
"before" when it does not already hold the change. The Map plugin's modules, when keel has built the map, name the
areas of the System tab. `text` is both diagrams in ASCII, for keel TUI.
"""

from __future__ import annotations

import logging
import re

from . import database, gitio, render, system

log = logging.getLogger(__name__)
MAX_CHANGED = 3000
CONFIG_FILES = re.compile(r"(^|/)(application[\w.-]*\.(ya?ml|properties)|messenger\.ya?ml|services\.ya?ml|\.env\.example|"
                          r"\.env\.dist|config/[\w/.-]+\.(ya?ml|properties|toml))$", re.I)


def _map_modules(pid: str | None) -> list[dict] | None:
    """The Map plugin's modules, when it is installed and has a map for the project (read only)."""
    if not pid:
        return None
    try:
        from keel_plugin_map import mapper  # type: ignore[import-not-found]
    except Exception:                                       # noqa: BLE001 - the Map plugin is optional
        return None
    try:
        m = mapper.load(pid) or {}
    except Exception:                                       # noqa: BLE001
        return None
    levels = (m.get("levels") or {}).get("modules") or {}
    names = [n.get("title") for n in levels.get("nodes") or [] if str(n.get("id", "")).startswith("mod:") and n.get("title")]
    return [{"name": n} for n in names] or None


def build(root: str, base: str, head: str, files: list[dict], live: dict | None = None, live_name: str | None = None,
          pid: str | None = None) -> dict:
    if not (gitio.valid_sha(base) and gitio.valid_sha(head)):
        raise ValueError("base and head must be commit ids")
    files = [f for f in files if isinstance(f, dict) and f.get("path")][:MAX_CHANGED]
    head_paths = gitio.ls_tree(root, head)
    base_paths = gitio.ls_tree(root, base)
    live_paths = [f["path"] for f in files if (f.get("status") or "M")[:1] != "D"]
    head_texts = gitio.read_many(root, head, live_paths)
    db = database.build(root, base, head, files, head_paths, base_paths, head_texts, live=live, live_name=live_name)
    configs = [p for p in head_paths if CONFIG_FILES.search(p)][:30]
    config_texts = {p: t for p, t in gitio.read_many(root, head, configs).items() if t}
    modules = _map_modules(pid)
    sysg = system.build(files, head_texts, db.get("table_names") or [], modules, head_paths, config_texts)
    sysg["mermaid"] = render.system_mermaid(sysg)
    sysg["ascii"] = render.system_ascii(sysg)
    parts = []
    if db.get("shown"):
        parts.append("== Database ==\n\n" + db["ascii"])
        if db.get("risks"):
            parts.append("risks:\n" + "\n".join(render.ascii_text(f"  [{r['severity']}] {r['path']}:{r['line']}  {r['text']}")
                                                for r in db["risks"]))
        if db.get("not_parsed"):
            parts.append("not read (open the file):\n" + "\n".join(render.ascii_text(f"  {n['path']}:{n['line']}  {n['why']}")
                                                                  for n in db["not_parsed"]))
    parts.append("== System ==\n\n" + sysg["ascii"])
    return {"base": base, "head": head, "database": db, "system": sysg, "text": "\n\n".join(parts)}
