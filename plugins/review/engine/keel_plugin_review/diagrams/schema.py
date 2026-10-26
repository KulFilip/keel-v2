"""A schema built from ops, the diff of two schemas (before -> after), each op in plain words, and the risks keel can
see without a model.

    Schema().apply(op, path)          one op, cited at path:line
    Schema.from_live(json)            the Database plugin's live schema ({tables: [{name, columns, fks}]})
    diff(before, after, renames)      -> [table changes] (new / changed / removed, columns, indexes, keys)
    describe(op)                      -> "adds column orders.note (text, null)"
    risks(...)                        -> [{kind, severity, text, path, line}]
"""

from __future__ import annotations

import copy
import re

from .ops import Op, col, table_name


def _k(s: str | None) -> str:
    return (s or "").lower()


class Schema:
    def __init__(self):
        self.tables: dict[str, dict] = {}

    def copy(self) -> "Schema":
        s = Schema()
        s.tables = copy.deepcopy(self.tables)
        return s

    def get(self, name: str | None) -> dict | None:
        if not name:
            return None
        t = self.tables.get(_k(name))
        if t is None and "." in name:
            t = self.tables.get(_k(name.split(".")[-1]))
        return t

    def has(self, name: str | None) -> bool:
        return self.get(name) is not None

    def _table(self, name: str, cite) -> dict:
        t = self.get(name)
        if t is None:
            t = {"name": name, "columns": {}, "pk": [], "fks": [], "uniques": [], "indexes": {}, "cite": cite, "partial": True}
            self.tables[_k(name)] = t
        return t

    @staticmethod
    def from_live(live: dict) -> "Schema":
        s = Schema()
        for lt in live.get("tables") or []:
            name = table_name(str(lt.get("name") or ""))
            if not name:
                continue
            t = s._table(name, None)
            t["partial"] = False
            for c in lt.get("columns") or []:
                d = col(str(c.get("name")), str(c.get("type") or ""), nullable=c.get("nullable"), pk=bool(c.get("pk")))
                d["cite"] = None
                t["columns"][_k(d["name"])] = d
                if d["pk"]:
                    t["pk"].append(d["name"])
            for f in lt.get("fks") or []:
                fk = {"name": None, "columns": [str(f.get("column"))], "ref_table": table_name(str(f.get("table") or "")),
                      "ref_columns": [str(f.get("ref"))] if f.get("ref") else [], "on_delete": None, "cite": None}
                t["fks"].append(fk)
                c = t["columns"].get(_k(fk["columns"][0]))
                if c:
                    c["fk"] = fk
        return s

    # ---------------------------------------------------------------- applying ops

    def apply(self, op: Op, path: str) -> None:
        cite = {"path": path, "line": op.line}
        k = op.kind
        if k == "create_table" and op.table:
            td = op.table_def or {}
            t = {"name": op.table, "columns": {}, "pk": list(td.get("pk") or []), "fks": [], "uniques": [], "indexes": {},
                 "cite": cite, "partial": False}
            for c in td.get("columns") or []:
                d = dict(c)
                d["cite"] = {"path": path, "line": c.get("line") or op.line}
                if d["name"] in t["pk"]:
                    d["pk"], d["nullable"] = True, False
                t["columns"][_k(d["name"])] = d
            for f in td.get("fks") or []:
                fk = dict(f)
                fk["cite"] = {"path": path, "line": f.get("line") or op.line}
                t["fks"].append(fk)
                for cn in fk.get("columns") or []:
                    if (c := t["columns"].get(_k(cn))) is not None:
                        c["fk"] = fk
            for u in td.get("uniques") or []:
                t["uniques"].append(dict(u, cite=cite))
            for i in td.get("indexes") or []:
                t["indexes"][_k(i.get("name") or f"{op.table}_{'_'.join(i['columns'])}_idx")] = dict(i, cite=cite)
            self.tables[_k(op.table)] = t
            return
        if k == "drop_table":
            self.tables.pop(_k(op.table), None)
            if op.table and "." in op.table:
                self.tables.pop(_k(op.table.split(".")[-1]), None)
            return
        if k == "rename_table" and op.to:
            t = self.get(op.table)
            if t is None:
                return
            self.tables.pop(_k(t["name"]), None)
            t["name"] = op.to
            self.tables[_k(op.to)] = t
            for other in self.tables.values():
                for fk in other["fks"]:
                    if _k(fk.get("ref_table")) == _k(op.table):
                        fk["ref_table"] = op.to
            return
        if not op.table and k != "drop_index":
            return
        if k == "add_column" and op.column:
            t = self._table(op.table, cite)
            d = dict(op.column)
            d["cite"] = cite
            t["columns"][_k(d["name"])] = d
            if d.get("pk") and d["name"] not in t["pk"]:
                t["pk"].append(d["name"])
            if d.get("fk"):
                t["fks"].append(dict(d["fk"], cite=cite))
            return
        if k == "drop_column":
            t = self.get(op.table)
            if t is None:
                return
            t["columns"].pop(_k(op.name), None)
            t["pk"] = [c for c in t["pk"] if _k(c) != _k(op.name)]
            t["fks"] = [f for f in t["fks"] if _k(op.name) not in [_k(c) for c in f.get("columns") or []]]
            t["uniques"] = [u for u in t["uniques"] if _k(op.name) not in [_k(c) for c in u.get("columns") or []]]
            t["indexes"] = {n: i for n, i in t["indexes"].items() if _k(op.name) not in [_k(c) for c in i.get("columns") or []]}
            return
        if k == "alter_column":
            t = self._table(op.table, cite)
            c = t["columns"].get(_k(op.name))
            if c is None:
                c = col(op.name or "?", "")
                c["cite"] = cite
                t["columns"][_k(op.name)] = c
            ch = dict(op.column or {})
            ch.pop("default_dropped", None)
            c.update({x: v for x, v in ch.items() if x in ("type", "nullable", "default", "unique", "auto")})
            c["altered"] = cite
            return
        if k == "rename_column" and op.to:
            t = self.get(op.table)
            if t is None:
                return
            c = t["columns"].pop(_k(op.name), None)
            if c is None:
                return
            c["name"] = op.to
            t["columns"][_k(op.to)] = c

            def ren(cols):
                return [op.to if _k(x) == _k(op.name) else x for x in cols or []]
            t["pk"] = ren(t["pk"])
            for f in t["fks"]:
                f["columns"] = ren(f.get("columns"))
            for u in t["uniques"]:
                u["columns"] = ren(u.get("columns"))
            for i in t["indexes"].values():
                i["columns"] = ren(i.get("columns"))
            for other in self.tables.values():
                for f in other["fks"]:
                    if _k(f.get("ref_table")) == _k(t["name"]):
                        f["ref_columns"] = ren(f.get("ref_columns"))
            return
        if k == "add_fk" and op.fk:
            t = self._table(op.table, cite)
            fk = dict(op.fk, cite=cite)
            t["fks"].append(fk)
            for cn in fk.get("columns") or []:
                if (c := t["columns"].get(_k(cn))) is not None:
                    c["fk"] = fk
            return
        if k == "drop_constraint":
            t = self.get(op.table)
            if t is None:
                return
            if _k(op.name) == "primary":
                t["pk"] = []
                return
            t["fks"] = [f for f in t["fks"] if _k(f.get("name")) != _k(op.name)]
            t["uniques"] = [u for u in t["uniques"] if _k(u.get("name")) != _k(op.name)]
            t["indexes"].pop(_k(op.name), None)
            for c in t["columns"].values():
                if c.get("fk") and _k(c["fk"].get("name")) == _k(op.name):
                    c["fk"] = None
            return
        if k == "add_unique":
            t = self._table(op.table, cite)
            t["uniques"].append({"name": op.name, "columns": list(op.columns), "cite": cite})
            return
        if k == "add_pk":
            t = self._table(op.table, cite)
            t["pk"] = list(op.columns)
            for cn in op.columns:
                if (c := t["columns"].get(_k(cn))) is not None:
                    c["pk"], c["nullable"] = True, False
            return
        if k == "add_index":
            t = self._table(op.table, cite)
            name = op.name or f"{op.table}_{'_'.join(op.columns)}_{'key' if op.unique else 'idx'}"
            t["indexes"][_k(name)] = {"name": name, "columns": list(op.columns), "unique": op.unique, "cite": cite}
            return
        if k == "drop_index":
            for t in ([self.get(op.table)] if op.table and self.get(op.table) else list(self.tables.values())):
                if t and t["indexes"].pop(_k(op.name), None) is not None:
                    return
                if t:
                    t["uniques"] = [u for u in t["uniques"] if _k(u.get("name")) != _k(op.name)]


