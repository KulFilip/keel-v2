"""keel-plugin rules lint: the checks of a rule pack for the marketplace (docs/plugins/23-rules-in-marketplace.md), without
keel, and the review the catalog lists for it.

A marketplace rule pack is one YAML file, `<name>-<version>.yaml` (or `rules/<name>/<version>.yaml` in the marketplace
repo), at most 64 KB, signed like a plugin, and **shipped unchanged**: it is the file keel installs as
`.keel/rules/<name>.yaml`. Its format is keel's final rule pack format (keel v2 0.17.2, docs/rules/pack-format.md,
schema 1), shaped like a plugin's keel-plugin.yml:

    schema: 1                          required
    kind: rules                        optional (default rules)
    name: no-new-dependencies          required: the id, the file name and the marketplace name ([a-z0-9-], 64 at most)
    title: No new dependencies         required
    version: 1.0.0                     required: the marketplace version
    publisher: keel                    required here: the entry's publisher (keel itself defaults it to local)
    summary: …                         optional: one sentence
    stack: node                        optional: a hint for people
    requires:                          optional
      keel: ">=0.17.2"                 a version range keel must meet
      plugins: {db: ">=1.0.0"}         plugin name → version range ('' = any); a list of names is also accepted
    rules:
      - id: no-install                 required, unique: [a-z0-9-]
        kind: bash                     bash | edit | read | mcp
        match: [npm install]           a text or a list of texts
        how: contains                  optional: contains | glob | name | regex (default: bash contains, edit/read
                                       glob, mcp name)
        phases: all                    optional: all | in-flow | none | a phase | [green, refactor]   (default all)
        lanes: [web]                   optional: api and/or web
        except: ["**/*.lock"]          optional (edit, read)
        reason: Adding a package is a person's decision.

The review (keel's engine builds the same from the YAML, keel_engine.marketplace.kinds.pack_review): {rules,
kinds: {kind: count}, phases, lanes, blocks: [{id, kind, match, how, phases, lanes?, except?}]}.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from . import miniyaml
from .manifest import VERSION, valid_spec

MAX_SIZE = 64 << 10
SCHEMA = 1
KINDS = ("bash", "edit", "read", "mcp")
HOWS = ("contains", "glob", "name", "regex")
DEFAULT_HOW = {"bash": "contains", "edit": "glob", "read": "glob", "mcp": "name"}
HOW_FOR = {"contains": ("bash",), "glob": ("edit", "read"), "name": ("mcp",), "regex": KINDS}
PHASES = ("all", "in-flow", "none")
PHASE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
LANES = ("api", "web")
PACK = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")          # a pack's name, a rule's id and a publisher (keel's ID)
PLUGIN = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
PACK_KEYS = ("schema", "kind", "name", "title", "version", "publisher", "summary", "stack", "requires", "rules")
RULE_KEYS = ("id", "kind", "match", "how", "phases", "lanes", "except", "reason")
FILE = re.compile(r"^(?P<name>[a-z0-9][a-z0-9-]{0,63})-(?P<version>[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\.yaml$")


@dataclass
class RulesReport:
    target: str
    name: str | None = None              # the marketplace name (from the file name or --name)
    version: str | None = None           # the marketplace version
    title: str | None = None             # the pack's title
    publisher: str | None = None         # the pack's publisher (the index checks it is the entry's)
    requires: dict = field(default_factory=dict)     # the pack's requires: {keel?, plugins?: {name: range}}
    review: dict | None = None
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def text(self) -> str:
        head = f"keel-plugin rules lint: {self.target}"
        if self.name and self.version:
            head += f" ({self.name} {self.version})"
        lines = [head]
        lines += [f"  error    {e}" for e in self.errors]
        lines += [f"  warning  {w}" for w in self.warnings]
        if self.review:
            r = self.review
            kinds = ", ".join(f"{k} {n}" for k, n in r["kinds"].items()) or "none"
            lines.append(f"  review   {r['rules']} rules ({kinds})")
            lines.append(f"  phases   {', '.join(r['phases']) or 'none'}")
            if r["lanes"]:
                lines.append(f"  lanes    {', '.join(r['lanes'])}")
            for b in r.get("blocks") or []:
                phases = b["phases"] if isinstance(b["phases"], str) else ", ".join(b["phases"])
                lines.append(f"  blocks   {b['id']}: {b['kind']} {b['how']} {', '.join(b['match'])} ({phases})")
        lines.append("ok" if self.ok else f"{len(self.errors)} error(s)")
        return "\n".join(lines)


def name_version(path: Path) -> tuple[str | None, str | None]:
    """<name>-<version>.yaml, or rules/<name>/<version>.yaml (the marketplace repo's own files)."""
    m = FILE.match(path.name)
    if m:
        return m.group("name"), m.group("version")
    if path.suffix == ".yaml" and VERSION.match(path.stem) and PACK.match(path.parent.name):
        return path.parent.name, path.stem
    return None, None


def _texts(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    return [x for x in value if isinstance(x, str)] if isinstance(value, list) else []


def _block(r: dict, kind: str) -> dict:
    how = r.get("how") if isinstance(r.get("how"), str) and r.get("how") else DEFAULT_HOW.get(kind, "contains")
    phases = r.get("phases", "all")
    if isinstance(phases, str) and phases not in PHASES:
        phases = [phases]
    out = {"id": r.get("id") if isinstance(r.get("id"), str) else "", "kind": kind, "match": _texts(r.get("match")),
           "how": how, "phases": phases if isinstance(phases, str) else _texts(phases)}
    for key in ("lanes", "except"):
        if r.get(key) is not None:
            out[key] = _texts(r.get(key))
    return out


def review(doc) -> dict:
    """What a pack blocks, in short: {rules, kinds: {kind: count}, phases, lanes, blocks}, as keel's engine builds it
    (kinds.pack_review): a rule that is not a mapping is not counted, an unknown kind counts as itself, a rule without
    phases reads as "all" (one phase name as a list of it), a rule without `how` takes its kind's default; phases and
    lanes in the order they first appear; `blocks` is what each rule blocks, in the pack's order."""
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
    order = {k: i for i, k in enumerate(KINDS)}
    return {"rules": len(rules), "kinds": dict(sorted(kinds.items(), key=lambda kv: (order.get(kv[0], 99), kv[0]))),
            "phases": phases, "lanes": lanes, "blocks": blocks}


def _text(v) -> bool:
    return isinstance(v, str) and bool(v.strip())


def _list(v) -> list[str] | None:
    """A text or a list of texts (as keel reads match, lanes and except), else None."""
    if isinstance(v, str):
        return [v]
    if isinstance(v, list) and all(isinstance(x, str) for x in v):
        return list(v)
    return None


def _rule(r, i: int, ids: list[str], rep: RulesReport) -> None:
    where = f"rules[{i}]"
    if not isinstance(r, dict):
        rep.errors.append(f"{where} is not a mapping (id, kind, match, reason)")
        return
    rid = r.get("id")
    if not _text(rid):
        rep.errors.append(f"{where} has no id")
    else:
        where = f"rule {rid}"
        if not PACK.match(rid):
            rep.errors.append(f"{where}: id must be lower-case letters, digits and dashes")
        if rid in ids:
            rep.errors.append(f"{where}: two rules share this id")
        ids.append(rid)
    for key in r:
        if key not in RULE_KEYS:
            rep.warnings.append(f"{where}: '{key}' is not a rule field this tool knows ({', '.join(RULE_KEYS)})")
    kind = r.get("kind")
    if kind not in KINDS:
        rep.errors.append(f"{where}: kind {kind!r} is not one of {', '.join(KINDS)}")
    how = r.get("how", DEFAULT_HOW.get(kind) if kind in KINDS else None)
    if how not in HOWS:
        rep.errors.append(f"{where}: how {how!r} is not one of {', '.join(HOWS)}")
    elif kind in KINDS and kind not in HOW_FOR[how]:
        rep.warnings.append(f"{where}: how {how} is for {', '.join(HOW_FOR[how])} rules, not {kind}")
    patterns = _list(r.get("match"))
    if not patterns or not all(_text(p) for p in patterns):
        rep.errors.append(f"{where}: match must be a pattern or a list of patterns")
    elif how == "regex":
        for p in patterns:
            try:
                re.compile(p)
            except re.error as exc:
                rep.errors.append(f"{where}: match {p!r} is not a regular expression: {exc}")
    phases = r.get("phases", "all")
    if isinstance(phases, str):
        if phases not in PHASES and not PHASE.match(phases):
            rep.errors.append(f"{where}: phases {phases!r} is not one of all, in-flow, none, a phase, or a list of phases")
    elif not isinstance(phases, list) or not phases or not all(isinstance(p, str) and PHASE.match(p) for p in phases):
        rep.errors.append(f"{where}: phases must be all, in-flow, none, or a list of phase names like [green, refactor]")
    lanes = r.get("lanes")
    if lanes is not None and (not _list(lanes) or any(x not in LANES for x in _list(lanes) or [])):
        rep.errors.append(f"{where}: lanes must be api and/or web")
    if r.get("except") is not None and _list(r.get("except")) is None:
        rep.errors.append(f"{where}: except must be a list of paths (globs)")
    if r.get("except") is not None and kind in ("bash", "mcp"):
        rep.warnings.append(f"{where}: except is for edit and read rules; a {kind} rule does not use it")
    if not _text(r.get("reason")):
        rep.errors.append(f"{where}: reason is missing (the agent reads it when the rule refuses)")


def _requires(doc: dict, rep: RulesReport) -> None:
    req = doc.get("requires")
    if req is None:
        return
    if not isinstance(req, dict):
        rep.errors.append("requires must be a mapping with keel (a version range) and plugins")
        return
    for key in req:
        if key not in ("keel", "plugins"):
            rep.warnings.append(f"requires.{key} is not a field this tool knows (keel, plugins)")
    keel = req.get("keel")
    if keel is not None and keel != "":
        if not isinstance(keel, str) or not valid_spec(keel):
            rep.errors.append(f"requires.keel must be a version range like '>=0.17.2' (got {keel!r})")
        else:
            rep.requires["keel"] = keel.strip()
    raw = req.get("plugins")
    if raw is None:
        return
    if isinstance(raw, list):
        raw = {p: "" for p in raw} if all(isinstance(p, str) for p in raw) else None
    if not isinstance(raw, dict):
        rep.errors.append("requires.plugins must be plugin names, or a mapping of plugin name to a version range")
        return
    plugins = {}
    for name, spec in raw.items():
        spec = "" if spec is None else spec
        if not isinstance(name, str) or not PLUGIN.match(name):
            rep.errors.append(f"requires.plugins: {name!r} is not a plugin name")
        elif not isinstance(spec, str) or (spec.strip() and not valid_spec(spec)):
            rep.errors.append(f"requires.plugins.{name} must be a version range like '>=1.0.0' (got {spec!r})")
        else:
            plugins[name] = spec.strip()
    if plugins:
        rep.requires["plugins"] = plugins


def lint_text(text: str, target: str, name: str | None = None, version: str | None = None) -> RulesReport:
    rep = RulesReport(target, name, version)
    if name is None or not PACK.match(name):
        rep.errors.append("the file name must be <name>-<version>.yaml (name: a-z, 0-9 and '-', 64 at most; "
                          "version like 1.2.0), or give --name and --version")
    if version is not None and not VERSION.match(version):
        rep.errors.append(f"version {version!r} is not a version like 1.2.0 or 1.2.0-beta.1")
    if len(text.encode("utf-8")) > MAX_SIZE:
        rep.errors.append(f"the file is bigger than {MAX_SIZE // 1024} KB")
    try:
        doc = miniyaml.loads(text)
    except miniyaml.YamlError as exc:
        rep.errors.append(f"the YAML does not read: {exc}")
        return rep
    if not isinstance(doc, dict):
        rep.errors.append("a rule pack is a mapping: schema, kind, name, title, version, publisher, rules")
        return rep
    for key in doc:
        if key not in PACK_KEYS:
            rep.warnings.append(f"'{key}' is not a rule pack field this tool knows ({', '.join(PACK_KEYS)})")
    if doc.get("schema") != SCHEMA:
        rep.errors.append(f"schema must be {SCHEMA} (the rule pack format's version, docs/rules/pack-format.md)")
    if doc.get("kind", "rules") != "rules":
        rep.errors.append("kind must be rules (a rule pack; a plugin has a keel-plugin.yml instead)")
    pid = doc.get("name")
    if not isinstance(pid, str) or not PACK.match(pid):
        rep.errors.append("name must be the pack's id (a-z, 0-9 and '-', 64 at most): keel installs it as "
                          ".keel/rules/<name>.yaml")
    elif name and PACK.match(name) and pid != name:
        rep.errors.append(f"name {pid} is not the marketplace name {name} (the file name, or --name)")
    if not _text(doc.get("title")):
        rep.errors.append("title is missing (a few words for people)")
    else:
        rep.title = doc["title"].strip()
    v = doc.get("version")
    if not isinstance(v, str) or not VERSION.match(v):
        rep.errors.append(f"version must be a version like 1.0.0 (got {v!r}; write it in quotes when YAML reads a number)")
    elif version and VERSION.match(version) and v != version:
        rep.errors.append(f"version {v} is not the marketplace version {version} (the file name, or --version)")
    pub = doc.get("publisher")
    if not _text(pub):
        rep.errors.append("publisher is missing: a marketplace pack names its publisher (the entry's publisher)")
    elif not PACK.match(pub):
        rep.errors.append(f"publisher {pub!r} must be lower-case letters, digits and dashes")
    else:
        rep.publisher = pub
    for key in ("summary", "stack"):
        if key in doc and not isinstance(doc[key], str):
            rep.errors.append(f"{key} must be text")
    _requires(doc, rep)
    rules = doc.get("rules")
    if not isinstance(rules, list) or not rules:
        rep.errors.append("rules is missing: a pack has a list of at least one rule")
        return rep
    ids: list[str] = []
    for i, r in enumerate(rules):
        _rule(r, i, ids, rep)
    rep.review = review(doc)
    return rep


def lint(path: Path, name: str | None = None, version: str | None = None) -> RulesReport:
    n, v = name_version(path)
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        rep = RulesReport(str(path), name or n, version or v)
        rep.errors.append("the file is not UTF-8 text")
        return rep
    return lint_text(text, str(path), name or n, version or v)


def is_pack(path: Path) -> bool:
    """Whether a release's .yaml is a rule pack (`kind: rules`, or a mapping with a list of rules and no steps), not a
    workflow."""
    try:
        doc = miniyaml.loads(path.read_text(encoding="utf-8"))
    except (miniyaml.YamlError, UnicodeDecodeError, OSError):
        return False
    if not isinstance(doc, dict):
        return False
    return doc.get("kind") == "rules" or (isinstance(doc.get("rules"), list) and "steps" not in doc)
