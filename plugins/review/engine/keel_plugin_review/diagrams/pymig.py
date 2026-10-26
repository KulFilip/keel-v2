"""Python migrations -> ops, read with Python's own parser (ast), never run: Alembic (`op.*` in upgrade(), also inside
`with op.batch_alter_table(...)`, and op.execute SQL) and Django (`migrations.CreateModel`, AddField, ...).
"""

from __future__ import annotations

import ast
import re

from . import sql
from .ops import Op, col, table_name


def _const(n: ast.AST | None):
    if n is None:
        return None
    if isinstance(n, ast.Constant):
        return n.value
    if isinstance(n, (ast.List, ast.Tuple)):
        return [_const(x) for x in n.elts]
    if isinstance(n, ast.Call) and _fname(n) == "f" and n.args:      # op.f('ix_name')
        return _const(n.args[0])
    if isinstance(n, ast.Call) and _fname(n) == "text" and n.args:   # sa.text('now()')
        return _const(n.args[0])
    return {"raw": ast.unparse(n)}


def _fname(n: ast.Call) -> str:
    f = n.func
    if isinstance(f, ast.Attribute):
        return f.attr
    if isinstance(f, ast.Name):
        return f.id
    return ""


def _owner(n: ast.Call) -> str:
    f = n.func
    if isinstance(f, ast.Attribute):
        v = f.value
        if isinstance(v, ast.Name):
            return v.id
        if isinstance(v, ast.Attribute):
            return v.attr
    return ""


def _kw(n: ast.Call, name: str, default=None):
    for k in n.keywords:
        if k.arg == name:
            return _const(k.value)
    return default


def _has_kw(n: ast.Call, name: str) -> bool:
    return any(k.arg == name for k in n.keywords)


def _type_text(n: ast.AST | None) -> str:
    if n is None:
        return ""
    if isinstance(n, ast.Call):
        name = _fname(n) or ast.unparse(n.func)
        args = [str(_const(a)) for a in n.args if isinstance(_const(a), (int, str))]
        return name.lower() + (f"({','.join(args)})" if args else "")
    if isinstance(n, ast.Attribute):
        return n.attr.lower()
    if isinstance(n, ast.Name):
        return n.id.lower()
    return ast.unparse(n)


# ------------------------------------------------------------------ Alembic

def _sa_column(n: ast.Call) -> dict | None:
    """sa.Column('name', sa.String(20), sa.ForeignKey('orders.id'), nullable=False, server_default='x')."""
    if _fname(n) != "Column" or not n.args:
        return None
    name = _const(n.args[0])
    if not isinstance(name, str):
        return None
    typ, fk = "", None
    for a in n.args[1:]:
        if isinstance(a, ast.Call) and _fname(a) == "ForeignKey":
            target = _const(a.args[0]) if a.args else None
            if isinstance(target, str):
                t, _, c = target.rpartition(".")
                fk = {"name": _kw(a, "name"), "columns": [name], "ref_table": table_name(t or c), "ref_columns": [c] if t else [],
                      "on_delete": (_kw(a, "ondelete") or None)}
        elif not typ:
            typ = _type_text(a)
    pk = _kw(n, "primary_key") is True
    nullable = _kw(n, "nullable")
    d = col(name, typ, nullable=(False if pk else (nullable if isinstance(nullable, bool) else True)), pk=pk,
            unique=_kw(n, "unique") is True, auto=_kw(n, "autoincrement") is True or (pk and typ.startswith(("integer", "biginteger"))),
            fk=fk)
    sd = _kw(n, "server_default")
    if sd is not None:
        d["default"] = str(sd.get("raw") if isinstance(sd, dict) else sd)
    if _kw(n, "index") is True:
        d["index"] = True
    return d