# ------------------------------------------------------------------ the diff

def _col_text(c: dict) -> str:
    bits = [c.get("type") or "?"]
    if c.get("nullable") is False and not c.get("pk"):
        bits.append("not null")
    elif c.get("nullable") is True:
        bits.append("null")
    if c.get("default") not in (None, ""):
        bits.append(f"default {c['default']}")
    return ", ".join(bits)


def _fk_text(fk: dict | None) -> str | None:
    if not fk or not fk.get("ref_table"):
        return None
    rc = ",".join(fk.get("ref_columns") or [])
    return f"{fk['ref_table']}.{rc}" if rc else str(fk["ref_table"])


def _norm_type(t: str | None) -> str:
    return re.sub(r"\s+", "", (t or "").lower())


def _unique_cols(t: dict) -> set[str]:
    out = set()
    for u in t["uniques"]:
        if len(u.get("columns") or []) == 1:
            out.add(_k(u["columns"][0]))
    for i in t["indexes"].values():
        if i.get("unique") and len(i.get("columns") or []) == 1:
            out.add(_k(i["columns"][0]))
    for c in t["columns"].values():
        if c.get("unique"):
            out.add(_k(c["name"]))
    return out


def _col_view(c: dict, t: dict, status: str, was: str | None = None) -> dict:
    return {"name": c["name"], "type": c.get("type") or "", "pk": bool(c.get("pk")) or _k(c["name"]) in [_k(x) for x in t["pk"]],
            "fk": _fk_text(c.get("fk")) or _fk_text(next((f for f in t["fks"] if [_k(x) for x in f.get("columns") or []] == [_k(c["name"])]), None)),
            "unique": _k(c["name"]) in _unique_cols(t), "nullable": c.get("nullable"), "default": c.get("default"),
            "status": status, "was": was, "cite": c.get("cite")}


