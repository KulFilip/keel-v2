"""The kinds of a catalog's entries (docs/plugins/23-rules-in-marketplace.md §2): one table, one row per kind.

    kind       list         file      max size   review                                       install goes to
    plugin     plugins      .kplug    200 MB     permissions (each version's), trust          the plugin store (restart)
    workflow   workflows    .yaml     256 KB     steps, gates, agents, mcp, commands, edits   the api's workflows table
    rules      rules        .yaml      64 KB     rules by kind, phases, lanes, what each      the rules api (per project)
                                                 rule blocks

Each row gives its list name, its file suffix, its size limit, its categories, the check of a version's catalog
`review`, and its own checks of an entry and a version (the hooks below). catalog.py reads every list through this
table; the signatures, publisher keys, trust, expiry, revoked (by `kind`), search and the Sources stay shared. A new
kind is one more row (and its install call).

The problems a broken entry gets keep the words of 0.16 / 0.17 (a plugin's without a prefix, a workflow's with
"workflow "), so an index reads exactly as before.

Rule packs: a pack is one YAML file in the final format of keel 0.17.2 (docs/rules/pack-format.md, schema 1), shaped
like a plugin's keel-plugin.yml so the marketplace ships it unchanged:

    schema: 1
    kind: rules                    a rule pack, not a plugin
    name: no-new-dependencies      the id, the file name (.keel/rules/<name>.yaml) and the marketplace name
    title: No new dependencies
    version: 1.0.0
    publisher: keel
    summary: ...
    requires: {keel: ">=0.17.2", plugins: {...} or [...]}
    rules: [{id, kind: bash|edit|read|mcp, match, how?, phases?, lanes?, except?, reason}]

A pack's name follows the pack rule ([a-z0-9-], at most 64: PACK_NAME), not the plugin rule. `pack_review` summarises
one for the catalog's review, read-only and tolerant of fields it does not know: the rules by kind, the phases and lanes,
and what each rule blocks (`blocks`). keel's own parser (keel_engine.rules.packs) checks a fetched pack before install.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable

from ..addons import NAME

AGENT = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
TRUST = ("content", "web", "code")
RESERVED = ("workflows", "rules", "refresh")     # /api/marketplace/<these> are keel's routes, never a plugin's page
RULE_KINDS = ("bash", "edit", "read", "mcp")
PACK_NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")      # a rule pack's name (docs/rules/pack-format.md)
DEFAULT_HOW = {"bash": "contains", "edit": "glob", "read": "glob", "mcp": "name"}


# ------------------------------------------------------------------ what an entry reads as, per kind

@dataclass
class Version:
    version: str
    released: str
    sdk: int
    keel: str
    plugins: dict[str, str]
    url: str
    sha256: str
    size: int
    permissions: dict

    def requires(self) -> dict:
        out: dict = {"sdk": self.sdk}
        if self.keel:
            out["keel"] = self.keel
        if self.plugins:
            out["plugins"] = dict(self.plugins)
        return out

    def view(self) -> dict:
        return {"version": self.version, "released": self.released, "requires": self.requires(), "url": self.url,
                "sha256": self.sha256, "size": self.size, "permissions": self.permissions}


@dataclass
class Entry:
    name: str
    title: str
    publisher: str
    category: str
    summary: str
    tags: list[str]
    repo: str
    trust: str
    versions: list[Version]       # newest first
    source: str

    def version(self, v: str) -> Version | None:
        return next((x for x in self.versions if x.version == v), None)


@dataclass
class WorkflowVersion:
    version: str
    released: str
    keel: str
    plugins: dict[str, str]
    agents: list[str]
    url: str
    sha256: str
    size: int
    review: dict

    def requires(self) -> dict:
        out: dict = {}
        if self.keel:
            out["keel"] = self.keel
        if self.plugins:
            out["plugins"] = dict(self.plugins)
        if self.agents:
            out["agents"] = list(self.agents)
        return out

    def view(self) -> dict:
        return {"version": self.version, "released": self.released, "requires": self.requires(),
                "review": dict(self.review), "url": self.url, "size": self.size, "sha256": self.sha256}


@dataclass
class WorkflowEntry:
    name: str
    title: str
    publisher: str
    category: str
    summary: str
    tags: list[str]
    repo: str
    versions: list[WorkflowVersion]     # newest first
    source: str
    kind: str = "workflow"

    def version(self, v: str) -> WorkflowVersion | None:
        return next((x for x in self.versions if x.version == v), None)


@dataclass
class RulesVersion:
    version: str
    released: str
    keel: str
    plugins: dict[str, str]
    url: str
    sha256: str
    size: int
    review: dict

    def requires(self) -> dict:
        out: dict = {}
        if self.keel:
            out["keel"] = self.keel
        if self.plugins:
            out["plugins"] = dict(self.plugins)
        return out

    def view(self) -> dict:
        return {"version": self.version, "released": self.released, "requires": self.requires(),
                "review": _copy(self.review), "url": self.url, "size": self.size, "sha256": self.sha256}


@dataclass
class RulesEntry:
    name: str
    title: str
    publisher: str
    category: str
    summary: str
    tags: list[str]
    repo: str
    versions: list[RulesVersion]        # newest first
    source: str
    kind: str = "rules"

    def version(self, v: str) -> RulesVersion | None:
        return next((x for x in self.versions if x.version == v), None)


def _copy(review: dict) -> dict:
    return {k: (dict(v) if isinstance(v, dict) else list(v) if isinstance(v, list) else v) for k, v in review.items()}


# ------------------------------------------------------------------ the table

def _none(*_args) -> dict:
    return {}


@dataclass(frozen=True)
class Kind:
    name: str                   # plugin | workflow | rules: an entry's and a revoked entry's `kind`
    list: str                   # the index's list: plugins | workflows | rules
    noun: str                   # in a problem: "plugin name 'X' does not follow …"
    label: str                  # before an entry's name in its problems ("" for plugins, as in 0.16)
    suffix: str                 # the file a version downloads
    max_size: int               # bytes
    categories: tuple[str, ...]  # an unknown one reads as "other"
    entry_type: type
    version_type: type
    # hooks: each raises ValueError (the entry or the version is left out) or gives the fields of its own
    precheck: Callable[[dict], None]                    # an entry, before its name
    check_name: Callable[[dict, str], None]             # an entry, after its name
    check_entry: Callable[[dict, str], dict]            # an entry's own fields (plugins: trust)
    check_requires: Callable[[dict, str], dict]         # a version's requires, before keel's range (plugins: sdk)
    check_version: Callable[[dict, dict, str], dict]    # a version's own fields (raw, requires, where)
    summarise: Callable[[Any], dict] | None = None      # a file's review, as the catalog lists it (rules)
    name_rule: re.Pattern = NAME                        # an entry's name (rules: a pack's name, PACK_NAME)


def _kind_named(kind: str, lst: str, label: str) -> Callable[[dict, str], None]:
    def check(raw: dict, name: str) -> None:
        if raw.get("kind", kind) != kind:
            raise ValueError(f"{label}{name}: its kind is {raw.get('kind')!r}, in the {lst} list")
    return check


# -- plugin

def _plugin_precheck(raw: dict) -> None:
    if raw.get("kind", "plugin") != "plugin":
        raise ValueError(f"{raw.get('name')!r}: its kind is {raw.get('kind')!r}, in the plugins list")


def _plugin_name(_raw: dict, name: str) -> None:
    if name in RESERVED:
        raise ValueError(f"plugin name {name!r} is taken by keel (/api/marketplace/{name} is the {name} list)")


def _plugin_entry(raw: dict, name: str) -> dict:
    trust = raw.get("trust")
    if trust not in TRUST:
        raise ValueError(f"{name}: trust {trust!r} is not content, web or code")
    return {"trust": trust}


def _plugin_requires(req: dict, where: str) -> dict:
    sdk = req.get("sdk", 1)
    if isinstance(sdk, bool) or not isinstance(sdk, int):
        raise ValueError(f"{where}: requires.sdk is not a whole number")
    return {"sdk": sdk}


def _plugin_version(raw: dict, _req: dict, where: str) -> dict:
    perms = raw.get("permissions") or {}
    if not isinstance(perms, dict):
        raise ValueError(f"{where}: permissions is not an object")
    return {"permissions": perms}


# -- workflow

def names(value, where: str, what: str, rule=NAME) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(x, str) and rule.match(x) for x in value):
        raise ValueError(f"{where}: {what} must be a list of names")
    return list(value)


def workflow_review(raw, where: str) -> dict:
    """A workflow version's Install review as the catalog's sync computed it: {steps, gates, agents, mcp, commands,
    edits_files, keel_rules}."""
    if not isinstance(raw, dict):
        raise ValueError(f"{where}: review is missing (steps, gates, agents, mcp, commands, edits_files, keel_rules)")
    out: dict = {}
    for key in ("steps", "gates"):
        v = raw.get(key)
        if isinstance(v, bool) or not isinstance(v, int) or v < 0:
            raise ValueError(f"{where}: review.{key} is not a whole number")
        out[key] = v
    for key in ("agents", "mcp", "commands"):
        v = raw.get(key) if raw.get(key) is not None else []
        if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
            raise ValueError(f"{where}: review.{key} is not a list of text")
        out[key] = list(v)
    for key in ("edits_files", "keel_rules"):
        v = raw.get(key)
        if not isinstance(v, bool):
            raise ValueError(f"{where}: review.{key} is not true or false")
        out[key] = v
    return out


def _workflow_version(raw: dict, req: dict, where: str) -> dict:
    agents = names(req.get("agents"), where, "requires.agents", AGENT)
    return {"agents": agents, "review": workflow_review(raw.get("review"), where)}


# -- rules

def _count(v) -> bool:
    return not isinstance(v, bool) and isinstance(v, int) and v >= 0


def _phases_ok(v) -> bool:
    return isinstance(v, str) or (isinstance(v, list) and all(isinstance(x, str) for x in v))


def _blocks(raw, rules: int, where: str) -> list[dict]:
    """review.blocks: what each rule blocks, one per rule: {id, kind, match: [text], how, phases} (+ lanes, except)."""
    if not isinstance(raw, list) or len(raw) != rules:
        raise ValueError(f"{where}: review.blocks is not one item per rule")
    out = []
    for b in raw:
        if not (isinstance(b, dict) and all(isinstance(b.get(k), str) for k in ("id", "kind", "how"))
                and isinstance(b.get("match"), list) and all(isinstance(m, str) for m in b["match"])
                and _phases_ok(b.get("phases"))):
            raise ValueError(f"{where}: review.blocks has an item that is not {{id, kind, match, how, phases}}")
        item = {"id": b["id"], "kind": b["kind"], "match": list(b["match"]), "how": b["how"],
                "phases": b["phases"] if isinstance(b["phases"], str) else list(b["phases"])}
        for key in ("lanes", "except"):
            if isinstance(b.get(key), list) and all(isinstance(x, str) for x in b[key]):
                item[key] = list(b[key])
        out.append(item)
    return out


def rules_review(raw, where: str) -> dict:
    """A rule pack version's review as the catalog's sync computed it: {rules, kinds: {kind: count}, phases, lanes,
    blocks?}. `blocks` (what each rule blocks) is optional: a catalog built before it reads without it. Other keys are
    left out (a newer sync may add some)."""
    if not isinstance(raw, dict):
        raise ValueError(f"{where}: review is missing (rules, kinds, phases, lanes)")
    if not _count(raw.get("rules")):
        raise ValueError(f"{where}: review.rules is not a whole number")
    kinds = raw.get("kinds") if raw.get("kinds") is not None else {}
    if not isinstance(kinds, dict) or not all(isinstance(k, str) and _count(n) for k, n in kinds.items()):
        raise ValueError(f"{where}: review.kinds is not a count per kind of rule")
    if sum(kinds.values()) != raw["rules"]:
        raise ValueError(f"{where}: review.kinds does not add up to review.rules")
    out: dict = {"rules": raw["rules"], "kinds": dict(kinds)}
    for key in ("phases", "lanes"):
        v = raw.get(key) if raw.get(key) is not None else []
        if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
            raise ValueError(f"{where}: review.{key} is not a list of text")
        out[key] = list(v)
    if raw.get("blocks") is not None:
        out["blocks"] = _blocks(raw["blocks"], raw["rules"], where)
    return out


def _rules_version(raw: dict, _req: dict, where: str) -> dict:
    return {"review": rules_review(raw.get("review"), where)}


def _texts(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    return [x for x in value if isinstance(x, str)] if isinstance(value, list) else []


def _block(r: dict, kind: str) -> dict:
    how = r.get("how") if isinstance(r.get("how"), str) and r.get("how") else DEFAULT_HOW.get(kind, "contains")
    phases = r.get("phases", "all")
    if isinstance(phases, str) and phases not in ("all", "in-flow", "none"):
        phases = [phases]
    out = {"id": r.get("id") if isinstance(r.get("id"), str) else "", "kind": kind, "match": _texts(r.get("match")),
           "how": how, "phases": phases if isinstance(phases, str) else _texts(phases)}
    for key in ("lanes", "except"):
        if r.get(key) is not None:
            out[key] = _texts(r.get(key))
    return out


def pack_review(doc) -> dict:
    """What a rule pack blocks, in short (23 §2's review): {rules, kinds: {kind: count}, phases, lanes, blocks}.
    Read-only and tolerant: a rule that is not a mapping is not counted, an unknown kind counts as itself, a rule
    without phases reads as "all" (one phase name reads as a list of it), a rule without `how` takes its kind's
    default; the phases and lanes are listed in the order they first appear; `blocks` is what each rule blocks
    ({id, kind, match, how, phases, lanes?, except?}, in the pack's order)."""
    listed = doc.get("rules") if isinstance(doc, dict) else None
    rules = [r for r in listed if isinstance(r, dict)] if isinstance(listed, list) else []
    kinds: dict[str, int] = {}
    phases: list[str] = []
    lanes: list[str] = []
    blocks: list[dict] = []
    for r in rules:
        kind = r.get("kind") if isinstance(r.get("kind"), str) and r.get("kind").strip() else "unknown"
        kinds[kind] = kinds.get(kind, 0) + 1
        for p in _texts(r.get("phases", "all")):
            if p not in phases:
                phases.append(p)
        for lane in _texts(r.get("lanes")):
            if lane not in lanes:
                lanes.append(lane)
        blocks.append(_block(r, kind))
    order = {k: i for i, k in enumerate(RULE_KINDS)}
    return {"rules": len(rules), "kinds": dict(sorted(kinds.items(), key=lambda kv: (order.get(kv[0], 99), kv[0]))),
            "phases": phases, "lanes": lanes, "blocks": blocks}


# -- the rows

PLUGIN = Kind("plugin", "plugins", "plugin", "", ".kplug", 200 << 20,
              ("code", "knowledge", "tickets", "review", "product", "other"), Entry, Version,
              _plugin_precheck, _plugin_name, _plugin_entry, _plugin_requires, _plugin_version)
WORKFLOW = Kind("workflow", "workflows", "workflow", "workflow ", ".yaml", 256 << 10,
                ("code", "review", "docs", "release", "quality", "ops", "other"), WorkflowEntry, WorkflowVersion,
                lambda _raw: None, _kind_named("workflow", "workflows", "workflow "), _none, _none, _workflow_version)
RULES = Kind("rules", "rules", "rule pack", "rule pack ", ".yaml", 64 << 10,
             ("safety", "code", "git", "files", "secrets", "other"), RulesEntry, RulesVersion,
             lambda _raw: None, _kind_named("rules", "rules", "rule pack "), _none, _none, _rules_version,
             summarise=pack_review, name_rule=PACK_NAME)

TABLE: tuple[Kind, ...] = (PLUGIN, WORKFLOW, RULES)
BY_NAME: dict[str, Kind] = {k.name: k for k in TABLE}
NAMES: tuple[str, ...] = tuple(BY_NAME)
