"""The contract delta, field by field (keel v1 feature phase 2, "show the delta and ask before committing it").

A contract change can be valid and still wrong for someone who calls it, or for a message already in a queue. Two kinds
of contract are sorted:

OpenAPI documents, each operation as new, changed, or breaking callers (removed or narrowed):

    removed endpoint, removed response status, removed parameter          -> breaks callers
    a new required parameter, request field or request body                -> breaks callers
    a request field that became required, an enum that lost a value,
    a limit made tighter (maxLength, maximum, minLength ...)               -> breaks callers
    a response field removed, no longer required, or that may be null now  -> breaks callers
    a type that changed                                                    -> breaks callers
    anything else that differs (a new optional field, a new status code,
    an enum value added)                                                   -> changed

JSON Schema documents (message contracts: config/contracts/**/*.json, or any file with "$schema" / "properties"),
property by property, for a rolling deploy where old and new producers and consumers live side by side:

    a new optional property                                  -> new, safe (old messages without it stay valid)
    a new required property, an old one now required        -> breaks old producers (their messages lack it)
    a removed property, one no longer required               -> breaks consumers that read it
    a type narrowed (fewer types, number -> integer, a new
    enum, const or format, a tighter limit)                  -> breaks (old messages fail)
    a type widened (more types, null allowed)                -> safe
    additionalProperties true -> false                       -> breaks old producers that send other fields
    additionalProperties false -> true                       -> safe

classify(old, new) / classify_schema(old, new) take two parsed documents (old None = the contract is new) and return
{kind, new, changed, breaks, rows}; each row is {field, change, type, required, safe, why, desc}. load(text) parses an
OpenAPI document, load_schema(text, path) a JSON Schema; both return None for anything else. describe(...) writes the
gate's Markdown for one file: its plain-words sentence, its table and its verdict.
"""

from __future__ import annotations

import json
import re

import yaml

from .md import code, safe_words, table

METHODS = ("get", "put", "post", "delete", "patch", "head", "options", "trace")
# request side: a lower max or a higher min refuses what callers sent before
TIGHTER = {"maxLength": -1, "maximum": -1, "maxItems": -1, "minLength": 1, "minimum": 1, "minItems": 1,
           "exclusiveMaximum": -1, "exclusiveMinimum": 1, "maxProperties": -1, "minProperties": 1}
CONTRACT_DIR = re.compile(r"(^|/)contracts?/.+\.(json|ya?ml)$")


def _parse(text: str | None):
    if not text or not str(text).strip():
        return None
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError:
        try:
            return json.loads(text)
        except ValueError:
            return None


def load(text: str | None) -> dict | None:
    doc = _parse(text)
    return doc if isinstance(doc, dict) and isinstance(doc.get("paths"), dict) else None


def load_schema(text: str | None, path: str = "") -> dict | None:
    """A JSON Schema document (not OpenAPI): "properties", a json-schema.org "$schema", or a schema-looking file under a
    contracts/ folder."""
    doc = _parse(text)
    if not isinstance(doc, dict) or isinstance(doc.get("paths"), dict) or "openapi" in doc or "swagger" in doc:
        return None
    if isinstance(doc.get("properties"), dict) or "json-schema" in str(doc.get("$schema") or ""):
        return doc
    if CONTRACT_DIR.search(str(path)) and any(k in doc for k in ("type", "$defs", "definitions", "oneOf", "anyOf", "allOf", "$ref")):
        return doc
    return None


def _resolve(doc: dict, node, depth: int = 0):
    """A schema with its $ref ("#/components/schemas/X", "#/$defs/X") followed; unknown refs stay as they are."""
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
    out = set(t) if isinstance(t, list) else ({t} if isinstance(t, str) else set())
    for x in s.get("oneOf") or s.get("anyOf") or []:
        if isinstance(x, dict) and isinstance(x.get("type"), str):
            out.add(x["type"])
    if s.get("nullable") and out:
        out.add("null")
    return out


def _nullable(s: dict) -> bool:
    return "null" in _types(s) or bool(s.get("nullable"))


def _or(ts) -> str:
    ts = set(ts)
    return " or ".join(sorted(ts - {"null"}) + (["null"] if "null" in ts else []))


def _type_text(s: dict) -> str:
    if not isinstance(s, dict) or not s:
        return ""
    if isinstance(s.get("$ref"), str):
        return s["$ref"].rsplit("/", 1)[-1]
    out = _or(_types(s))
    if isinstance(s.get("enum"), list):
        out = f"{out or 'one of'} ({', '.join(map(str, s['enum'][:6]))}{', …' if len(s['enum']) > 6 else ''})"
    if s.get("format"):
        out += f", {s['format']}"
    if out == "array" and isinstance(s.get("items"), dict) and _type_text(s["items"]):
        out = f"array of {_type_text(s['items'])}"
    return out


