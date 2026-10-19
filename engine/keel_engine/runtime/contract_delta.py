"""The contract delta, endpoint by endpoint (keel v1 feature phase 2, "show the delta and ask before committing it").

A contract change can be valid and still wrong for someone who calls it. The contract gate lists each OpenAPI
operation as new, changed, or breaking callers (removed or narrowed):

    removed endpoint, removed response status, removed parameter          -> breaks callers
    a new required parameter, request field or request body                -> breaks callers
    a request field that became required, an enum that lost a value,
    a limit made tighter (maxLength, maximum, minLength ...)               -> breaks callers
    a response field removed, no longer required, or that may be null now  -> breaks callers
    a type that changed                                                    -> breaks callers
    anything else that differs (a new optional field, a new status code,
    an enum value added)                                                   -> changed

classify(old, new) takes two parsed documents (old None = the contract is new); load(text) parses YAML or JSON and
returns None for a file that is not an OpenAPI document (its delta is the plain diff).
"""

from __future__ import annotations

import json

import yaml

METHODS = ("get", "put", "post", "delete", "patch", "head", "options", "trace")
# request side: a lower max or a higher min refuses what callers sent before
TIGHTER = {"maxLength": -1, "maximum": -1, "maxItems": -1, "minLength": 1, "minimum": 1, "minItems": 1}


def load(text: str | None) -> dict | None:
    if not text or not str(text).strip():
        return None
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError:
        try:
            doc = json.loads(text)
        except ValueError:
            return None
    return doc if isinstance(doc, dict) and isinstance(doc.get("paths"), dict) else None


def _resolve(doc: dict, node, depth: int = 0):
    """A schema with its $ref ("#/components/schemas/X") followed; unknown refs stay as they are."""
    while isinstance(node, dict) and isinstance(node.get("$ref"), str) and node["$ref"].startswith("#/") and depth < 12:
        cur = doc
        for part in node["$ref"][2:].split("/"):
            cur = cur.get(part.replace("~1", "/").replace("~0", "~")) if isinstance(cur, dict) else None
        if not isinstance(cur, dict):
            return node
        node, depth = cur, depth + 1
    return node if isinstance(node, dict) else {}


def _ops(doc: dict | None) -> dict[tuple[str, str], dict]:
    out = {}
    for path, item in ((doc or {}).get("paths") or {}).items():
        item = _resolve(doc, item)
        shared = item.get("parameters") or []
        for m in METHODS:
            op = item.get(m)
            if isinstance(op, dict):
                out[(m.upper(), str(path))] = {**op, "parameters": list(shared) + list(op.get("parameters") or [])}
    return out


def _types(s: dict) -> set[str]:
    t = s.get("type")
    return set(t) if isinstance(t, list) else ({t} if t else set())


def _nullable(s: dict) -> bool:
    return bool(s.get("nullable")) or "null" in _types(s) or any(
        isinstance(x, dict) and x.get("type") == "null" for x in (s.get("oneOf") or s.get("anyOf") or []))