def _alembic_call(n: ast.Call, batch_table: str | None) -> list[Op]:
    name = _fname(n)
    line = n.lineno
    a = [_const(x) for x in n.args]

    def arg(i: int, kw: str | None = None):
        if kw and _has_kw(n, kw):
            return _kw(n, kw)
        j = i - (1 if batch_table else 0)
        return a[j] if 0 <= j < len(a) else None

    table = batch_table if batch_table else (a[0] if a and isinstance(a[0], str) else None)
    if name == "create_table":
        t = table_name(a[0]) if a and isinstance(a[0], str) else None
        if not t:
            return [Op("unknown", line=line, text="op.create_table with a name built at run time")]
        tdef = {"columns": [], "pk": [], "fks": [], "uniques": [], "indexes": []}
        for x in n.args[1:]:
            if not isinstance(x, ast.Call):
                continue
            k = _fname(x)
            if k == "Column":
                d = _sa_column(x)
                if d:
                    d["line"] = x.lineno
                    tdef["columns"].append(d)
                    if d["pk"]:
                        tdef["pk"].append(d["name"])
                    if d["fk"]:
                        tdef["fks"].append(dict(d["fk"], line=x.lineno))
                    if d.get("index"):
                        tdef["indexes"].append({"name": None, "columns": [d["name"]], "unique": False})
            elif k == "PrimaryKeyConstraint":
                tdef["pk"] = [c for c in (_const(y) for y in x.args) if isinstance(c, str)]
            elif k == "ForeignKeyConstraint" and len(x.args) >= 2:
                cols, refs = _const(x.args[0]) or [], _const(x.args[1]) or []
                rt = refs[0].rpartition(".")[0] if refs and isinstance(refs[0], str) else ""
                tdef["fks"].append({"name": _kw(x, "name"), "columns": cols, "ref_table": table_name(rt),
                                    "ref_columns": [r.rpartition(".")[2] for r in refs if isinstance(r, str)],
                                    "on_delete": _kw(x, "ondelete"), "line": x.lineno})
            elif k == "UniqueConstraint":
                tdef["uniques"].append({"name": _kw(x, "name"), "columns": [c for c in (_const(y) for y in x.args) if isinstance(c, str)]})
        for c in tdef["columns"]:
            if c["name"] in tdef["pk"]:
                c["pk"], c["nullable"] = True, False
        return [Op("create_table", t, line, table_def=tdef)]
    if name == "drop_table" and table:
        return [Op("drop_table", table_name(table), line)]
    if name == "rename_table" and len(a) >= 2:
        return [Op("rename_table", table_name(a[0]), line, to=table_name(a[1]))]
    if name == "add_column":
        cnode = n.args[0 if batch_table else 1] if len(n.args) > (0 if batch_table else 1) else None
        d = _sa_column(cnode) if isinstance(cnode, ast.Call) else None
        if not d or not table:
            return [Op("unknown", line=line, text=ast.unparse(n)[:120])]
        ops = [Op("add_column", table_name(table), line, column=d)]
        if d.get("index"):
            ops.append(Op("add_index", table_name(table), line, columns=[d["name"]]))
        return ops
    if name == "drop_column" and table:
        c = arg(1, "column_name")
        return [Op("drop_column", table_name(table), line, name=c)] if isinstance(c, str) else []
    if name == "alter_column" and table:
        c = arg(1, "column_name")
        ops: list[Op] = []
        ch: dict = {}
        if _has_kw(n, "nullable"):
            ch["nullable"] = _kw(n, "nullable")
        if _has_kw(n, "type_"):
            ch["type"] = _type_text(next(k.value for k in n.keywords if k.arg == "type_"))
        if _has_kw(n, "server_default"):
            sd = _kw(n, "server_default")
            ch["default"] = None if sd is None else str(sd.get("raw") if isinstance(sd, dict) else sd)
            if sd is None:
                ch["default_dropped"] = True
        if ch:
            ops.append(Op("alter_column", table_name(table), line, name=c, column=ch))
        if _has_kw(n, "new_column_name"):
            ops.append(Op("rename_column", table_name(table), line, name=c, to=_kw(n, "new_column_name")))
        return ops
    if name in ("create_index",):
        nm = arg(0, "index_name")
        t = batch_table or arg(1, "table_name")
        cols = arg(2, "columns") or []
        cols = [c.get("raw") if isinstance(c, dict) else c for c in cols]
        return [Op("add_index", table_name(t or ""), line, name=nm, columns=[c for c in cols if isinstance(c, str)],
                   unique=_kw(n, "unique") is True)]
    if name == "drop_index":
        return [Op("drop_index", table_name(_kw(n, "table_name") or batch_table or "") or None, line, name=a[0] if a else None)]
    if name == "create_foreign_key":
        # op.create_foreign_key(name, source, referent, local_cols, remote_cols); batch: (name, referent, local, remote)
        if batch_table:
            nm, src, ref, lc, rc = (a + [None] * 4)[0], batch_table, (a + [None] * 4)[1], (a + [None] * 4)[2], (a + [None] * 4)[3]
        else:
            nm, src, ref, lc, rc = (a + [None] * 5)[:5]
        if not (isinstance(src, str) and isinstance(ref, str)):
            return [Op("unknown", line=line, text=ast.unparse(n)[:120])]
        fk = {"name": nm, "columns": lc or [], "ref_table": table_name(ref), "ref_columns": rc or [], "on_delete": _kw(n, "ondelete")}
        return [Op("add_fk", table_name(src), line, name=nm, fk=fk, columns=lc or [])]
    if name == "create_unique_constraint":
        nm = a[0] if a else None
        t = batch_table or (a[1] if len(a) > 1 else None)
        cols = (a[1] if batch_table else a[2]) if len(a) > (1 if batch_table else 2) else []
        return [Op("add_unique", table_name(t or ""), line, name=nm, columns=cols or [], unique=True)]
    if name == "create_primary_key":
        t = batch_table or (a[1] if len(a) > 1 else None)
        cols = (a[1] if batch_table else a[2]) if len(a) > (1 if batch_table else 2) else []
        return [Op("add_pk", table_name(t or ""), line, columns=cols or [])]
    if name == "drop_constraint":
        t = batch_table or (a[1] if len(a) > 1 else _kw(n, "table_name"))
        return [Op("drop_constraint", table_name(t or ""), line, name=a[0] if a else None)]
    if name == "execute":
        s = a[0] if a else None
        if isinstance(s, str):
            return sql.parse(s, line)
        txt = ast.unparse(n)
        m = re.search(r"\b(update|insert\s+into|delete\s+from)\s+(\w+)", txt, re.I)
        return [Op("data", m.group(2) if m else None, line, text=txt[:120], extra={"verb": m.group(1).split()[0].upper()})] if m \
            else [Op("unknown", line=line, text="op.execute with SQL built at run time")]
    if name in ("bulk_insert",):
        t = a[0].get("raw") if a and isinstance(a[0], dict) else None
        return [Op("data", table_name(t) if t else None, line, text="op.bulk_insert(…)", extra={"verb": "INSERT"})]
    if name in ("get_bind", "get_context", "f", "batch_alter_table", "inline_literal"):
        return []
    return [Op("unknown", line=line, text=f"op.{name}(…) is not read")]