def _indexes(t: dict) -> dict[str, dict]:
    out = {}
    for n, i in t["indexes"].items():
        out[n] = {"name": i.get("name") or n, "columns": i.get("columns") or [], "unique": bool(i.get("unique")), "cite": i.get("cite")}
    for u in t["uniques"]:
        n = _k(u.get("name") or "uq_" + "_".join(u.get("columns") or []))
        out.setdefault(n, {"name": u.get("name") or "unique (" + ", ".join(u.get("columns") or []) + ")",
                           "columns": u.get("columns") or [], "unique": True, "cite": u.get("cite")})
    return out


def _fks(t: dict) -> dict[str, dict]:
    out = {}
    for f in t["fks"]:
        key = ",".join(_k(c) for c in f.get("columns") or []) + "->" + _k(f.get("ref_table"))
        out[key] = f
    return out


def diff(before: Schema, after: Schema, renames: dict[str, str] | None = None,
         col_renames: dict[tuple[str, str], str] | None = None) -> list[dict]:
    """Every table that differs: new, removed, or changed (its columns, indexes and foreign keys marked)."""
    renames = {_k(a): b for a, b in (renames or {}).items()}
    col_renames = {(_k(t), _k(a)): b for (t, a), b in (col_renames or {}).items()}
    out: list[dict] = []
    matched_before: set[str] = set()
    for key, ta in sorted(after.tables.items()):
        old_name = next((a for a, b in renames.items() if _k(b) == key), None)
        tb = before.get(old_name) if old_name and before.has(old_name) else before.get(ta["name"])
        if tb is None:
            out.append({"name": ta["name"], "status": "new", "cite": ta.get("cite"),
                        "columns": [_col_view(c, ta, "new") for c in ta["columns"].values()],
                        "indexes": [dict(i, status="new") for i in _indexes(ta).values()],
                        "fks": [dict(_fk_out(f), status="new") for f in ta["fks"]]})
            continue
        matched_before.add(_k(tb["name"]))
        cols: list[dict] = []
        changed = _k(tb["name"]) != key
        before_cols = dict(tb["columns"])
        for ck, c in ta["columns"].items():
            old_c = next((a for (t, a), b in col_renames.items() if t == key and _k(b) == ck), None)
            cb = before_cols.pop(old_c, None) if old_c and old_c in before_cols else before_cols.pop(ck, None)
            if cb is None:
                cols.append(_col_view(c, ta, "new"))
                changed = True
                continue
            notes = []
            if _k(cb["name"]) != ck:
                notes.append(f"renamed from {cb['name']}")
            if c.get("type") and cb.get("type") and _norm_type(c["type"]) != _norm_type(cb["type"]):
                notes.append(f"type {cb['type']} → {c['type']}")
            if c.get("nullable") is not None and cb.get("nullable") is not None and bool(c["nullable"]) != bool(cb["nullable"]) \
                    and not c.get("pk"):
                notes.append("now NOT NULL" if c["nullable"] is False else "now nullable")
            if (c.get("default") or None) != (cb.get("default") or None) and "default" in c:
                notes.append(f"default {cb.get('default') or 'none'} → {c.get('default') or 'none'}")
            if _fk_text(c.get("fk")) != _fk_text(cb.get("fk")) and (c.get("fk") or cb.get("fk")):
                notes.append(f"foreign key → {_fk_text(c.get('fk')) or 'none'}")
            if notes:
                changed = True
                cols.append(_col_view(c, ta, "changed", "; ".join(notes)))
            else:
                cols.append(_col_view(c, ta, "same"))
        for c in before_cols.values():
            cols.append(_col_view(c, tb, "removed"))
            changed = True
        ia, ib = _indexes(ta), _indexes(tb)
        idx = [dict(i, status="new" if n not in ib else "same") for n, i in ia.items()] + \
              [dict(i, status="removed") for n, i in ib.items() if n not in ia]
        fa, fb = _fks(ta), _fks(tb)
        fks = [dict(_fk_out(f), status="new" if n not in fb else "same") for n, f in fa.items()] + \
              [dict(_fk_out(f), status="removed") for n, f in fb.items() if n not in fa]
        if [_k(x) for x in ta["pk"]] != [_k(x) for x in tb["pk"]] and tb["pk"]:
            changed = True
        if any(i["status"] != "same" for i in idx) or any(f["status"] != "same" for f in fks):
            changed = True
        if changed:
            entry = {"name": ta["name"], "status": "changed", "cite": ta.get("cite"), "columns": cols, "indexes": idx, "fks": fks}
            if _k(tb["name"]) != key:
                entry["renamed_from"] = tb["name"]
            out.append(entry)
    for key, tb in sorted(before.tables.items()):
        if key in matched_before or after.has(tb["name"]) or key in renames:
            continue
        out.append({"name": tb["name"], "status": "removed", "cite": tb.get("cite"),
                    "columns": [_col_view(c, tb, "removed") for c in tb["columns"].values()],
                    "indexes": [dict(i, status="removed") for i in _indexes(tb).values()],
                    "fks": [dict(_fk_out(f), status="removed") for f in tb["fks"]]})
    return out


