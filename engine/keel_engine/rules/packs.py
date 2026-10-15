"""Rule packs: a project's own rules, as YAML files in `.keel/rules/<id>.yaml` (docs/plans/0.16.2.md).

    id: no-new-dependencies
    name: No new dependencies
    description: Agents never add a package; a person does.
    rules:
      - id: no-install
        kind: bash                   # bash | edit | read | mcp
        match: [npm install, pnpm add]
        how: contains                # contains (bash) | glob (edit, read) | name (mcp) | regex
        phases: all                  # all | in-flow | none | [green, refactor]
        lanes: [web]                 # optional: only in this lane (red/green of a web AC)
        except: ["**/*.lock"]        # optional, edit/read: these paths pass
        reason: Adding a package is a person's decision.

A pack rule only refuses. `load_config` reads the packs, so the PreToolUse hook, the ToolBox and the diff guard all
apply them through `check_edit` / `check_read` / `check_bash` / `hook.check_mcp`. `rules.off: [pack/<id>]` switches a
whole pack off.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

from . import PHASES, Verdict, match_glob

KINDS = ("bash", "edit", "read", "mcp")
HOWS = ("contains", "regex", "glob", "name")
DEFAULT_HOW = {"bash": "contains", "edit": "glob", "read": "glob", "mcp": "name"}
LANES = ("api", "web")
ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
FOLDER = Path(".keel") / "rules"
MAX_BYTES = 64 * 1024


def folder(root: str | Path) -> Path:
    return Path(root) / FOLDER


def parse_pack(text: str) -> tuple[dict | None, list[str]]:
    """(the pack, normalised) or (None, the errors)."""
    if len(str(text or "").encode()) > MAX_BYTES:
        return None, [f"a rule pack is at most {MAX_BYTES // 1024} KB"]
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        return None, [f"not valid YAML: {str(exc).splitlines()[0]}"]
    return validate_pack(data)


def _list(v: Any) -> list[str] | None:
    if isinstance(v, str):
        return [v]
    if isinstance(v, list) and all(isinstance(x, str) for x in v):
        return list(v)
    return None


def validate_pack(data: Any) -> tuple[dict | None, list[str]]:
    errors: list[str] = []
    if not isinstance(data, dict):
        return None, ["a rule pack is a YAML map with id, name and rules"]
    pid = str(data.get("id") or "")
    if not ID.match(pid):
        errors.append("id: lower-case letters, digits and dashes (it is the file name)")
    if not str(data.get("name") or "").strip():
        errors.append("name: say in a few words what the pack does")
    raw = data.get("rules")
    if not isinstance(raw, list) or not raw:
        errors.append("rules: a list with at least one rule")
        raw = []
    out: list[dict] = []
    seen: set[str] = set()
    for n, r in enumerate(raw, 1):
        where = f"rules[{n}]"
        if not isinstance(r, dict):
            errors.append(f"{where}: a rule is a map (id, kind, match, reason)")
            continue
        rid = str(r.get("id") or "")
        if not ID.match(rid):
            errors.append(f"{where}.id: lower-case letters, digits and dashes")
        elif rid in seen:
            errors.append(f"{where}.id: {rid} is used twice")
        seen.add(rid)
        kind = r.get("kind")
        if kind not in KINDS:
            errors.append(f"{where}.kind: one of {', '.join(KINDS)}")
            kind = "bash"
        match = _list(r.get("match"))
        if not match or not all(m.strip() for m in match):
            errors.append(f"{where}.match: a text or a list of texts")
            match = []
        how = r.get("how") or DEFAULT_HOW[kind]
        if how not in HOWS:
            errors.append(f"{where}.how: one of {', '.join(HOWS)}")
        elif how == "regex":
            for m in match:
                try:
                    re.compile(m)
                except re.error as exc:
                    errors.append(f"{where}.match: {m!r} is not a regular expression ({exc})")
        phases = r.get("phases", "all")
        if isinstance(phases, str) and phases not in ("all", "in-flow", "none"):
            phases = [phases]
        if isinstance(phases, list):
            bad = [p for p in phases if p not in PHASES and p != "none"]
            if bad or not phases:
                errors.append(f"{where}.phases: all, in-flow, none or a list of keel phases (unknown: {', '.join(map(str, bad))})")
        lanes = r.get("lanes")
        if lanes is not None and (not _list(lanes) or any(x not in LANES for x in _list(lanes) or [])):
            errors.append(f"{where}.lanes: api and/or web")
        exc_ = r.get("except")
        if exc_ is not None and _list(exc_) is None:
            errors.append(f"{where}.except: a list of paths (globs)")
        if not str(r.get("reason") or "").strip():
            errors.append(f"{where}.reason: say in plain words why it is refused (the agent reads it)")
        out.append({"id": rid, "kind": kind, "match": match, "how": how, "phases": phases,
                    **({"lanes": _list(lanes)} if lanes is not None else {}),
                    **({"except": _list(exc_)} if exc_ is not None else {}),
                    "reason": str(r.get("reason") or "").strip()})
    if errors:
        return None, errors
    return {"id": pid, "name": str(data["name"]).strip(), "description": str(data.get("description") or "").strip(),
            **({"stack": str(data["stack"])} if data.get("stack") else {}), "rules": out}, []


def load_packs(root: str | Path | None) -> tuple[list[dict], list[dict]]:
    """The project's packs ({..., file}) and the files that could not be used ([{file, errors}])."""
    if not root:
        return [], []
    d = folder(root)
    if not d.is_dir():
        return [], []
    packs, errors = [], []
    for f in sorted(d.glob("*.y*ml")):
        rel = f"{FOLDER.as_posix()}/{f.name}"
        try:
            pack, errs = parse_pack(f.read_text())
        except OSError as exc:
            pack, errs = None, [str(exc)]
        if pack and pack["id"] != f.stem:
            pack, errs = None, [f"id {pack['id']} is not the file name {f.stem}"]
        if pack:
            packs.append({**pack, "file": rel})
        else:
            errors.append({"file": rel, "errors": errs})
    return packs, errors


