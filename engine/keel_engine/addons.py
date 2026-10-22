"""keel add-ons: optional packages that add workflows, agents, code actions, fake-model answers and routes to the engine
without changing it (keel Product is one). Nothing loads unless KEEL_PLUGIN_ADDONS or KEEL_ADDONS names a package.

    KEEL_PLUGIN_ADDONS=keel_product     the engine packages of the resolved plugins (run/env, written by
                                        `keel-engine plugins resolve`), loaded first
    KEEL_PLUGIN_PATHS=/opt/…/engine     their folders (':'-separated), put on sys.path inside the engine only
    KEEL_ADDONS=keel_product            a comma-separated list of importable Python packages (as before plugins)

An add-on package has a module-level ADDON dict:

    name      "product"                 its id: its actions are "<name>:*", the events it emits "<name>.*"
    version   "0.1.0-beta.1"
    requires  ">=0.13.0,<0.15.0"        the keel versions it works with; another keel refuses to load it
    content   Path                      a folder with workflows/ and agents/ (both optional)
    actions   {"product:save-doc": fn}  code actions: fn(ActionInput) -> ActionResult, plain or async
    fake      fn(AgentRequest)          the fake model's answer for its agents: (path, content, answer, data) or None
    router    fastapi.APIRouter         engine routes, mounted as they are

An add-on that fails to import, or needs another keel, is left out and listed under problems (GET /addons).

A plugin's content needs no engine part (docs/plugins/02-plugin-package.md: a plugin can be only content). Each plugin
keel's last start loaded (run/resolved.json, written by keel-start's resolver before the engine starts) that has a
`content` folder is a content source too, after the add-ons: its workflows/, agents/ and plugins/ (KeelBot commands).
A plugin whose engine part loaded keeps its ADDON content as before; one whose engine part did not load brings no
content either. keel's own names always win (a plugin cannot replace a core workflow, agent or command); an earlier
source wins over a later one; the names a source could not use are listed under its `refused` (GET /addons).
"""

from __future__ import annotations

import importlib
import inspect
import logging
import os
import re
import sys
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from . import agent_names, config

log = logging.getLogger("keel.addons")
NAME = re.compile(r"^[a-z][a-z0-9-]{0,31}$")


@dataclass
class Addon:
    name: str
    version: str
    package: str
    requires: str = ""
    content: Path | None = None
    actions: dict = field(default_factory=dict)
    fake: object = None
    router: object = None

    def folder(self, kind: str) -> Path | None:
        d = self.content / kind if self.content else None
        return d if d and d.is_dir() else None

    def info(self) -> dict:
        return {"name": self.name, "version": self.version, "package": self.package, "requires": self.requires,
                "workflows": sorted(f.stem for f in (self.folder("workflows") or Path("/nonexistent")).glob("*.yaml")),
                "agents": sorted(f.stem for f in (self.folder("agents") or Path("/nonexistent")).glob("*.md")),
                "actions": sorted(self.actions)}


def _numbers(version: str) -> tuple[int, ...]:
    """'0.13.2-beta.1' → (0, 13, 2): the release numbers only."""
    head = re.split(r"[-+]", version.strip(), maxsplit=1)[0]
    return tuple(int(p) for p in head.split(".") if p.isdigit())


def satisfies(version: str, spec: str) -> bool:
    """Whether a keel version meets a spec like '>=0.13.0,<0.15.0' (an empty spec: any version)."""
    have = _numbers(version)
    for part in [p.strip() for p in (spec or "").split(",") if p.strip()]:
        m = re.match(r"^(>=|<=|==|>|<)\s*([0-9][0-9.]*)$", part)
        if not m:
            return False
        op, want = m.group(1), _numbers(m.group(2))
        ok = {">=": have >= want, "<=": have <= want, "==": have == want, ">": have > want, "<": have < want}[op]
        if not ok:
            return False
    return True


_problems: list[dict] = []


def _load_one(package: str) -> Addon | None:
    try:
        mod = importlib.import_module(package)
    except Exception as exc:  # noqa: BLE001 - an add-on that does not import is a problem to show, not a crash
        _problems.append({"package": package, "error": f"does not import: {str(exc)[:300]}"})
        return None
    spec = getattr(mod, "ADDON", None)
    if not isinstance(spec, dict) or not NAME.match(str(spec.get("name") or "")):
        _problems.append({"package": package, "error": "has no ADDON with a valid name"})
        return None
    a = Addon(name=spec["name"], version=str(spec.get("version") or "0"), package=package, requires=str(spec.get("requires") or ""),
              content=Path(spec["content"]) if spec.get("content") else None, actions=dict(spec.get("actions") or {}),
              fake=spec.get("fake"), router=spec.get("router"))
    if not satisfies(config.VERSION, a.requires):
        _problems.append({"package": package, "name": a.name, "error": f"needs keel {a.requires}, this is keel {config.VERSION}"})
        return None
    wrong = [k for k in a.actions if not k.startswith(f"{a.name}:")]
    if wrong:
        _problems.append({"package": package, "name": a.name, "error": f"actions must start with '{a.name}:': {', '.join(wrong)}"})
        return None
    return a