def _fk_out(f: dict) -> dict:
    return {"name": f.get("name"), "columns": f.get("columns") or [], "ref_table": f.get("ref_table"),
            "ref_columns": f.get("ref_columns") or [], "on_delete": f.get("on_delete"), "cite": f.get("cite")}


def related(after: Schema, before: Schema, changed: list[dict], limit: int = 12) -> list[dict]:
    """Tables the change does not touch that a changed table points to (or that point to one): shown faded, with their
    key columns only."""
    names = {_k(t["name"]) for t in changed}
    out: dict[str, dict] = {}

    def add(t: dict, cols: set[str]):
        e = out.setdefault(_k(t["name"]), {"name": t["name"], "status": "related", "cite": t.get("cite"), "columns": [],
                                          "indexes": [], "fks": [], "_cols": set()})
        e["_cols"] |= cols

    for t in changed:
        for f in t.get("fks") or []:
            ref = after.get(f.get("ref_table")) or before.get(f.get("ref_table"))
            if ref and _k(ref["name"]) not in names:
                add(ref, {_k(c) for c in f.get("ref_columns") or []} | {_k(c) for c in ref["pk"]})
    for key, t in after.tables.items():
        if key in names:
            continue
        for f in t["fks"]:
            if _k(f.get("ref_table")) in names:
                add(t, {_k(c) for c in f.get("columns") or []} | {_k(c) for c in t["pk"]})
                out[key]["fks"].append(dict(_fk_out(f), status="same"))
    shown = list(out.values())[:limit]
    for e in shown:
        t = after.get(e["name"]) or before.get(e["name"])
        keep = e.pop("_cols")
        e["columns"] = [_col_view(c, t, "same") for ck, c in t["columns"].items() if ck in keep]
    return shown


