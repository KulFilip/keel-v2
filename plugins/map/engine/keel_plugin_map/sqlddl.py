"""The statements: CREATE / ALTER / DROP / COMMENT ON, applied to the schema (a part of sqlschema.py)."""

from __future__ import annotations

import re

from .sqllex import Cur, DEFAULT_STOP, TABLE_CONSTRAINT, TYPE_STOP, Tok, column_list, split_top
from .sqlmodel import ACTIONS, Schema, Table, _key

def _action(c: Cur) -> str | None:
    for a in ACTIONS:
        if c.eat(*a.split()):
            return a.upper()
    return None


def _references(c: Cur) -> dict:
    """After REFERENCES: target [(cols)] [MATCH ..] [ON DELETE a] [ON UPDATE a] [DEFERRABLE ...]."""
    nm = c.name()
    cols = c.group()
    fk = {"ref_schema": nm[0] if nm else None, "ref_name": nm[1] if nm else "", "ref_columns": column_list(cols) if cols else [],
          "on_delete": None, "on_update": None}
    while not c.done():
        if c.eat("on", "delete"):
            fk["on_delete"] = _action(c)
        elif c.eat("on", "update"):
            fk["on_update"] = _action(c)
        elif c.at("match") or c.at("deferrable") or c.at("not", "deferrable") or c.at("initially"):
            c.next()
            if c.peek() and c.peek().word("deferrable", "full", "partial", "simple", "deferred", "immediate"):
                c.next()
        else:
            break
    return fk


def _column(s: Schema, t: Table, toks: list[Tok], c_text: str) -> dict | None:
    """One column definition: name type [constraints]."""
    c = Cur(toks, c_text)
    name_tok = c.next()
    if not name_tok or not name_tok.ident:
        return None
    type_toks: list[Tok] = []
    depth = 0
    while not c.done():
        tok = c.peek()
        if depth == 0 and tok.kind == "id":
            low = tok.val.lower()
            if low == "with" and type_toks and c.peek(1) and c.peek(1).word("time", "local"):
                pass                                          # timestamp with time zone
            elif low == "character" and c.peek(1) and c.peek(1).word("set"):
                break
            elif low in TYPE_STOP and not (low == "key" and not type_toks):
                break
        if tok.kind == "op" and tok.val in "([":
            depth += 1
        elif tok.kind == "op" and tok.val in ")]":
            depth -= 1
        type_toks.append(c.next())
    col = {"name": name_tok.val, "type": re.sub(r"\s+(?=[(\[])", "", c.src(type_toks)), "nullable": True, "default": None,
           "pk": False, "unique": False, "fk": None, "identity": False, "generated": None, "comment": None,
           "cite": s.cite(name_tok)}
    if col["type"].lower() in ("serial", "bigserial", "smallserial", "serial4", "serial8", "serial2"):
        col["identity"] = True
    pending = None
    while not c.done():
        tok = c.peek()
        if c.eat("constraint"):
            nm = c.next()
            pending = nm.val if nm else None
        elif c.eat("not", "null"):
            col["nullable"] = False
        elif c.eat("null"):
            col["nullable"] = True
        elif c.eat("default"):
            start = c.i
            c.skip_value()                                    # the first token always belongs to it: DEFAULT NULL
            depth = 0
            while not c.done():
                nxt = c.peek()
                if depth == 0 and nxt.kind == "id" and nxt.val.lower() in DEFAULT_STOP:
                    break
                if nxt.kind == "op" and nxt.val == "(":
                    depth += 1
                elif nxt.kind == "op" and nxt.val == ")":
                    depth -= 1
                c.next()
            col["default"] = c.src(c.t[start:c.i]) or None
        elif c.eat("primary", "key"):
            col["pk"], col["nullable"] = True, False
            t.pk = {"name": pending, "columns": [col["name"]], "cite": s.cite(tok)}
            c.eat("asc") or c.eat("desc")
            if c.eat("autoincrement"):
                col["identity"] = True
            pending = None
        elif c.eat("unique"):
            c.eat("key")
            col["unique"] = True
            pending = None
        elif c.eat("references"):
            fk = _references(c)
            t.fks.append({"name": pending, "columns": [col["name"]], **fk, "cite": s.cite(tok)})
            pending = None
        elif c.eat("check"):
            c.group()
            t.checks += 1
            pending = None
        elif c.at("generated"):
            c.next()
            c.eat("always") or c.eat("by", "default")
            c.eat("as")
            if c.eat("identity"):
                col["identity"] = True
                c.group()
            else:
                g = c.group()
                col["generated"] = c.src(g) if g else "generated"
                c.eat("stored") or c.eat("virtual")
        elif c.eat("as"):
            g = c.group()
            col["generated"] = c.src(g) if g else "generated"
            c.eat("stored") or c.eat("virtual") or c.eat("persisted")
        elif c.eat("auto_increment") or c.eat("autoincrement"):
            col["identity"] = True
        elif c.eat("identity"):
            col["identity"] = True
            c.group()
        elif c.eat("comment"):
            nxt = c.next()
            col["comment"] = nxt.val if nxt and nxt.kind == "str" else None
        elif c.eat("collate") or c.eat("charset") or c.eat("character", "set") or c.eat("on", "update") or c.eat("encode") \
                or c.eat("compression") or c.eat("storage"):
            c.skip_value()
        else:
            c.next()
    return col