def alembic(text: str) -> list[Op]:
    try:
        tree = ast.parse(text)
    except SyntaxError as exc:
        return [Op("unknown", line=exc.lineno or 1, text=f"Python syntax error: {exc.msg}")]
    up = next((f for f in tree.body if isinstance(f, ast.FunctionDef) and f.name == "upgrade"), None)
    if up is None:
        return []
    ops: list[Op] = []

    def walk(body: list[ast.stmt], batch: dict[str, str]):
        for st in body:
            if isinstance(st, ast.With):
                inner = dict(batch)
                for item in st.items:
                    ce = item.context_expr
                    if isinstance(ce, ast.Call) and _fname(ce) == "batch_alter_table" and isinstance(item.optional_vars, ast.Name):
                        t = _const(ce.args[0]) if ce.args else _kw(ce, "table_name")
                        if isinstance(t, str):
                            inner[item.optional_vars.id] = t
                walk(st.body, inner)
                continue
            for node in ast.walk(st):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                    owner = _owner(node)
                    if owner == "op":
                        ops.extend(_alembic_call(node, None))
                    elif owner in batch:
                        ops.extend(_alembic_call(node, batch[owner]))
                    elif _fname(node) == "execute" and owner in ("connection", "conn", "bind"):
                        ops.extend(_alembic_call(node, None))

    walk(up.body, {})
    return ops


# ------------------------------------------------------------------ Django