# ------------------------------------------------------------------ plain words

def describe(op: Op) -> str:
    k, t = op.kind, op.table
    if k == "create_table":
        td = op.table_def or {}
        n = len(td.get("columns") or [])
        refs = sorted({f.get("ref_table") for f in td.get("fks") or [] if f.get("ref_table")})
        extra = f", foreign key to {', '.join(refs)}" if refs else ""
        return f"creates table {t} ({n} column{'s' if n != 1 else ''}{extra})"
    if k == "drop_table":
        return f"drops table {t}: its rows are deleted"
    if k == "rename_table":
        return f"renames table {t} to {op.to}"
    if k == "add_column" and op.column:
        return f"adds column {t}.{op.column['name']} ({_col_text(op.column)})"
    if k == "drop_column":
        return f"drops column {t}.{op.name}: its data is deleted"
    if k == "alter_column":
        ch = op.column or {}
        bits = []
        if ch.get("type"):
            bits.append(f"type {ch['type']}")
        if ch.get("nullable") is False:
            bits.append("NOT NULL")
        elif ch.get("nullable") is True:
            bits.append("nullable")
        if ch.get("default_dropped"):
            bits.append("no default")
        elif "default" in ch and ch["default"] is not None:
            bits.append(f"default {ch['default']}")
        return f"changes column {t}.{op.name}" + (f": {', '.join(bits)}" if bits else "")
    if k == "rename_column":
        return f"renames column {t}.{op.name} to {op.to}"
    if k == "add_fk" and op.fk:
        od = f" (on delete {op.fk['on_delete'].lower()})" if op.fk.get("on_delete") else ""
        return f"adds foreign key {t}.{','.join(op.columns)} → {_fk_text(op.fk)}{od}"
    if k == "drop_constraint":
        return f"drops constraint {op.name} on {t}"
    if k == "add_unique":
        return f"adds unique ({', '.join(op.columns)}) on {t}"
    if k == "add_pk":
        return f"sets the primary key of {t} to ({', '.join(op.columns)})"
    if k == "add_index":
        return f"adds {'unique ' if op.unique else ''}index{' ' + op.name if op.name else ''} on {t} ({', '.join(op.columns)})"
    if k == "drop_index":
        return f"drops index {op.name}" + (f" on {t}" if t else "")
    if k == "data":
        verb = (op.extra or {}).get("verb", "")
        where = f" in {t}" if t else ""
        return {"INSERT": f"inserts rows{where}", "UPDATE": f"updates rows{where}", "DELETE": f"deletes rows{where}",
                "PYTHON": "runs a data step in code"}.get(verb, f"changes data{where}") + " (a data step)"
    return f"not read: {op.text}" if op.text else "a statement keel could not read"