def _desc(s: dict) -> str:
    d = str((s or {}).get("description") or "").strip().split("\n")[0].rstrip(".")
    if len(d) > 70:
        d = d[:67].rstrip() + "…"
    if d and d[0].isupper() and (len(d) == 1 or not d[1].isupper()):
        d = d[0].lower() + d[1:]
    return d


def _wider(ta: set, tb: set) -> bool:
    """Every old value is still valid: more types, or integer -> number."""
    return all(t in tb or (t == "integer" and "number" in tb) for t in ta)


class _Delta:
    """Rows of one contract: {field, change, type, required, safe, why, desc}; breaks / changed are their one-line form."""

    def __init__(self, old_doc: dict | None, new_doc: dict | None):
        self.od, self.nd = old_doc or {}, new_doc or {}
        self.rows: list[dict] = []

    def add(self, field: str, change: str, *, safe: bool, schema: dict | None = None, required: bool | None = None,
            why: str = "", desc: str = "") -> None:
        self.rows.append({"field": field, "change": change, "type": _type_text(schema or {}),
                          "required": "-" if required is None else ("yes" if required else "no"),
                          "safe": safe, "why": why, "desc": desc})

    def lists(self) -> tuple[list[str], list[str]]:
        def line(r):
            return f"{r['field']}: {r['change']}"
        return (list(dict.fromkeys(line(r) for r in self.rows if not r["safe"])),
                list(dict.fromkeys(line(r) for r in self.rows if r["safe"])))

    # ------------------------------------------------------------ one schema against the other

    def schema(self, a, b, where: str, side: str, depth: int = 0) -> None:
        """side: request / response (OpenAPI) or message (JSON Schema)."""
        a, b = _resolve(self.od, a), _resolve(self.nd, b)
        if depth > 8 or a == b:
            return
        msg = side == "message"
        ta, tb = _types(a), _types(b)
        if not msg:
            ta, tb = ta - {"null"}, tb - {"null"}
        if ta and tb and ta != tb:
            if msg and _wider(ta, tb):
                self.add(where, f"type widened ({_or(ta)} -> {_or(tb)})", safe=True, schema=b,
                         why=f"old messages stay valid; consumers must accept {_or(tb - ta) or 'number'}")
            elif msg and _wider(tb, ta):
                self.add(where, f"type narrowed ({_or(ta)} -> {_or(tb)})", safe=False, schema=b,
                         why=f"old messages with {_or(ta - tb) or 'a non-integer number'} fail")
            else:
                self.add(where, f"type {'/'.join(sorted(ta))} -> {'/'.join(sorted(tb))}", safe=False, schema=b,
                         why="the old values no longer fit")
            return
        if msg and tb and not ta:
            self.add(where, f"type set ({_or(tb)})", safe=False, schema=b, why="old messages with another type fail")
        elif msg and ta and not tb:
            self.add(where, "type constraint removed", safe=True, schema=b, why="any value is valid now; consumers must cope")
        if side == "response" and _nullable(b) and not _nullable(a):
            self.add(where, "may be null now", safe=False, schema=b, why="a client that does not expect null breaks")
        ea, eb = a.get("enum"), b.get("enum")
        if isinstance(ea, list) and isinstance(eb, list):
            gone, added = [x for x in ea if x not in eb], [x for x in eb if x not in ea]
            if gone:
                self.add(where, f"enum narrowed, drops {', '.join(map(str, gone))}", safe=False, schema=b,
                         why="old messages with that value fail" if msg else "callers that send it are refused")
            if added:
                self.add(where, f"enum adds {', '.join(map(str, added))}", safe=True, schema=b,
                         why="a consumer that switches on it may not know it" if side != "request" else "")
        elif isinstance(eb, list) and not isinstance(ea, list) and side in ("request", "message"):
            self.add(where, f"narrowed to the values {', '.join(map(str, eb))}", safe=False, schema=b, why="other values fail now")
        if msg:
            if "const" in b and a.get("const") != b.get("const"):
                self.add(where, f"const {json.dumps(b['const'])}", safe=False, schema=b, why="old messages with another value fail")
            if b.get("format") and a.get("format") != b.get("format"):
                self.add(where, f"format {b['format']}", safe=False, schema=b, why="old values in another format fail")
            elif a.get("format") and not b.get("format"):
                self.add(where, "format removed", safe=True, schema=b)
        if side in ("request", "message"):
            for k, sign in TIGHTER.items():
                va, vb = a.get(k), b.get(k)
                if isinstance(vb, (int, float)) and not isinstance(vb, bool) and (
                        va is None or (isinstance(va, (int, float)) and (vb - va) * sign > 0)):
                    self.add(where, f"narrowed ({k} {va if va is not None else 'none'} -> {vb})", safe=False, schema=b,
                             why="old messages outside the new limit fail" if msg else "callers that send more are refused")
        self.props(a, b, where, side, depth)
        if a.get("items") or b.get("items"):
            self.schema(a.get("items") or {}, b.get("items") or {}, f"{where}[]", side, depth + 1)

    def props(self, a: dict, b: dict, where: str, side: str, depth: int) -> None:
        msg = side == "message"
        pa, pb = a.get("properties") or {}, b.get("properties") or {}
        ra, rb = set(a.get("required") or []), set(b.get("required") or [])

        def at(n):
            return f"{where}.{n}" if where else n
        for name in pa:
            if name not in pb:
                self.add(at(name), "removed", safe=side == "request", schema=_resolve(self.od, pa[name]), required=name in ra,
                         why="consumers that read it break" if msg else ("" if side == "request" else "clients that read it break"))
        for name in pb:
            sb = _resolve(self.nd, pb[name])
            if name not in pa:
                req = name in rb
                if msg:
                    self.add(at(name), "new", safe=not req, schema=sb, required=req, desc=_desc(sb),
                             why="old producers do not send it, so their messages fail" if req else "old messages without it stay valid")
                elif side == "request" and req:
                    self.add(at(name), "new required field", safe=False, schema=sb, required=True, why="old callers do not send it")
                else:
                    self.add(at(name), "new field", safe=True, schema=sb, required=req, desc=_desc(sb))
                continue
            if (msg or side == "request") and name in rb and name not in ra:
                self.add(at(name), "now required", safe=False, schema=sb, required=True,
                         why="old producers that leave it out fail" if msg else "old callers that leave it out are refused")
            if (msg or side == "response") and name in ra and name not in rb:
                self.add(at(name), "no longer required (may be missing)", safe=False, schema=sb, required=False,
                         why="consumers that expect it break" if msg else "clients that expect it break")
            self.schema(pa[name], pb[name], at(name), side, depth + 1)
        if msg:
            xa, xb = a.get("additionalProperties", True), b.get("additionalProperties", True)
            label = f"{where} (other fields)" if where else "(other fields)"
            if xa is not False and xb is False:
                self.add(label, "additionalProperties: false (fields not listed are refused)", safe=False,
                         why="old producers that send other fields fail")
            elif xa is False and xb is not False:
                self.add(label, "additionalProperties allowed now", safe=True, why="old messages stay valid")
            elif isinstance(xa, dict) and isinstance(xb, dict) and xa != xb:
                self.schema(xa, xb, label, side, depth + 1)

    # ------------------------------------------------------------ OpenAPI parts

    def body(self, op_a: dict, op_b: dict, where: str) -> None:
        ba, bb = _resolve(self.od, op_a.get("requestBody")), _resolve(self.nd, op_b.get("requestBody"))
        if bb and not ba:
            req = bool(bb.get("required"))
            self.add(f"{where} request body", "new and required" if req else "new", safe=not req, schema=_media(bb), required=req,
                     why="old callers do not send it" if req else "")
            return
        if ba and not bb:
            self.add(f"{where} request body", "removed", safe=True, schema=_media(ba))
            return
        if bb.get("required") and not ba.get("required"):
            self.add(f"{where} request body", "now required", safe=False, required=True, why="old callers that send none are refused")
        self.schema(_media(ba), _media(bb), f"{where} request body", "request")

    def params(self, op_a: dict, op_b: dict, where: str) -> None:
        def by(doc, op):
            return {(p.get("in"), p.get("name")): p for p in (_resolve(doc, x) for x in op.get("parameters") or []) if p.get("name")}
        pa, pb = by(self.od, op_a), by(self.nd, op_b)
        for key, p in pb.items():
            label = f"{where} parameter {key[1]} ({key[0]})"
            if key not in pa:
                req = bool(p.get("required"))
                self.add(label, "new and required" if req else "new", safe=not req, schema=p.get("schema"), required=req,
                         why="old callers do not send it" if req else "")
                continue
            if p.get("required") and not pa[key].get("required"):
                self.add(label, "now required", safe=False, schema=p.get("schema"), required=True,
                         why="old callers that leave it out are refused")
            self.schema(pa[key].get("schema") or {}, p.get("schema") or {}, label, "request")
        for key, p in pa.items():
            if key not in pb:
                self.add(f"{where} parameter {key[1]} ({key[0]})", "removed", safe=False, schema=p.get("schema"),
                         why="callers that send it may be refused")

    def responses(self, op_a: dict, op_b: dict, where: str) -> None:
        ra, rb = op_a.get("responses") or {}, op_b.get("responses") or {}
        for status in ra:
            if status not in rb:
                self.add(f"{where} response {status}", "removed", safe=False, why="clients that handle it lose it")
        for status in rb:
            if status not in ra:
                self.add(f"{where} response {status}", "new", safe=True, why="a client's error handling may not expect it")
                continue
            self.schema(_media(_resolve(self.od, ra[status])), _media(_resolve(self.nd, rb[status])),
                        f"{where} response {status}", "response")