def phase_ok(phases: Any, phase: str | None) -> bool:
    none = phase in (None, "", "none")
    if phases in (None, "all"):
        return True
    if phases == "in-flow":
        return not none
    if phases == "none":
        return none
    return ("none" if none else phase) in (phases or [])


def matches(rule: dict, target: str) -> bool:
    how = rule.get("how") or DEFAULT_HOW.get(rule.get("kind"), "contains")
    t = str(target or "")
    for m in rule.get("match") or []:
        if how == "contains" and m in t:
            return True
        if how == "regex" and re.search(m, t):
            return True
        if how == "glob" and match_glob(t, [m]):
            return True
        if how == "name" and m in t:
            return True
    return False


def pack_verdict(cfg: dict | None, kind: str, phase: str | None, target: str, lane: str | None = None,
                 packs: list[dict] | None = None) -> Verdict | None:
    """The first pack rule of this kind that refuses `target` (a path, a command or an MCP tool name), else None."""
    off = set(((cfg or {}).get("rules") or {}).get("off") or [])
    for p in (cfg or {}).get("packs") or [] if packs is None else packs:
        if f"pack/{p['id']}" in off:
            continue
        for r in p.get("rules") or []:
            if r.get("kind") != kind or not phase_ok(r.get("phases"), phase):
                continue
            if r.get("lanes") and lane not in r["lanes"]:
                continue
            if not matches(r, target):
                continue
            if r.get("except") and match_glob(target, r["except"]):
                continue
            ref = f"(rule {p['id']}/{r['id']})"
            text = f"{target}: {r['reason']} {ref}" if kind in ("edit", "read") else f"{r['reason']} {ref}"
            return Verdict(False, "pack", text)
    return None