class _Delta:
    def __init__(self, old_doc: dict | None, new_doc: dict | None):
        self.od, self.nd = old_doc or {}, new_doc or {}
        self.breaks: list[str] = []
        self.changed: list[str] = []

    def schema(self, a, b, where: str, side: str, depth: int = 0) -> None:
        a, b = _resolve(self.od, a), _resolve(self.nd, b)
        if depth > 8 or a == b:
            return
        ta, tb = _types(a) - {"null"}, _types(b) - {"null"}
        if ta and tb and ta != tb:
            self.breaks.append(f"{where}: type {'/'.join(sorted(ta))} -> {'/'.join(sorted(tb))}")
            return
        if side == "response" and _nullable(b) and not _nullable(a):
            self.breaks.append(f"{where}: may be null now")
        ea, eb = a.get("enum"), b.get("enum")
        if isinstance(ea, list) and isinstance(eb, list):
            gone, added = [x for x in ea if x not in eb], [x for x in eb if x not in ea]
            if gone:
                self.breaks.append(f"{where}: enum narrowed, drops {', '.join(map(str, gone))}")
            if added:
                self.changed.append(f"{where}: enum adds {', '.join(map(str, added))}"
                                    + (" (a client that switches on it may not know it)" if side == "response" else ""))
        elif isinstance(eb, list) and not isinstance(ea, list) and side == "request":
            self.breaks.append(f"{where}: narrowed to the values {', '.join(map(str, eb))}")
        if side == "request":
            for k, sign in TIGHTER.items():
                va, vb = a.get(k), b.get(k)
                if isinstance(vb, (int, float)) and (va is None or (isinstance(va, (int, float)) and (vb - va) * sign > 0)):
                    self.breaks.append(f"{where}: narrowed ({k} {va if va is not None else 'none'} -> {vb})")
        pa, pb = a.get("properties") or {}, b.get("properties") or {}
        ra, rb = set(a.get("required") or []), set(b.get("required") or [])
        for name in pa:
            if name not in pb:
                (self.breaks if side == "response" else self.changed).append(f"{where}.{name}: removed")
        for name in pb:
            if name not in pa:
                if side == "request" and name in rb:
                    self.breaks.append(f"{where}.{name}: new required field")
                else:
                    self.changed.append(f"{where}.{name}: new field")
                continue
            if side == "request" and name in rb and name not in ra:
                self.breaks.append(f"{where}.{name}: now required")
            if side == "response" and name in ra and name not in rb:
                self.breaks.append(f"{where}.{name}: no longer required (may be missing)")
            self.schema(pa[name], pb[name], f"{where}.{name}", side, depth + 1)
        if a.get("items") or b.get("items"):
            self.schema(a.get("items") or {}, b.get("items") or {}, f"{where}[]", side, depth + 1)

    def body(self, op_a: dict, op_b: dict, where: str) -> None:
        ba, bb = _resolve(self.od, op_a.get("requestBody")), _resolve(self.nd, op_b.get("requestBody"))
        if bb and not ba:
            (self.breaks if bb.get("required") else self.changed).append(
                f"{where}: new {'required ' if bb.get('required') else ''}request body")
            return
        if ba and not bb:
            self.changed.append(f"{where}: request body removed")
            return
        if bb.get("required") and not ba.get("required"):
            self.breaks.append(f"{where}: request body is now required")
        self.schema(_media(ba), _media(bb), f"{where} request body", "request")

    def params(self, op_a: dict, op_b: dict, where: str) -> None:
        def by(doc, op):
            return {(p.get("in"), p.get("name")): p for p in (_resolve(doc, x) for x in op.get("parameters") or []) if p.get("name")}
        pa, pb = by(self.od, op_a), by(self.nd, op_b)
        for key, p in pb.items():
            label = f"{where}: parameter {key[1]} ({key[0]})"
            if key not in pa:
                (self.breaks if p.get("required") else self.changed).append(label + (" new and required" if p.get("required") else " new"))
                continue
            if p.get("required") and not pa[key].get("required"):
                self.breaks.append(label + " now required")
            self.schema(pa[key].get("schema") or {}, p.get("schema") or {}, f"{where} parameter {key[1]}", "request")
        for key in pa:
            if key not in pb:
                self.breaks.append(f"{where}: parameter {key[1]} ({key[0]}) removed")

    def responses(self, op_a: dict, op_b: dict, where: str) -> None:
        ra, rb = op_a.get("responses") or {}, op_b.get("responses") or {}
        for code in ra:
            if code not in rb:
                self.breaks.append(f"{where}: response {code} removed")
        for code in rb:
            if code not in ra:
                self.changed.append(f"{where}: new response {code} (a client's error handling may not expect it)")
                continue
            self.schema(_media(_resolve(self.od, ra[code])), _media(_resolve(self.nd, rb[code])), f"{where} response {code}", "response")


def _media(part: dict) -> dict:
    """The schema of a request body or response: the JSON media type's, else the first one's."""
    content = (part or {}).get("content") or {}
    if not isinstance(content, dict) or not content:
        return {}
    key = next((k for k in content if "json" in k), next(iter(content)))
    return (content.get(key) or {}).get("schema") or {}


def classify(old: dict | None, new: dict | None) -> dict[str, list[str]]:
    """{new: [operations], changed: [what], breaks: [what]} between two OpenAPI documents."""
    oa, ob = _ops(old), _ops(new)
    d = _Delta(old, new)
    added = [f"{m} {p}" for (m, p) in ob if (m, p) not in oa]
    for (m, p) in oa:
        if (m, p) not in ob:
            d.breaks.append(f"{m} {p}: endpoint removed")
    for key in ob:
        if key in oa:            # a $ref'd schema may have changed even when the operation's own text did not
            where = f"{key[0]} {key[1]}"
            d.params(oa[key], ob[key], where)
            d.body(oa[key], ob[key], where)
            d.responses(oa[key], ob[key], where)
    return {"new": added, "changed": list(dict.fromkeys(d.changed)), "breaks": list(dict.fromkeys(d.breaks))}


def describe(file: str, delta: dict[str, list[str]] | None, removed_lines: int = 0) -> list[str]:
    """The gate's lines for one contract file: breaks first (the half that breaks callers), then new and changed."""
    if delta is None:
        return [f"{file}: not an OpenAPI document, so keel cannot sort it endpoint by endpoint: read the diff below."
                + (f" Its {removed_lines} removed line(s) (-) are the ones that can break callers." if removed_lines else "")]
    out = [f"{file}:"]
    if not any(delta.values()):
        return out + ["  no operation changed (descriptions or examples only)"]
    out += ["  Breaks callers (removed or narrowed):"] + [f"  - {x}" for x in delta["breaks"]] if delta["breaks"] else \
        ["  Breaks callers: nothing removed or narrowed"]
    if delta["new"]:
        out += ["  New:"] + [f"  - {x}" for x in delta["new"]]
    if delta["changed"]:
        out += ["  Changed:"] + [f"  - {x}" for x in delta["changed"]]
    return out