# ------------------------------------------------------------------ risks

def _covered(t: dict, cols: list[str]) -> bool:
    want = [_k(c) for c in cols]
    if not want:
        return True
    keys = [[_k(c) for c in t["pk"]]] + [[_k(c) for c in u.get("columns") or []] for u in t["uniques"]] + \
           [[_k(c) for c in i.get("columns") or []] for i in t["indexes"].values()]
    keys += [[_k(c["name"])] for c in t["columns"].values() if c.get("unique") or c.get("index")]
    return any(k[: len(want)] == want for k in keys if k)


def risks(before: Schema, after: Schema, steps: list[tuple[str, Op]], refs) -> list[dict]:
    """steps: the change's ops in the order they run, each with its file. refs(name) -> [(path, line)] of code that
    still uses a name (at the head)."""
    out: list[dict] = []
    created: set[str] = set()
    data_on: set[str] = set()
    data_any = False
    seen: set[tuple] = set()

    def add(kind: str, sev: str, text: str, path: str, line: int, extra: dict | None = None):
        key = (kind, text)
        if key in seen:
            return
        seen.add(key)
        out.append({"kind": kind, "severity": sev, "text": text, "path": path, "line": line, **(extra or {})})

    def existed(table: str | None) -> bool:
        return bool(table) and before.has(table) and _k(table) not in created

    def col_existed(table: str, cols: list[str]) -> bool:
        t = before.get(table)
        return bool(t) and all(_k(c) in t["columns"] for c in cols)

    new_fks: list[tuple[str, dict, str, int]] = []
    for path, op in steps:
        k, t = op.kind, op.table
        if k == "create_table" and t:
            created.add(_k(t))
            for f in (op.table_def or {}).get("fks") or []:
                new_fks.append((t, f, path, f.get("line") or op.line))
        elif k == "data":
            data_any = True
            if t:
                data_on.add(_k(t))
        elif k == "add_column" and op.column:
            c = op.column
            if existed(t) and c.get("nullable") is False and c.get("default") in (None, "") and not c.get("auto") \
                    and not c.get("pk") and not c.get("django_default"):
                add("not_null_no_default", "high",
                    f"{t}.{c['name']} is added NOT NULL without a default to a table that already exists: "
                    "the migration fails if the table has rows (give it a default, or add it nullable, backfill, then set NOT NULL)",
                    path, op.line)
            if c.get("fk"):
                new_fks.append((t, dict(c["fk"], columns=[c["name"]]), path, op.line))
        elif k == "alter_column" and (op.column or {}).get("nullable") is False and existed(t):
            if _k(t) not in data_on:
                add("not_null_no_backfill", "medium",
                    f"{t}.{op.name} becomes NOT NULL with no backfill before it: rows where it is null make the migration fail",
                    path, op.line)
        elif k == "alter_column" and (op.column or {}).get("type") and existed(t):
            tb = before.get(t)
            old = tb["columns"].get(_k(op.name)) if tb else None
            if old and old.get("type") and _norm_type(old["type"]) != _norm_type(op.column["type"]):
                add("type_change", "medium",
                    f"{t}.{op.name} changes type {old['type']} → {op.column['type']}: values may not convert, and a big table "
                    "is rewritten (locked) while it runs", path, op.line)
        elif k == "add_fk" and op.fk:
            new_fks.append((t, op.fk, path, op.line))
            if existed(t) and col_existed(t, op.columns) and _k(t) not in data_on and _k(op.fk.get("ref_table")) not in data_on:
                add("fk_no_cleanup", "medium",
                    f"new foreign key {t}.{','.join(op.columns)} → {_fk_text(op.fk)} on existing rows with no cleanup step: "
                    "rows that point nowhere make it fail (delete or fix them first, or add it NOT VALID then validate)",
                    path, op.line)
        elif (k == "add_unique" or (k == "add_index" and op.unique)) and existed(t) and col_existed(t, op.columns):
            if _k(t) not in data_on:
                add("unique_no_cleanup", "medium",
                    f"new unique ({', '.join(op.columns)}) on {t}, which already has rows, with no cleanup step: "
                    "duplicates make it fail (remove them first)", path, op.line)
        elif k == "drop_table" and before.has(t):
            uses = refs(t)
            add("destructive", "high", f"drops table {t}: its rows are deleted" +
                (f"; the code still names it in {len(uses)} place(s)" if uses else ""), path, op.line, {"uses": uses[:3]})
        elif k == "drop_column" and existed(t) and before.get(t) and _k(op.name) in before.get(t)["columns"]:
            uses = refs(op.name)
            add("destructive", "high", f"drops column {t}.{op.name}: its data is deleted" +
                (f"; the code still uses {op.name} in {len(uses)} place(s)" if uses else ""), path, op.line, {"uses": uses[:3]})
        elif k == "rename_column" and existed(t):
            uses = refs(op.name)
            if uses:
                add("rename", "medium", f"renames {t}.{op.name} to {op.to}; the code still uses {op.name} in {len(uses)} place(s), "
                    "and running copies of the app break until they are deployed", path, op.line, {"uses": uses[:3]})
        elif k == "rename_table" and existed(t):
            uses = refs(t)
            if uses:
                add("rename", "medium", f"renames table {t} to {op.to}; the code still names {t} in {len(uses)} place(s)",
                    path, op.line, {"uses": uses[:3]})
    for t, f, path, line in new_fks:
        ta = after.get(t)
        cols = f.get("columns") or []
        if ta and cols and not _covered(ta, cols):
            add("fk_no_index", "low",
                f"no index on {t}.{','.join(cols)} for its new foreign key to {f.get('ref_table')}: joins and deletes on "
                f"{f.get('ref_table')} scan {t} (PostgreSQL does not add one by itself)", path, line)
    del data_any
    return out