def _media(part: dict) -> dict:
    """The schema of a request body or response: the JSON media type's, else the first one's."""
    content = (part or {}).get("content") or {}
    if not isinstance(content, dict) or not content:
        return {}
    key = next((k for k in content if "json" in k), next(iter(content)))
    return (content.get(key) or {}).get("schema") or {}


def classify(old: dict | None, new: dict | None) -> dict:
    """{kind: openapi, new: [operations], changed: [what], breaks: [what], rows} between two OpenAPI documents."""
    oa, ob = _ops(old), _ops(new)
    d = _Delta(old, new)
    added = [f"{m} {p}" for (m, p) in ob if (m, p) not in oa]
    for op in added:
        d.add(op, "new endpoint", safe=True)
    for (m, p) in oa:
        if (m, p) not in ob:
            d.add(f"{m} {p}", "endpoint removed", safe=False, why="callers of it break")
    for key in ob:
        if key in oa:            # a $ref'd schema may have changed even when the operation's own text did not
            where = f"{key[0]} {key[1]}"
            d.params(oa[key], ob[key], where)
            d.body(oa[key], ob[key], where)
            d.responses(oa[key], ob[key], where)
    breaks, changed = d.lists()
    return {"kind": "openapi", "new": added, "changed": [x for x in changed if not x.endswith(": new endpoint")],
            "breaks": breaks, "rows": d.rows}