def _table_constraint(s: Schema, t: Table, toks: list[Tok], text: str) -> bool:
    """A table-level PRIMARY KEY / UNIQUE / FOREIGN KEY / CHECK / KEY / INDEX. False when it is not one."""
    c = Cur(toks, text)
    first = c.peek()
    name = None
    if c.eat("constraint"):
        nm = c.next()
        name = nm.val if nm else None
    tok = c.peek()
    if not tok:
        return name is not None
    if c.eat("primary", "key"):
        c.eat("clustered") or c.eat("nonclustered")
        cols = column_list(c.group() or [])
        t.pk = {"name": name, "columns": cols, "cite": s.cite(first)}
        for cn in cols:
            if (col := t.col(cn)):
                col["pk"], col["nullable"] = True, False
        return True
    if c.eat("unique"):
        c.eat("key") or c.eat("index")
        c.eat("nulls", "not", "distinct") or c.eat("nulls", "distinct")
        if c.peek() and c.peek().ident and not c.at("clustered") and not c.at("nonclustered"):
            name = name or c.peek().val
            c.next()
        c.eat("clustered") or c.eat("nonclustered")
        cols = column_list(c.group() or [])
        t.uniques.append({"name": name, "columns": cols, "cite": s.cite(first)})
        if len(cols) == 1 and (col := t.col(cols[0])):
            col["unique"] = True
        return True
    if c.eat("foreign", "key"):
        if c.peek() and c.peek().ident:
            name = name or c.next().val
        cols = column_list(c.group() or [])
        if c.eat("references"):
            t.fks.append({"name": name, "columns": cols, **_references(c), "cite": s.cite(first)})
        return True
    if c.eat("check"):
        t.checks += 1
        return True
    if c.at("exclude") or c.at("like") or c.at("period"):
        return True
    method = None
    if c.at("fulltext") or c.at("spatial"):
        method = c.next().val.lower()
    if c.eat("key") or c.eat("index"):
        idx_name = c.next().val if c.peek() and c.peek().ident else None
        if c.eat("using"):
            method = c.next().val.lower()
        cols = column_list(c.group() or [])
        t.indexes.append({"name": idx_name or name, "columns": cols, "unique": False, "method": method, "where": None,
                          "cite": s.cite(first)})
        return True
    return name is not None


def _is_constraint(toks: list[Tok]) -> bool:
    first = toks[0]
    if first.kind != "id":
        return False
    low = first.val.lower()
    if low in TABLE_CONSTRAINT:
        return True
    if low in ("key", "index"):                                # MySQL `KEY name (cols)`, not a column called key
        nxt = toks[1] if len(toks) > 1 else None
        return bool(nxt) and ((nxt.kind == "op" and nxt.val == "(") or (nxt.ident and len(toks) > 2 and toks[2].val == "("))
    return False


