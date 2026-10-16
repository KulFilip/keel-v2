"""Changes that apply without a restart (docs/plugins/22-one-plugins-page.md §5; docs/plugins/README.md: "Content-only
and web-only plugins load without a restart").

A plugin whose parts are only `web` and/or `content` runs no code in keel: the engine reads its content folder and the
browser loads its web part. So turning one on or off, installing, updating, rolling back or removing it applies at once:

    1. resolve what the next start would load, and compare it with run/resolved.json (what is loaded now)
    2. take only the changes of plugins that are web/content-only before and after (no engine, api or migrations part),
       and only when what they need stays loaded (a web plugin that needs a plugin which waits for the restart waits too)
    3. write run/resolved.json (and run/env, the same as keel-start's resolver writes) with those changes and everything
       else as it was loaded: what waits for the restart still shows as pending
    4. read the plugins' content again (addons.reload_content, the workflow templates)

The api calls POST /marketplace/apply-live after each change, then reads resolved.json again itself (PluginHost) and
the web reads /api/features again. A plugin with an engine or api part always waits for the restart: keel never
restarts by itself here.
"""

from __future__ import annotations

import json
import logging

from .. import addons
from ..addons import satisfies
from ..pluginhost import PluginError, resolver, state
from . import install

log = logging.getLogger("keel.marketplace")

# what a change means for one plugin: applied now, waits for the restart, or nothing to load (a plugin with code whose
# loaded version is the chosen one already: turned off and on again)
APPLIED, RESTART, SAME = "applied", "restart", "same"


def is_live(entry: dict | None) -> bool:
    """A resolved.json entry (or none: not loaded) that can come or go without a restart: only web and/or content."""
    return entry is None or not (entry.get("engine") or entry.get("api") or entry.get("migrations"))


def _needs(entry: dict) -> dict[str, str]:
    req = entry.get("requires") if isinstance(entry.get("requires"), dict) else {}
    plugins = req.get("plugins") if isinstance(req.get("plugins"), dict) else {}
    return {str(k): str(v) for k, v in plugins.items()}


def _read() -> dict | None:
    f = state.run_dir() / "resolved.json"
    try:
        data = json.loads(f.read_text(encoding="utf-8")) if f.is_file() else None
    except (OSError, UnicodeDecodeError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("plugins"), list) else None


def _settle(final: dict[str, dict], old: dict[str, dict], live: set[str]) -> None:
    """Undo a live change whose needs are not loaded, or that a loaded plugin still needs, until none is left."""
    while True:
        bad: set[str] = set()
        for name, e in final.items():
            for dep, spec in _needs(e).items():
                ok = dep in final and satisfies(str(final[dep].get("version") or ""), spec)
                if not ok and name in live:
                    bad.add(name)          # what it needs is not loaded (it waits for the restart)
                elif not ok and dep in live:
                    bad.add(dep)           # a loaded plugin still needs the old one
        if not bad:
            return
        for n in bad:
            live.discard(n)
            if n in old:
                final[n] = old[n]
            else:
                final.pop(n, None)


def _plain(entry) -> dict | None:
    return json.loads(json.dumps(entry)) if entry is not None else None


def apply(names: list[str] | None = None) -> dict:
    """Apply the web/content-only changes now. `names`: the plugins a change touched; each gets "applied" (a web/content
    plugin, loaded as chosen now), "restart" (it waits for the restart) or "same" (a plugin with code whose loaded
    version is the chosen one). Answers {applied: [{name, from, to, web, content}], names,
    pending_restart}."""
    with install._locked():
        old_doc = _read()
        try:
            res = resolver.resolve()
        except PluginError:
            res = None
        applied: list[dict] = []
        if old_doc is not None and res is not None and old_doc.get("mode", res.mode) == res.mode:
            applied = _write(old_doc, res)
        if applied:
            _reload()
        pending = install.pending_restart()
        waiting = {c["name"] for c in pending.get("changes") or []}
        now = {str(p.get("name")): p for p in (_read() or {}).get("plugins") or [] if isinstance(p, dict)}
        nxt = {p.name: p.entry() for p in res.plugins} if res else {}

        def verdict(n: str) -> str:
            if n in waiting or old_doc is None or res is None:
                return RESTART
            # nothing differs from what is loaded: a web/content plugin is as chosen; one with code may have changed
            # files under the same version (an install from a file with force), so the api still offers the restart
            return APPLIED if is_live(now.get(n)) and is_live(nxt.get(n)) else SAME

        return {"applied": applied, "names": {n: verdict(n) for n in names or []}, "pending_restart": pending}


def _write(old_doc: dict, res: resolver.Resolution) -> list[dict]:
    old_list = [p for p in old_doc["plugins"] if isinstance(p, dict) and p.get("name")]
    old = {str(p["name"]): p for p in old_list}
    new = {p.name: _plain(p.entry()) for p in res.plugins}
    changed = {n for n in set(old) | set(new) if old.get(n) != new.get(n)}
    live = {n for n in changed if is_live(old.get(n)) and is_live(new.get(n))}
    if not live:
        return []
    final = dict(old)
    for n in live:
        if n in new:
            final[n] = new[n]
        else:
            final.pop(n, None)
    _settle(final, old, live)
    if not live:
        return []
    order = [p.name for p in res.plugins] + [n for n in old if n not in new]
    plugins = [final[n] for n in dict.fromkeys(order) if n in final]
    problems = [p for p in old_doc.get("problems") or [] if not (isinstance(p, dict) and p.get("name") in live)]
    problems += [p for p in res.problems if p.get("name") in live and p.get("name") not in final]
    doc = {**old_doc, "resolved_at": state.now(), "plugins": plugins, "problems": problems}
    folder = state.run_dir()
    state.write_atomic(folder / "resolved.json", json.dumps(doc, indent=2) + "\n")
    state.write_atomic(folder / "env", resolver.env_text(resolver.env_of(plugins)))
    out = []
    for n in sorted(live):
        before, after = old.get(n), final.get(n)
        both = [e for e in (before, after) if e]
        out.append({"name": n, "from": before.get("version") if before else None,
                    "to": after.get("version") if after else None,
                    "web": any(e.get("web") for e in both), "content": any(e.get("content") for e in both)})
        log.info("plugins: %s %s → %s applies now (web/content only)", n, out[-1]["from"], out[-1]["to"])
    return out


def _reload() -> None:
    """The engine reads the plugins' content again: their workflows, agents and KeelBot commands."""
    from ..workflows import templates

    addons.reload_content()
    templates.clear_cache()