def _plugin_paths() -> None:
    """Put each KEEL_PLUGIN_PATHS folder at the front of sys.path, in its order, each once (inside the engine only:
    project commands never see them, unlike PYTHONPATH)."""
    folders = [p.strip() for p in os.environ.get("KEEL_PLUGIN_PATHS", "").split(":") if p.strip()]
    for folder in reversed(folders):
        if folder not in sys.path:
            sys.path.insert(0, folder)
    if folders:
        importlib.invalidate_caches()


def packages() -> list[str]:
    """The packages to load: KEEL_PLUGIN_ADDONS, then KEEL_ADDONS, each once."""
    out: list[str] = []
    for var in ("KEEL_PLUGIN_ADDONS", "KEEL_ADDONS"):
        for p in os.environ.get(var, "").split(","):
            if p.strip() and p.strip() not in out:
                out.append(p.strip())
    return out


@lru_cache(maxsize=1)
def loaded() -> tuple[Addon, ...]:
    _problems.clear()
    _plugin_paths()
    out: list[Addon] = []
    for package in packages():
        a = _load_one(package)
        if a and not any(x.name == a.name for x in out):
            out.append(a)
            log.info("add-on %s %s loaded from %s", a.name, a.version, package)
    for p in _problems:
        log.warning("add-on %s left out: %s", p.get("package"), p["error"])
    return tuple(out)


def reload() -> tuple[Addon, ...]:
    """Read KEEL_PLUGIN_PATHS, KEEL_PLUGIN_ADDONS, KEEL_ADDONS and run/resolved.json again (tests)."""
    loaded.cache_clear()
    _plugin_content.cache_clear()
    return loaded()


def reload_content() -> tuple[Content, ...]:
    """Read run/resolved.json again for the plugins' content, the add-ons stay as they are (marketplace/live.py: a
    content-only or web plugin turned on, off, installed or removed applies without a restart)."""
    _plugin_content.cache_clear()
    return plugin_content()


def info() -> dict:
    return {"addons": [a.info() for a in loaded()], "content": [c.info() for c in plugin_content()],
            "problems": list(_problems)}


def names() -> set[str]:
    return {a.name for a in loaded()}


# ------------------------------------------------------------------ plugins that bring content without an engine part

KINDS = {"workflows": "*.yaml", "agents": "*.md", "plugins": "*/plugin.yml"}
# agents keel has without a file (runtime/prompts.py BUILTIN_ROLES; tests/test_plugin_content.py checks the two agree):
# a plugin's content cannot bring one of these either
BUILTIN_AGENTS = frozenset({"contract-author"})


@dataclass(frozen=True)
class Content:
    """A loaded plugin's content folder that no add-on brings (a content-only or web + content plugin)."""
    name: str
    version: str
    source: str        # image, marketplace or file (resolved.json)
    content: Path

    def folder(self, kind: str) -> Path | None:
        d = self.content / kind
        return d if d.is_dir() else None

    def info(self) -> dict:
        def stems(kind: str) -> list[str]:
            d = self.folder(kind)
            return sorted((f.parent.name if kind == "plugins" else f.stem) for f in d.glob(KINDS[kind])) if d else []

        out = {"name": self.name, "version": self.version, "source": self.source, "content": str(self.content),
               "workflows": stems("workflows"), "agents": stems("agents"), "plugins": stems("plugins")}
        out["refused"] = refused(self.name)
        return out


def _resolved_file() -> Path:
    from .pluginhost import state   # here: pluginhost's resolver imports this module

    return state.run_dir() / "resolved.json"


def _resolved_plugins(f: Path) -> list[dict]:
    """The plugins of run/resolved.json ([] when keel-start resolved none, or the file does not read)."""
    import json

    try:
        data = json.loads(f.read_text(encoding="utf-8")) if f.is_file() else {}
        plugins = data.get("plugins") if isinstance(data, dict) else None
        return [p for p in plugins if isinstance(p, dict)] if isinstance(plugins, list) else []
    except (OSError, UnicodeDecodeError, ValueError):
        log.warning("plugins: %s does not read, so no plugin brings content", f)
        return []


def plugin_content() -> tuple[Content, ...]:
    """The content sources of the loaded plugins that no loaded add-on covers, in resolved.json's order. Read once per
    resolved.json (keel-start writes it before the engine starts) and set of add-ons: a change loads at the next start,
    or at once when marketplace/live.py rewrote resolved.json for a content or web plugin (reload_content)."""
    return _plugin_content(str(_resolved_file()), tuple((a.name, a.package, str(a.content)) for a in loaded()))