def classify_schema(old: dict | None, new: dict | None) -> dict:
    """{kind: json-schema, new: [properties], changed, breaks, rows} between two JSON Schema documents (a message
    contract): what a rolling deploy meets, old producers next to new consumers and the other way round."""
    d = _Delta(old, new)
    if old is None:
        for name, s in ((new or {}).get("properties") or {}).items():
            s = _resolve(new, s)
            d.add(name, "new", safe=True, schema=s, required=name in set((new or {}).get("required") or []), desc=_desc(s),
                  why="a new contract: no old message exists")
    else:
        d.schema(old, new, "", "message")
    breaks, changed = d.lists()
    return {"kind": "json-schema", "new": [r["field"] for r in d.rows if r["change"] == "new"],
            "changed": changed, "breaks": breaks, "rows": d.rows}


# ------------------------------------------------------------------ the gate's Markdown

NUM = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten"}


def _n(n: int, word: str) -> str:
    return f"{NUM.get(n, n)} {word if n == 1 else word + 's'}"


def _names(rows: list[dict], with_desc: bool = False, limit: int = 4) -> str:
    parts = [code(r["field"]) + (f" ({safe_words(r['desc'])})" if with_desc and r.get("desc") else "") for r in rows[:limit]]
    if len(rows) > limit:
        parts.append(f"{len(rows) - limit} more")
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]


def subject(file: str, doc: dict | None = None) -> str:
    stem = re.sub(r"\.(json|ya?ml)$", "", file.rsplit("/", 1)[-1])
    name = str((doc or {}).get("title") or stem)
    queue = re.search(r"(^|/)(messages?|events?|queues?|topics?)/", file)
    return f"The queue message {code(name)}" if queue else f"The message schema {code(name)}"