def create_table(s: Schema, c: Cur, first: Tok):
    guarded = c.eat("if", "not", "exists")
    nm = c.name()
    if not nm:
        return
    schema, name, _ = nm
    if guarded and s.get(schema, name):
        return                                                # IF NOT EXISTS on a table that exists: nothing happens
    if c.at("partition", "of") or c.at("of"):
        return                                                # a partition: its parent is the table
    body = c.group()
    t = Table(name=name, schema=schema, kind="table", cite=s.cite(first))
    if body is None:
        if c.eat("as"):                                       # CREATE TABLE x AS SELECT ...
            _view_columns(s, t, c.t[c.i:], c.text)
            t.definition = c.src(c.t[c.i:])[:2000]
        elif c.eat("like"):
            src_nm = c.name()
            if src_nm and (src := s.get(src_nm[0], src_nm[1])):
                t.columns = [dict(col) for col in src.columns]
        else:
            return
    else:
        for el in split_top(body):
            if not el:
                continue
            if el[0].word("like") and len(el) > 1:
                sub = Cur(el[1:], c.text)
                src_nm = sub.name()
                if src_nm and (src := s.get(src_nm[0], src_nm[1])):
                    t.columns += [{**dict(col), "cite": s.cite(el[0])} for col in src.columns]
                continue
            if _is_constraint(el):
                _table_constraint(s, t, el, c.text)
            elif (col := _column(s, t, el, c.text)):
                if not t.col(col["name"]):
                    t.columns.append(col)
        if t.pk:                                              # constraints may come before the columns they name
            for cn in t.pk["columns"]:
                if (col := t.col(cn)):
                    col["pk"], col["nullable"] = True, False
        for u in t.uniques:
            if len(u["columns"]) == 1 and (col := t.col(u["columns"][0])):
                col["unique"] = True
    s.tables[_key(schema, name)] = t


def _apply_column_def(col: dict, new: dict):
    """MODIFY / CHANGE / ALTER COLUMN with a full definition: the type and its constraints replace the old ones."""
    for k in ("type", "nullable", "default", "identity", "generated", "comment"):
        col[k] = new[k]
    if new["pk"]:
        col["pk"] = True
    if new["unique"]:
        col["unique"] = True


def alter_table(s: Schema, c: Cur, first: Tok):
    c.eat("if", "exists")
    c.eat("only")
    nm = c.name()
    if not nm:
        return
    t = s.get(nm[0], nm[1])
    if not t:
        return
    verb = None
    for action in split_top(c.t[c.i:]):
        if not action:
            continue
        a = Cur(action, c.text)
        tok = a.peek()
        if a.at("add|drop|rename|alter|modify|change|set|owner|enable|disable|validate|attach|detach|replica|cluster|inherit|no|reset|force"):
            verb = tok.val.lower()
            a.next()
        elif verb != "add":
            continue
        rest = action[a.i:]
        if verb == "add":
            a.eat("column")
            a.eat("if", "not", "exists")
            rest = action[a.i:]
            if not rest:
                continue
            if _is_constraint(rest):
                before = (len(t.fks), len(t.uniques), len(t.indexes))
                _table_constraint(s, t, rest, c.text)
                after = (len(t.fks), len(t.uniques), len(t.indexes))
                what = ("foreign key" if after[0] > before[0] else "unique" if after[1] > before[1] else "index" if after[2] > before[2]
                        else "primary key" if rest[0].word("primary") or (len(rest) > 2 and rest[2].word("primary")) else "constraint")
                s.note(t, tok, f"added {what}")
            elif (col := _column(s, t, rest, c.text)):
                if not t.col(col["name"]):
                    t.columns.append(col)
                    if col["pk"]:
                        t.pk = {"name": None, "columns": [col["name"]], "cite": col["cite"]}
                    s.note(t, tok, f"added column {col['name']}")
        elif verb == "drop":
            if a.eat("constraint"):
                a.eat("if", "exists")
                cn = a.next()
                _drop_constraint(t, cn.val if cn else "")
                s.note(t, tok, f"dropped constraint {cn.val if cn else ''}")
            elif a.eat("primary", "key"):
                _drop_pk(t)
                s.note(t, tok, "dropped primary key")
            elif a.eat("foreign", "key") or a.eat("index") or a.eat("key"):
                cn = a.next()
                _drop_constraint(t, cn.val if cn else "")
            elif a.at("not", "null") or a.at("default"):
                continue
            else:
                a.eat("column")
                a.eat("if", "exists")
                cn = a.next()
                if cn and cn.ident and (col := t.col(cn.val)):
                    _drop_column(t, col["name"])
                    s.note(t, tok, f"dropped column {col['name']}")
        elif verb == "rename":
            if a.eat("to") or a.eat("as"):
                new = a.name()
                if new:
                    _rename_table(s, t, new[1], new[0] if new[0] else t.schema)
                    s.note(t, tok, f"renamed from {nm[1]}")
            elif a.eat("constraint") or a.eat("index") or a.eat("key"):
                old = a.next()
                a.eat("to")
                new = a.next()
                if old and new:
                    for coll in (t.fks, t.uniques, t.indexes):
                        for x in coll:
                            if (x.get("name") or "").lower() == old.val.lower():
                                x["name"] = new.val
                    if t.pk and (t.pk.get("name") or "").lower() == old.val.lower():
                        t.pk["name"] = new.val
            else:
                a.eat("column")
                old = a.next()
                a.eat("to")
                new = a.next()
                if old and new and (col := t.col(old.val)):
                    _rename_column(s, t, col["name"], new.val)
                    s.note(t, tok, f"renamed column {old.val} to {new.val}")
        elif verb in ("alter", "modify", "change"):
            a.eat("column")
            cn = a.peek()
            if not cn or not cn.ident:
                continue
            col = t.col(cn.val)
            if verb == "change":                              # CHANGE old new definition
                a.next()
                if col and (new := _column(s, t, action[a.i:], c.text)):
                    if new["name"] != col["name"]:
                        _rename_column(s, t, col["name"], new["name"])
                    _apply_column_def(col, new)
                    s.note(t, tok, f"changed column {new['name']}")
                continue
            if verb == "modify":
                if col and (new := _column(s, t, action[a.i:], c.text)):
                    _apply_column_def(col, new)
                    s.note(t, tok, f"modified column {col['name']}")
                continue
            a.next()
            if not col:
                continue
            if a.eat("set", "data", "type") or a.eat("type"):
                type_toks = []
                while not a.done() and not a.at("using") and not a.at("collate"):
                    type_toks.append(a.next())
                col["type"] = re.sub(r"\s+(?=[(\[])", "", a.src(type_toks))
            elif a.eat("set", "not", "null"):
                col["nullable"] = False
            elif a.eat("drop", "not", "null"):
                col["nullable"] = True
            elif a.eat("set", "default"):
                col["default"] = a.src(action[a.i:]) or None
            elif a.eat("drop", "default"):
                col["default"] = None
            elif a.at("add", "generated"):
                col["identity"] = True
            elif a.at("set") or a.at("drop") or a.at("reset") or a.at("restart"):
                continue
            elif (new := _column(s, t, action[a.i - 1:], c.text)):    # SQL Server: ALTER COLUMN c int NOT NULL
                _apply_column_def(col, new)
            s.note(t, tok, f"altered column {col['name']}")
        elif verb == "set" and a.eat("schema"):
            new_schema = a.next()
            if new_schema:
                _rename_table(s, t, t.name, new_schema.val)