@lru_cache(maxsize=4)
def _plugin_content(file: str, _addons: tuple) -> tuple[Content, ...]:
    by_package = {a.package: a for a in loaded()}
    by_name = {a.name for a in loaded() if a.content}
    out: list[Content] = []
    for p in _resolved_plugins(Path(file)):
        name, content = str(p.get("name") or ""), p.get("content")
        if not NAME.match(name) or not isinstance(content, str) or not content:
            continue
        engine = p.get("engine")
        if isinstance(engine, dict):
            a = by_package.get(str(engine.get("package") or ""))
            if a is None or a.content:
                # its engine part did not load (it brings nothing then), or its ADDON says where its content is
                continue
        if name in by_name or any(c.name == name for c in out) or not Path(content).is_dir():
            continue
        out.append(Content(name, str(p.get("version") or ""), str(p.get("source") or ""), Path(content)))
        log.info("plugin %s %s: its content loads (%s)", name, p.get("version"), content)
    return tuple(out)


# ------------------------------------------------------------------ content

def addon_folders(kind: str) -> list[tuple[str, Path]]:
    """(add-on name, folder) for each loaded add-on that has content of this kind (workflows, agents, plugins)."""
    return [(a.name, d) for a in loaded() if (d := a.folder(kind))]


def plugin_folders(kind: str) -> list[tuple[str, Path]]:
    """(plugin name, folder) for each content source of plugin_content() that has content of this kind."""
    return [(c.name, d) for c in plugin_content() if (d := c.folder(kind))]


def folders(kind: str) -> list[tuple[str, Path]]:
    """The add-ons' folders of this kind, then the plugins' (content without an engine part)."""
    return addon_folders(kind) + plugin_folders(kind)


def _core_names(kind: str) -> set[str]:
    d = config.content_dir() / kind
    # an old agent name (agent_names.RENAMED) stays keel's: a plugin cannot take it
    builtin = set(BUILTIN_AGENTS) | set(agent_names.OLD_NAMES) if kind == "agents" else set()
    if not d.is_dir():
        return builtin
    return builtin | {f.parent.name if kind == "plugins" else f.stem for f in d.glob(KINDS[kind])}


def refused(name: str) -> list[str]:
    """What a plugin's content source cannot use because keel (or an earlier source) has the name: 'workflow feature'."""
    out: list[str] = []
    for kind, word in (("workflows", "workflow"), ("agents", "agent"), ("plugins", "command set")):
        taken = _core_names(kind)
        for source, d in folders(kind):
            mine = {f.parent.name if kind == "plugins" else f.stem for f in d.glob(KINDS[kind])}
            if source == name:
                out += [f"{word} {n}: keel or an earlier plugin has this name" for n in sorted(mine & taken)]
            taken |= mine
    return out


def agent_file(agent: str) -> Path | None:
    """An add-on's agent file, else a plugin's (a plugin's never for an agent keel has without a file). An old agent
    name (agent_names.RENAMED) gives the new agent's file."""
    agent = agent_names.canonical(agent) or ""
    for _name, d in addon_folders("agents"):
        f = d / f"{agent}.md"
        if f.is_file():
            return f
    if agent in BUILTIN_AGENTS:
        return None
    for _name, d in plugin_folders("agents"):
        f = d / f"{agent}.md"
        if f.is_file():
            return f
    return None


def agent_path(agent: str) -> Path:
    """keel's own agent file, else a loaded add-on's (the path may not exist: an agent with no file). An old agent name
    (agent_names.RENAMED) gives the new agent's file."""
    agent = agent_names.canonical(agent) or ""
    core = config.content_dir() / "agents" / f"{agent}.md"
    return core if core.is_file() else (agent_file(agent) or core)


def agent_files() -> list[Path]:
    """Every agent file: keel's own, then the add-ons' (an add-on cannot replace one of keel's), then the plugins'
    (each name once, never one keel or an add-on has)."""
    core = sorted((config.content_dir() / "agents").glob("*.md")) if (config.content_dir() / "agents").is_dir() else []
    seen = {f.stem for f in core} | set(agent_names.OLD_NAMES)    # an old name is never an agent of its own
    more = [f for _n, d in addon_folders("agents") for f in sorted(d.glob("*.md")) if f.stem not in seen]
    seen |= {f.stem for f in more} | BUILTIN_AGENTS
    for _n, d in plugin_folders("agents"):
        for f in sorted(d.glob("*.md")):
            if f.stem not in seen:
                more.append(f)
                seen.add(f.stem)
    return core + more


# ------------------------------------------------------------------ actions, fake answers, routes, events

def has_action(action: str) -> bool:
    return any(action in a.actions for a in loaded())


async def run_action(action: str, inp):
    for a in loaded():
        fn = a.actions.get(action)
        if fn is None:
            continue
        if inspect.iscoroutinefunction(fn):
            return await fn(inp)
        import asyncio

        return await asyncio.to_thread(fn, inp)
    raise KeyError(action)


def fake_answer(req):
    """The first add-on answer for this agent request in fake mode, or None."""
    for a in loaded():
        if callable(a.fake):
            got = a.fake(req)
            if got:
                return got
    return None


def mount(app) -> None:
    for a in loaded():
        if a.router is not None:
            app.include_router(a.router)


def may_emit(kind: str) -> bool:
    """An add-on may emit its own event kinds only: '<name>.<something>'."""
    head = kind.split(".", 1)[0]
    return "." in kind and head in names()