def change_ops(before: Schema, after: Schema, tables: list[dict]) -> list[tuple[str, Op]]:
    """For whole-schema files (schema.sql, schema.prisma) there are no migration steps: ops that would make the diff,
    so the same risks apply. The file is each column's cite."""
    ops: list[tuple[str, Op]] = []
    for t in tables:
        cite = t.get("cite") or {}
        if t["status"] == "new":
            td = {"columns": [], "pk": [], "fks": [], "uniques": [], "indexes": []}
            ta = after.get(t["name"])
            if ta:
                td["columns"] = list(ta["columns"].values())
                td["pk"], td["fks"] = list(ta["pk"]), [dict(f, line=(f.get("cite") or {}).get("line")) for f in ta["fks"]]
            ops.append((cite.get("path", ""), Op("create_table", t["name"], cite.get("line", 0), table_def=td)))
        elif t["status"] == "removed":
            ops.append((cite.get("path", ""), Op("drop_table", t["name"], cite.get("line", 0))))
        else:
            ta = after.get(t["name"])
            for c in t["columns"]:
                cc = c.get("cite") or cite
                if c["status"] == "new" and ta:
                    ops.append((cc.get("path", ""), Op("add_column", t["name"], cc.get("line", 0), column=ta["columns"][_k(c["name"])])))
                elif c["status"] == "removed":
                    ops.append((cc.get("path", ""), Op("drop_column", t["name"], cc.get("line", 0), name=c["name"])))
                elif c["status"] == "changed" and "NOT NULL" in (c.get("was") or ""):
                    ops.append((cc.get("path", ""), Op("alter_column", t["name"], cc.get("line", 0), name=c["name"], column={"nullable": False})))
    return ops