def plain_words(file: str, delta: dict | None, doc: dict | None = None, removed_lines: int = 0, new_file: bool = False) -> str:
    """One to three sentences a person reads first: what changes and whether old callers or messages still work."""
    if delta is None:
        if new_file:
            return f"{code(file)} is a new contract file, so nothing that exists today can break. Read it in the diff."
        return (f"{code(file)} is not an OpenAPI document or a JSON Schema, so keel cannot sort it field by field: read the "
                "diff." + (f" Its {removed_lines} removed line(s) (-) are the ones that can break callers." if removed_lines else ""))
    rows = delta.get("rows") or []
    if not rows:
        return f"{code(file)}: nothing a caller or a message sees changes (descriptions or examples only)."
    if delta.get("kind") == "json-schema":
        who = subject(file, doc)
        added = [r for r in rows if r["change"] == "new" and r["required"] != "yes"]
        req = [r for r in rows if r["change"] == "new" and r["required"] == "yes"]
        gone = [r for r in rows if r["change"] == "removed"]
        rest = [r for r in rows if r not in added and r not in req and r not in gone]
        out = []
        if added:
            out.append(f"{who} gets {_n(len(added), 'new optional field')}: {_names(added, True)}.")
            out.append(f"Old messages without {'it' if len(added) == 1 else 'them'} stay valid.")
        if req:
            out.append(f"{'It also' if added else who} gets {_n(len(req), 'new required field')}: {_names(req)}; old producers "
                       f"do not send {'it' if len(req) == 1 else 'them'}, so their messages fail.")
        if gone:
            out.append(f"{_names(gone)} {'is' if len(gone) == 1 else 'are'} removed: consumers that still read "
                       f"{'it' if len(gone) == 1 else 'them'} break.")
        if rest:
            bad = [r for r in rest if not r["safe"]]
            lead = _n(len(rest), "other change")
            out.append(f"{lead[0].upper() + lead[1:]} {'is' if len(rest) == 1 else 'are'} in the table"
                       + (f", {len(bad)} of them breaking." if bad else ", all safe for old messages."))
        if not gone and not req and not any("required" in r["change"] for r in rest):
            out.append("Nothing is removed or made required.")
        return " ".join(out)
    new_ops = [r for r in rows if r["change"] == "new endpoint"]
    bad = [r for r in rows if not r["safe"]]
    safe = [r for r in rows if r["safe"] and r not in new_ops]
    out = []
    if new_ops:
        out.append(f"The API gets {_n(len(new_ops), 'new endpoint')}: {_names(new_ops)}.")
    if bad:
        lead = _n(len(bad), "change")
        out.append(f"{lead[0].upper() + lead[1:]} {'breaks' if len(bad) == 1 else 'break'} old callers, "
                   f"for example {code(bad[0]['field'])}: {bad[0]['change']}.")
    if safe:
        lead = _n(len(safe), "other change")
        out.append(f"{lead[0].upper() + lead[1:]} {'is' if len(safe) == 1 else 'are'} safe for old callers.")
    if not bad:
        out.append("Nothing is removed or narrowed, so old callers keep working.")
    return " ".join(out)


def rows_table(delta: dict) -> str:
    msg = delta.get("kind") == "json-schema"
    head = ["field" if msg else "endpoint or field", "change", "type", "required?",
            "safe for old messages?" if msg else "safe for old callers?"]
    rows = [[code(r["field"]), r["change"], r["type"] or "-", r["required"],
             ("yes" if r["safe"] else "**no**") + (f": {r['why']}" if r.get("why") else "")]
            for r in sorted(delta.get("rows") or [], key=lambda r: r["safe"])]
    return table(head, rows)


def verdict_text(deltas: list[dict | None]) -> str:
    bad = [r for d in deltas if d for r in d.get("rows") or [] if not r["safe"]]
    if not bad and all(d is None for d in deltas):
        return "keel could not sort the contract field by field: read the diff"
    if not bad:
        return "safe for a rolling deploy" + ("; one file could not be sorted, read its diff" if any(d is None for d in deltas) else "")
    parts = [f"{code(r['field'])} {r['change']}" + (f" ({r['why']})" if r.get("why") else "") for r in bad[:4]]
    return "breaks: " + "; ".join(parts) + (f"; and {len(bad) - 4} more" if len(bad) > 4 else "")


def describe(file: str, delta: dict | None, removed_lines: int = 0, doc: dict | None = None, new_file: bool = False) -> list[str]:
    """One file's Markdown for the gate's "What changes" part: a heading and its table (breaking rows first). A file keel
    cannot sort gets its plain-words sentence instead. The verdict is the gate's "Compatibility" part (verdict_text)."""
    kind = "" if delta is None else (" · message schema (JSON Schema)" if delta.get("kind") == "json-schema" else " · OpenAPI")
    out = [f"### {code(file)}{kind}", ""]
    if delta is None:
        return out + [plain_words(file, delta, doc, removed_lines, new_file)]
    if not delta.get("rows"):
        return out + ["Nothing a caller or a message sees changes (descriptions or examples only)."]
    return out + [rows_table(delta)]