DJANGO_TYPES = {
    "AutoField": "integer", "BigAutoField": "bigint", "SmallAutoField": "smallint", "CharField": "varchar",
    "TextField": "text", "IntegerField": "integer", "BigIntegerField": "bigint", "SmallIntegerField": "smallint",
    "PositiveIntegerField": "integer", "PositiveBigIntegerField": "bigint", "PositiveSmallIntegerField": "smallint",
    "DecimalField": "decimal", "FloatField": "double", "BooleanField": "boolean", "NullBooleanField": "boolean",
    "DateField": "date", "DateTimeField": "timestamp", "TimeField": "time", "DurationField": "interval",
    "EmailField": "varchar(254)", "SlugField": "varchar(50)", "URLField": "varchar(200)", "UUIDField": "uuid",
    "JSONField": "jsonb", "BinaryField": "bytea", "GenericIPAddressField": "inet", "FileField": "varchar(100)",
    "ImageField": "varchar(100)", "ForeignKey": "bigint", "OneToOneField": "bigint",
}


def _django_table(app: str, model: str, tables: dict[str, str]) -> str:
    key = model.lower() if "." not in model else model.split(".")[1].lower()
    app_label = app if "." not in model else model.split(".")[0].lower()
    return tables.get(f"{app_label}.{key}") or f"{app_label}_{key}"


def _django_field(app: str, name: str, f: ast.AST, tables: dict[str, str]) -> dict | None:
    if not isinstance(f, ast.Call):
        return None
    kind = _fname(f)
    if kind == "ManyToManyField":
        return None
    typ = DJANGO_TYPES.get(kind, kind.lower())
    if kind == "CharField" and _kw(f, "max_length"):
        typ += f"({_kw(f, 'max_length')})"
    if kind == "DecimalField":
        typ += f"({_kw(f, 'max_digits')},{_kw(f, 'decimal_places')})"
    pk = _kw(f, "primary_key") is True or kind.endswith("AutoField")
    d = col(name, typ, nullable=False if pk else _kw(f, "null") is True, pk=pk, unique=_kw(f, "unique") is True or kind == "OneToOneField",
            auto=kind.endswith("AutoField"))
    if _has_kw(f, "db_default"):
        d["default"] = str(_kw(f, "db_default"))
    elif _has_kw(f, "default"):
        d["default"] = str(_kw(f, "default"))
        d["django_default"] = True            # Django fills the rows, then drops the default
    if kind in ("ForeignKey", "OneToOneField"):
        to = _kw(f, "to") if _has_kw(f, "to") else (_const(f.args[0]) if f.args else None)
        to = to.get("raw") if isinstance(to, dict) else to
        if isinstance(to, str):
            to = to.replace("settings.AUTH_USER_MODEL", "auth.user")
            ref = _django_table(app, to, tables)
            d["name"] = f"{name}_id"
            ondel = _kw(f, "on_delete")
            ondel = ondel.get("raw", "").split(".")[-1] if isinstance(ondel, dict) else None
            d["fk"] = {"name": None, "columns": [d["name"]], "ref_table": ref, "ref_columns": ["id"],
                       "on_delete": ondel.replace("_", " ") if ondel else None}
            d["index"] = _kw(f, "db_index") is not False
    elif _kw(f, "db_index") is True:
        d["index"] = True
    return d