def _drop_pk(t: Table):
    if t.pk:
        for cn in t.pk["columns"]:
            if (col := t.col(cn)):
                col["pk"] = False
    t.pk = None


def _drop_constraint(t: Table, name: str):
    low = name.lower()
    if t.pk and (t.pk.get("name") or "").lower() == low:
        _drop_pk(t)
    t.fks = [f for f in t.fks if (f.get("name") or "").lower() != low]
    gone = [u for u in t.uniques if (u.get("name") or "").lower() == low]
    t.uniques = [u for u in t.uniques if u not in gone]
    for u in gone:
        if len(u["columns"]) == 1 and (col := t.col(u["columns"][0])):
            col["unique"] = any(u2["columns"] == u["columns"] for u2 in t.uniques)
    t.indexes = [i for i in t.indexes if (i.get("name") or "").lower() != low]


def _drop_column(t: Table, name: str):
    low = name.lower()
    t.columns = [c for c in t.columns if c["name"].lower() != low]
    t.fks = [f for f in t.fks if low not in (x.lower() for x in f["columns"])]
    t.uniques = [u for u in t.uniques if low not in (x.lower() for x in u["columns"])]
    t.indexes = [i for i in t.indexes if low not in (x.lower() for x in i["columns"])]
    if t.pk and low in (x.lower() for x in t.pk["columns"]):
        _drop_pk(t)


def _rename_column(s: Schema, t: Table, old: str, new: str):
    low = old.lower()
    sub = lambda cols: [new if x.lower() == low else x for x in cols]   # noqa: E731
    if (col := t.col(old)):
        col["name"] = new
    for coll in (t.fks, t.uniques, t.indexes):
        for x in coll:
            x["columns"] = sub(x["columns"])
    if t.pk:
        t.pk["columns"] = sub(t.pk["columns"])
    tkey = _key(t.schema, t.name)
    for other in s.tables.values():                           # foreign keys that point at the renamed column
        for f in other.fks:
            if _key(f["ref_schema"] or other.schema, f["ref_name"]) == tkey or _key(f["ref_schema"], f["ref_name"]) == tkey:
                f["ref_columns"] = sub(f["ref_columns"])


