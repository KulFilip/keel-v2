"""keel-plugin rules lint: the checks of a rule pack for the marketplace (docs/plugins/23-rules-in-marketplace.md), without
keel, and the review the catalog lists for it.

A marketplace rule pack is one YAML file, `<name>-<version>.yaml` (or `rules/<name>/<version>.yaml` in the marketplace
repo), at most 64 KB, signed like a plugin. The shape (23 §1; the rules session owns it, so a field this tool does not
know is a warning, never an error):

    id: no-new-dependencies            the marketplace name (installed as .keel/rules/<id>.yaml)
    name: No new dependencies
    description: …                     optional
    rules:
      - id: no-install
        kind: bash                     bash | edit | read | mcp
        how: regex                     contains (bash) | glob (edit, read) | name (mcp) | regex
        match: ['\\bnpm\\s+install']   one pattern or a list
        phases: all                    all | in-flow | none | [green, refactor]   (left out: all)
        lanes: [web]                   optional
        except: ["**/*.lock"]          optional (edit, read)
        reason: Adding a package is a person's decision.

The review (keel's engine builds the same from the YAML, keel_engine.marketplace.kinds.pack_review): {rules,
kinds: {kind: count}, phases, lanes}.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from . import miniyaml
from .manifest import NAME, VERSION

MAX_SIZE = 64 << 10
KINDS = ("bash", "edit", "read", "mcp")
HOWS = ("contains", "glob", "name", "regex")
HOW_FOR = {"contains": ("bash",), "glob": ("edit", "read"), "name": ("mcp",), "regex": KINDS}
PHASES = ("all", "in-flow", "none")
PHASE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
PACK_KEYS = ("id", "name", "description", "rules")
RULE_KEYS = ("id", "kind", "how", "match", "phases", "lanes", "except", "reason")
FILE = re.compile(r"^(?P<name>[a-z][a-z0-9-]{0,31})-(?P<version>[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\.yaml$")


@dataclass
class RulesReport:
    target: str
    name: str | None = None              # the marketplace name (from the file name or --name)
    version: str | None = None           # the marketplace version
    title: str | None = None             # the pack's own name
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
        lines.append("ok" if self.ok else f"{len(self.errors)} error(s)")
        return "\n".join(lines)


def name_version(path: Path) -> tuple[str | None, str | None]:
    """<name>-<version>.yaml, or rules/<name>/<version>.yaml (the marketplace repo's own files)."""
    m = FILE.match(path.name)
    if m:
        return m.group("name"), m.group("version")
    if path.suffix == ".yaml" and VERSION.match(path.stem) and NAME.match(path.parent.name):
        return path.parent.name, path.stem
    return None, None


def _texts(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    return [x for x in value if isinstance(x, str)] if isinstance(value, list) else []


def review(doc) -> dict:
    """What a pack blocks, in short: {rules, kinds: {kind: count}, phases, lanes}, as keel's engine builds it
    (kinds.pack_review): a rule that is not a mapping is not counted, an unknown kind counts as itself, a rule without
    phases reads as "all"; phases and lanes in the order they first appear."""
    listed = doc.get("rules") if isinstance(doc, dict) else None
    rules = [r for r in listed if isinstance(r, dict)] if isinstance(listed, list) else []
    kinds: dict[str, int] = {}
    phases: list[str] = []
    lanes: list[str] = []
    for r in rules:
        kind = r.get("kind") if isinstance(r.get("kind"), str) and r.get("kind").strip() else "unknown"
        kinds[kind] = kinds.get(kind, 0) + 1
        for p in _texts(r.get("phases", "all")):
            if p not in phases:
                phases.append(p)
        for lane in _texts(r.get("lanes")):
            if lane not in lanes:
                lanes.append(lane)
    order = {k: i for i, k in enumerate(KINDS)}
    return {"rules": len(rules), "kinds": dict(sorted(kinds.items(), key=lambda kv: (order.get(kv[0], 99), kv[0]))),
            "phases": phases, "lanes": lanes}


def _text(v) -> bool:
    return isinstance(v, str) and bool(v.strip())


def _rule(r, i: int, ids: list[str], rep: RulesReport) -> None:
    where = f"rules[{i}]"
    if not isinstance(r, dict):
        rep.errors.append(f"{where} is not a mapping (id, kind, how, match, reason)")
        return
    rid = r.get("id")
    if not _text(rid):
        rep.errors.append(f"{where} has no id")
    else:
        where = f"rule {rid}"
        if rid in ids:
            rep.errors.append(f"{where}: two rules share this id")
        ids.append(rid)
    for key in r:
        if key not in RULE_KEYS:
            rep.warnings.append(f"{where}: '{key}' is not a rule field this tool knows ({', '.join(RULE_KEYS)})")
    kind = r.get("kind")
    if kind not in KINDS:
        rep.errors.append(f"{where}: kind {kind!r} is not one of {', '.join(KINDS)}")
    how = r.get("how")
    if how not in HOWS:
        rep.errors.append(f"{where}: how {how!r} is not one of {', '.join(HOWS)}")
    elif kind in KINDS and kind not in HOW_FOR[how]:
        rep.warnings.append(f"{where}: how {how} is for {', '.join(HOW_FOR[how])} rules, not {kind}")
    match = r.get("match")
    patterns = [match] if isinstance(match, str) else match
    if not isinstance(patterns, list) or not patterns or not all(_text(p) for p in patterns):
        rep.errors.append(f"{where}: match must be a pattern or a list of patterns")
    elif how == "regex":
        for p in patterns:
            try:
                re.compile(p)
            except re.error as exc:
                rep.errors.append(f"{where}: match {p!r} is not a regular expression: {exc}")
    phases = r.get("phases", "all")
    if isinstance(phases, str):
        if phases not in PHASES:
            rep.errors.append(f"{where}: phases {phases!r} is not one of {', '.join(PHASES)}, or a list of phases")
    elif not isinstance(phases, list) or not phases or not all(isinstance(p, str) and PHASE.match(p) for p in phases):
        rep.errors.append(f"{where}: phases must be all, in-flow, none, or a list of phase names like [green, refactor]")
    for key in ("lanes", "except"):
        v = r.get(key)
        if v is not None and (not isinstance(v, list) or not all(_text(x) for x in v)):
            rep.errors.append(f"{where}: {key} must be a list of text")
    if r.get("except") is not None and kind in ("bash", "mcp"):
        rep.warnings.append(f"{where}: except is for edit and read rules; a {kind} rule does not use it")
    if not _text(r.get("reason")):
        rep.errors.append(f"{where}: reason is missing (people see it when the rule refuses)")


def lint_text(text: str, target: str, name: str | None = None, version: str | None = None) -> RulesReport:
    rep = RulesReport(target, name, version)
    if name is None or not NAME.match(name):
        rep.errors.append("the file name must be <name>-<version>.yaml (name: a-z, 0-9 and '-', 32 at most; "
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
        rep.errors.append("a rule pack is a mapping with id, name and rules")
        return rep
    for key in doc:
        if key not in PACK_KEYS:
            rep.warnings.append(f"'{key}' is not a rule pack field this tool knows ({', '.join(PACK_KEYS)})")
    pid = doc.get("id")
    if not isinstance(pid, str) or not NAME.match(pid):
        rep.errors.append("id must be the pack's name (a-z, 0-9 and '-', 32 at most): keel installs it as "
                          ".keel/rules/<id>.yaml")
    elif name and NAME.match(name) and pid != name:
        rep.errors.append(f"id {pid} is not the marketplace name {name} (the file name, or --name)")
    if not _text(doc.get("name")):
        rep.errors.append("name is missing (the pack's name, as people see it)")
    else:
        rep.title = doc["name"].strip()
    if "description" in doc and not isinstance(doc["description"], str):
        rep.errors.append("description must be text")
    rules = doc.get("rules")
    if not isinstance(rules, list) or not rules:
        rep.errors.append("rules is missing: a pack has a list of rules")
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
    """Whether a release's .yaml is a rule pack (a mapping with a list of rules and no steps), not a workflow."""
    try:
        doc = miniyaml.loads(path.read_text(encoding="utf-8"))
    except (miniyaml.YamlError, UnicodeDecodeError, OSError):
        return False
    return isinstance(doc, dict) and isinstance(doc.get("rules"), list) and "steps" not in doc