def django(text: str, app: str) -> list[Op]:
    try:
        tree = ast.parse(text)
    except SyntaxError as exc:
        return [Op("unknown", line=exc.lineno or 1, text=f"Python syntax error: {exc.msg}")]
    ops: list[Op] = []
    tables: dict[str, str] = {}
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and _owner(n) == "migrations"]
    for n in sorted(calls, key=lambda x: (x.lineno, x.col_offset)):
        k = _fname(n)
        line = n.lineno
        model = _kw(n, "model_name") or _kw(n, "name") or (_const(n.args[0]) if n.args else None)
        if k == "CreateModel":
            options = _kw(n, "options") or {}
            if isinstance(options, dict) and "raw" in options:
                m = re.search(r"['\"]db_table['\"]\s*:\s*['\"](\w+)['\"]", options["raw"])
                if m:
                    tables[f"{app}.{str(model).lower()}"] = m.group(1)
            t = _django_table(app, str(model), tables)
            tdef = {"columns": [], "pk": [], "fks": [], "uniques": [], "indexes": []}
            fields = next((k2.value for k2 in n.keywords if k2.arg == "fields"), None)
            if isinstance(fields, (ast.List, ast.Tuple)):
                for el in fields.elts:
                    if isinstance(el, ast.Tuple) and len(el.elts) == 2:
                        d = _django_field(app, str(_const(el.elts[0])), el.elts[1], tables)
                        if d:
                            d["line"] = el.lineno
                            tdef["columns"].append(d)
                            if d["pk"]:
                                tdef["pk"].append(d["name"])
                            if d["fk"]:
                                tdef["fks"].append(dict(d["fk"], line=el.lineno))
                            if d.get("index"):
                                tdef["indexes"].append({"name": None, "columns": [d["name"]], "unique": False})
            ops.append(Op("create_table", t, line, table_def=tdef))
        elif k in ("AddField", "AlterField"):
            t = _django_table(app, str(model), tables)
            fnode = next((k2.value for k2 in n.keywords if k2.arg == "field"), n.args[2] if len(n.args) > 2 else None)
            d = _django_field(app, str(_kw(n, "name") or (_const(n.args[1]) if len(n.args) > 1 else "")), fnode, tables)
            if not d:
                continue
            if k == "AddField":
                ops.append(Op("add_column", t, line, column=d))
                if d.get("index"):
                    ops.append(Op("add_index", t, line, columns=[d["name"]]))
            else:
                ops.append(Op("alter_column", t, line, name=d["name"], column={"type": d["type"], "nullable": d["nullable"]}))
        elif k == "RemoveField":
            ops.append(Op("drop_column", _django_table(app, str(model), tables), line, name=str(_kw(n, "name") or (_const(n.args[1]) if len(n.args) > 1 else ""))))
        elif k == "RenameField":
            ops.append(Op("rename_column", _django_table(app, str(model), tables), line, name=_kw(n, "old_name"), to=_kw(n, "new_name")))
        elif k == "DeleteModel":
            ops.append(Op("drop_table", _django_table(app, str(model), tables), line))
        elif k == "RenameModel":
            ops.append(Op("rename_table", _django_table(app, str(_kw(n, "old_name")), tables), line,
                          to=_django_table(app, str(_kw(n, "new_name")), tables)))
        elif k == "AlterModelTable":
            ops.append(Op("rename_table", _django_table(app, str(model), tables), line, to=str(_kw(n, "table"))))
        elif k == "AddIndex":
            raw = ast.unparse(n)
            fields = re.findall(r"['\"](\w+)['\"]", re.search(r"fields=\[([^\]]*)\]", raw).group(1)) if "fields=[" in raw else []
            ops.append(Op("add_index", _django_table(app, str(model), tables), line, columns=fields))
        elif k == "AddConstraint":
            raw = ast.unparse(n)
            if "UniqueConstraint" in raw and "fields=" in raw:
                fields = re.findall(r"['\"](\w+)['\"]", re.search(r"fields=[\[(]([^\])]*)", raw).group(1))
                ops.append(Op("add_unique", _django_table(app, str(model), tables), line, columns=fields, unique=True))
        elif k == "RunSQL":
            s = _const(n.args[0]) if n.args else _kw(n, "sql")
            if isinstance(s, str):
                ops.extend(sql.parse(s, line))
            else:
                ops.append(Op("unknown", line=line, text="RunSQL with SQL built at run time"))
        elif k == "RunPython":
            ops.append(Op("data", None, line, text="RunPython: a data step in Python", extra={"verb": "PYTHON"}))
        elif k in ("Migration", "AlterModelOptions", "AlterModelManagers", "AlterUniqueTogether", "AlterIndexTogether",
                   "SeparateDatabaseAndState", "AlterOrderWithRespectTo", "RemoveIndex", "RemoveConstraint", "RenameIndex"):
            continue
        else:
            ops.append(Op("unknown", line=line, text=f"migrations.{k}(…) is not read"))
    return ops