def _rename_table(s: Schema, t: Table, new_name: str, new_schema: str | None):
    old_key = _key(t.schema, t.name)
    for other in s.tables.values():
        for f in other.fks:
            if _key(f["ref_schema"], f["ref_name"]) == old_key or _key(f["ref_schema"] or other.schema, f["ref_name"]) == old_key:
                f["ref_schema"], f["ref_name"] = new_schema, new_name
    s.tables.pop(old_key, None)
    t.name, t.schema = new_name, new_schema
    s.tables[_key(new_schema, new_name)] = t
    for k, v in list(s.index_owner.items()):
        if v == old_key:
            s.index_owner[k] = _key(new_schema, new_name)


def drop(s: Schema, c: Cur):
    if c.eat("table"):
        c.eat("if", "exists")
        while not c.done():
            nm = c.name()
            if nm:
                key = _key(nm[0], nm[1])
                s.tables.pop(key, None)
                for other in s.tables.values():               # CASCADE (or the database refused): no dangling keys
                    other.fks = [f for f in other.fks if _key(f["ref_schema"] or other.schema, f["ref_name"]) != key
                                 and _key(f["ref_schema"], f["ref_name"]) != key]
            if not c.op(","):
                break
    elif c.eat("view") or c.eat("materialized", "view"):
        c.eat("if", "exists")
        while not c.done():
            nm = c.name()
            if nm and (t := s.get(nm[0], nm[1])) and t.kind != "table":
                s.tables.pop(_key(nm[0], nm[1]), None)
            if not c.op(","):
                break
    elif c.eat("index"):
        c.eat("concurrently")
        c.eat("if", "exists")
        names = []
        while not c.done():
            nm = c.name()
            if nm:
                names.append(nm[1])
            if not c.op(","):
                break
        on = c.name() if c.eat("on") else None                  # MySQL: DROP INDEX name ON table
        for n in names:
            key = _key(on[0], on[1]) if on else s.index_owner.get(n.lower())
            t = s.tables.get(key) if key else None
            if t:
                t.indexes = [i for i in t.indexes if (i.get("name") or "").lower() != n.lower()]


def create_index(s: Schema, c: Cur, first: Tok, unique: bool, method: str | None):
    c.eat("concurrently")
    c.eat("if", "not", "exists")
    name = None
    if not c.at("on"):
        nm = c.name()
        name = nm[1] if nm else None
    if c.eat("using"):
        method = c.next().val.lower()
    if not c.eat("on"):
        return
    c.eat("only")
    nm = c.name()
    if not nm or not (t := s.get(nm[0], nm[1])):
        return
    if c.eat("using"):
        method = c.next().val.lower()
    cols = column_list(c.group() or [])
    where = None
    while not c.done():
        if c.eat("where"):
            where = c.src(c.t[c.i:])
            break
        c.next()
    t.indexes.append({"name": name, "columns": cols, "unique": unique, "method": method, "where": where, "cite": s.cite(first)})
    if name:
        s.index_owner[name.lower()] = _key(t.schema, t.name)
    if unique and len(cols) == 1 and not where and (col := t.col(cols[0])):
        col["unique"] = True
    s.note(t, first, f"added {'unique ' if unique else ''}index {name or ''}".rstrip())


def _view_columns(s: Schema, t: Table, toks: list[Tok], text: str):
    """The select list of the main SELECT (column names or aliases) and the tables after FROM / JOIN."""
    depth, sel, frm = 0, None, None
    for k, tok in enumerate(toks):
        if tok.kind == "op" and tok.val == "(":
            depth += 1
        elif tok.kind == "op" and tok.val == ")":
            depth -= 1
        elif depth == 0 and tok.word("select") and sel is None:
            sel = k + 1
        elif depth == 0 and tok.word("from") and sel is not None and frm is None:
            frm = k
    for k, tok in enumerate(toks):                            # every FROM / JOIN at any depth: what the view reads
        if tok.word("from", "join") and k + 1 < len(toks) and toks[k + 1].ident:
            sub = Cur(toks[k + 1:], text)
            nm = sub.name()
            if nm and (nm[0], nm[1]) not in t.uses:
                t.uses.append((nm[0], nm[1]))
    if sel is None:
        return
    items = split_top(toks[sel:frm if frm is not None else len(toks)])
    if items and items[0] and items[0][0].word("distinct", "all"):
        items[0] = items[0][1:]
    if len(items) == 1 and items[0] and items[0][-1].kind == "op" and items[0][-1].val == "*" and len(t.uses) == 1:
        src = s.get(*t.uses[0])
        if src:
            t.columns = [{**dict(col), "pk": False, "unique": False, "fk": None} for col in src.columns]
        return
    for item in items:
        if not item:
            continue
        last = item[-1]
        if len(item) >= 2 and item[-2].word("as") and last.ident:
            name = last.val
        elif last.ident and (len(item) == 1 or (item[-2].kind == "op" and item[-2].val == ".") or item[-2].ident or item[-2].val == ")"):
            name = last.val
        elif last.kind == "op" and last.val == "*":
            name = "*"
        else:
            name = item[0].val
        t.columns.append({"name": name, "type": "", "nullable": True, "default": None, "pk": False, "unique": False, "fk": None,
                          "identity": False, "generated": None, "comment": None, "cite": s.cite(item[0])})


def create_view(s: Schema, c: Cur, first: Tok, kind: str):
    c.eat("if", "not", "exists")
    nm = c.name()
    if not nm:
        return
    t = Table(name=nm[1], schema=nm[0], kind=kind, cite=s.cite(first))
    names = c.group()
    while not c.done() and not c.at("as"):
        c.next()
    if not c.eat("as"):
        return
    query = c.t[c.i:]
    _view_columns(s, t, query, c.text)
    if names:
        cols = column_list(names)
        t.columns = [{"name": n, "type": "", "nullable": True, "default": None, "pk": False, "unique": False, "fk": None,
                      "identity": False, "generated": None, "comment": None, "cite": t.cite} for n in cols]
    t.definition = c.src(query)[:2000]
    s.tables[_key(nm[0], nm[1])] = t


def comment_on(s: Schema, c: Cur):
    if c.eat("table") or c.eat("view") or c.eat("materialized", "view"):
        nm = c.name()
        if nm and (t := s.get(nm[0], nm[1])) and c.eat("is"):
            tok = c.next()
            t.comment = tok.val if tok and tok.kind == "str" else None
    elif c.eat("column"):
        tok = c.peek()
        parts = []
        while tok and tok.ident:
            parts.append(tok.val)
            c.next()
            if not c.op("."):
                break
            tok = c.peek()
        if len(parts) >= 2 and (t := s.get(parts[-3] if len(parts) > 2 else None, parts[-2])) and (col := t.col(parts[-1])) and c.eat("is"):
            tok = c.next()
            col["comment"] = tok.val if tok and tok.kind == "str" else None


def statement(s: Schema, toks: list[Tok], text: str):
    c = Cur(toks, text)
    first = c.peek()
    if c.eat("create"):
        c.eat("or", "replace")
        c.eat("or", "alter")
        temp = False
        while c.at("global|local|temp|temporary|unlogged|transient|volatile|external|virtual|recursive|secure|force"):
            temp = temp or c.peek().word("temp", "temporary")
            c.next()
        if c.eat("table"):
            if not temp:
                create_table(s, c, first)
        elif c.eat("materialized", "view"):
            create_view(s, c, first, "materialized view")
        elif c.eat("view"):
            create_view(s, c, first, "view")
        else:
            unique = bool(c.eat("unique"))
            method = None
            while c.at("clustered|nonclustered|fulltext|spatial|bitmap"):
                tok = c.next()
                if tok.word("fulltext", "spatial", "bitmap"):
                    method = tok.val.lower()
            if c.eat("index"):
                create_index(s, c, first, unique, method)
    elif c.eat("alter", "table"):
        alter_table(s, c, first)
    elif c.eat("drop"):
        drop(s, c)
    elif c.eat("rename", "table"):                            # MySQL: RENAME TABLE a TO b, c TO d
        while not c.done():
            old = c.name()
            if not c.eat("to"):
                break
            new = c.name()
            if old and new and (t := s.get(old[0], old[1])):
                _rename_table(s, t, new[1], new[0] if new[0] else t.schema)
                s.note(t, first, f"renamed from {old[1]}")
            if not c.op(","):
                break
    elif c.eat("comment", "on"):
        comment_on(s, c)
