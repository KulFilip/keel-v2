"""Other migration formats -> ops: Rails (create_table / add_column / … in `change` or `up`, and db/schema.rb),
TypeORM and Knex (the SQL strings in `up`), Liquibase changelogs (XML or YAML) and Prisma's schema.prisma.
"""

from __future__ import annotations

import re
import xml.parsers.expat

import yaml

from . import sql
from .ops import Op, col, table_name

# ------------------------------------------------------------------ Rails

RAILS_TYPES = {"primary_key": "bigint", "string": "varchar", "text": "text", "integer": "integer", "bigint": "bigint",
               "float": "float", "decimal": "decimal", "numeric": "numeric", "datetime": "timestamp", "timestamp": "timestamp",
               "time": "time", "date": "date", "binary": "blob", "boolean": "boolean", "json": "json", "jsonb": "jsonb",
               "uuid": "uuid", "references": "bigint", "belongs_to": "bigint", "citext": "citext", "inet": "inet"}


def _sym(s: str) -> str:
    return s.strip().lstrip(":").strip("'\"")


def _opts(rest: str) -> dict[str, str]:
    return {m.group(1): m.group(2).strip() for m in re.finditer(r"(\w+):\s*(\{[^}]*\}|\[[^\]]*\]|\"[^\"]*\"|'[^']*'|[^,]+)", rest)}


def _plural(s: str) -> str:
    if s.endswith("y") and not s.endswith(("ay", "ey", "oy", "uy")):
        return s[:-1] + "ies"
    return s if s.endswith("s") else s + "s"


def _rails_col(table: str, kind: str, name: str, rest: str, line: int) -> list[Op]:
    o = _opts(rest)
    if kind in ("timestamps",):
        nul = o.get("null", "false") != "false"
        return [Op("add_column", table, line, column=col(c, "timestamp", nullable=nul)) for c in ("created_at", "updated_at")]
    if kind in ("references", "belongs_to"):
        base = name
        cname = f"{base}_id"
        typ = "uuid" if _sym(o.get("type", "")) == "uuid" else "bigint"
        d = col(cname, typ, nullable=o.get("null", "true") != "false")
        ops = []
        if o.get("polymorphic") == "true":
            ops.append(Op("add_column", table, line, column=col(f"{base}_type", "varchar", nullable=d["nullable"])))
        fk = o.get("foreign_key")
        if fk and fk != "false":
            m = re.search(r"to_table:\s*:?(\w+)", fk)
            d["fk"] = {"name": None, "columns": [cname], "ref_table": m.group(1) if m else _plural(base), "ref_columns": ["id"],
                       "on_delete": None}
        ops.append(Op("add_column", table, line, column=d))
        if o.get("index", "true") != "false":
            ops.append(Op("add_index", table, line, columns=[cname], unique="unique: true" in o.get("index", "")))
        return ops
    typ = RAILS_TYPES.get(kind, kind)
    if "limit" in o and typ == "varchar":
        typ += f"({o['limit']})"
    if "precision" in o and typ == "decimal":
        typ += f"({o['precision']},{o.get('scale', '0')})"
    d = col(name, typ, nullable=o.get("null", "true") != "false")
    if "default" in o:
        d["default"] = o["default"].strip("'\"") if o["default"] != "nil" else None
    ops = [Op("add_column", table, line, column=d)]
    if o.get("index") == "true":
        ops.append(Op("add_index", table, line, columns=[name]))
    if o.get("unique") == "true":
        d["unique"] = True
    return ops


def _cols_arg(s: str) -> list[str]:
    s = s.strip()
    if s.startswith("["):
        return [_sym(x) for x in s.strip("[]").split(",") if x.strip()]
    return [_sym(s)]


def rails(text: str) -> list[Op]:
    lines = text.split("\n")
    ops: list[Op] = []
    in_down = False
    block: tuple[str, str, dict] | None = None      # (kind create|change, table, create's options)
    tdef: dict | None = None
    tline = 0
    heredoc: tuple[str, int, list[str]] | None = None
    for i, raw in enumerate(lines, start=1):
        s = raw.strip()
        if heredoc:
            tag, start, buf = heredoc
            if s == tag:
                ops.extend(sql.parse("\n".join(buf), start + 1))
                heredoc = None
            else:
                buf.append(raw)
            continue
        if re.match(r"def\s+down\b", s):
            in_down = True
            continue
        if re.match(r"def\s+(up|change)\b", s):
            in_down = False
            continue
        if in_down or not s or s.startswith("#"):
            continue
        if block:
            if s == "end":
                if block[0] == "create":
                    for c in tdef["columns"]:
                        if c["name"] in tdef["pk"]:
                            c["pk"], c["nullable"] = True, False
                    ops.append(Op("create_table", block[1], tline, table_def=tdef))
                block, tdef = None, None
                continue
            m = re.match(r"\w+\.(\w+)\s*(.*)$", s)
            if not m:
                continue
            kind, rest = m.group(1), m.group(2)
            args = [a.strip() for a in re.split(r",(?![^\[]*\])", rest)] if rest else []
            name = _sym(args[0]) if args else ""
            others = ",".join(args[1:])
            t = block[1]
            if kind == "index":
                sub = [Op("add_index", t, i, columns=_cols_arg(args[0]) if args else [], unique="unique: true" in rest)]
            elif kind == "remove":
                sub = [Op("drop_column", t, i, name=_sym(a)) for a in args if not re.match(r"\w+:", a)]
            elif kind == "rename":
                sub = [Op("rename_column", t, i, name=name, to=_sym(args[1]) if len(args) > 1 else None)]
            elif kind in ("remove_references", "remove_belongs_to"):
                sub = [Op("drop_column", t, i, name=f"{name}_id")]
            elif kind == "change":
                sub = [Op("alter_column", t, i, name=name, column={"type": RAILS_TYPES.get(_sym(args[1]), _sym(args[1])) if len(args) > 1 else ""})]
            elif kind in RAILS_TYPES or kind == "timestamps":
                sub = _rails_col(t, kind, name, others, i)
            else:
                sub = [Op("unknown", t, i, text=s)]
            if block[0] == "create":
                for o in sub:
                    if o.kind == "add_column":
                        o.column["line"] = o.line
                        tdef["columns"].append(o.column)
                        if o.column.get("fk"):
                            tdef["fks"].append(dict(o.column["fk"], line=o.line))
                    elif o.kind == "add_index":
                        tdef["indexes"].append({"name": None, "columns": o.columns, "unique": o.unique})
                    else:
                        ops.append(o)
            else:
                ops.extend(sub)
            continue
        m = re.match(r"(create_table|change_table)\s*\(?\s*([:\"'][\w.]+['\"]?)\s*(,.*?)?\s*do\s*\|\w+\|", s)
        if m:
            t = table_name(_sym(m.group(2)))
            if m.group(1) == "create_table":
                o = _opts(m.group(3) or "")
                tdef = {"columns": [], "pk": [], "fks": [], "uniques": [], "indexes": []}
                if o.get("id") != "false":
                    pk_name = _sym(o.get("primary_key", "id"))
                    pk_type = "uuid" if _sym(o.get("id", "")) == "uuid" else "bigint"
                    tdef["columns"].append(col(pk_name, pk_type, nullable=False, pk=True, auto=pk_type == "bigint") | {"line": i})
                    tdef["pk"] = [pk_name]
                block, tline = ("create", t, o), i
            else:
                block = ("change", t, {})
            continue
        m = re.match(r"(\w+)\s*\(?\s*(.*?)\)?\s*$", s)
        if not m:
            continue
        verb, rest = m.group(1), m.group(2)
        args = [a.strip() for a in re.split(r",(?![^\[]*\])", rest)] if rest else []
        a0 = table_name(_sym(args[0])) if args else ""
        if verb == "add_column" and len(args) >= 3:
            ops.extend(_rails_col(a0, _sym(args[2]), _sym(args[1]), ",".join(args[3:]), i))
        elif verb in ("add_reference", "add_belongs_to") and len(args) >= 2:
            ops.extend(_rails_col(a0, "references", _sym(args[1]), ",".join(args[2:]), i))
        elif verb == "remove_column" and len(args) >= 2:
            ops.append(Op("drop_column", a0, i, name=_sym(args[1])))
        elif verb == "remove_columns":
            ops.extend(Op("drop_column", a0, i, name=_sym(a)) for a in args[1:] if not re.match(r"\w+:", a))
        elif verb in ("remove_reference", "remove_belongs_to") and len(args) >= 2:
            ops.append(Op("drop_column", a0, i, name=f"{_sym(args[1])}_id"))
        elif verb == "rename_column" and len(args) >= 3:
            ops.append(Op("rename_column", a0, i, name=_sym(args[1]), to=_sym(args[2])))
        elif verb == "change_column" and len(args) >= 3:
            o = _opts(",".join(args[3:]))
            ch = {"type": RAILS_TYPES.get(_sym(args[2]), _sym(args[2]))}
            if "null" in o:
                ch["nullable"] = o["null"] != "false"
            ops.append(Op("alter_column", a0, i, name=_sym(args[1]), column=ch))
        elif verb == "change_column_null" and len(args) >= 3:
            ops.append(Op("alter_column", a0, i, name=_sym(args[1]), column={"nullable": args[2] != "false"}))
            if len(args) >= 4:
                ops.append(Op("data", a0, i, text=f"fills {_sym(args[1])} where it is null", extra={"verb": "UPDATE"}))
        elif verb == "change_column_default" and len(args) >= 3:
            ops.append(Op("alter_column", a0, i, name=_sym(args[1]), column={"default": ",".join(args[2:])}))
        elif verb == "add_index" and len(args) >= 2:
            o = _opts(",".join(args[2:]))
            ops.append(Op("add_index", a0, i, name=_sym(o["name"]) if "name" in o else None, columns=_cols_arg(args[1]),
                          unique=o.get("unique") == "true"))
        elif verb == "remove_index":
            o = _opts(",".join(args[1:]))
            ops.append(Op("drop_index", a0, i, name=_sym(o["name"]) if "name" in o else None))
        elif verb == "add_foreign_key" and len(args) >= 2:
            o = _opts(",".join(args[2:]))
            to = table_name(_sym(args[1]))
            c = _sym(o["column"]) if "column" in o else f"{to[:-1] if to.endswith('s') else to}_id"
            fk = {"name": _sym(o["name"]) if "name" in o else None, "columns": [c], "ref_table": to,
                  "ref_columns": [_sym(o.get("primary_key", "id"))], "on_delete": _sym(o["on_delete"]).upper() if "on_delete" in o else None}
            ops.append(Op("add_fk", a0, i, name=fk["name"], fk=fk, columns=[c]))
        elif verb == "remove_foreign_key":
            ops.append(Op("drop_constraint", a0, i, name=_sym(args[1]) if len(args) > 1 else None))
        elif verb == "drop_table":
            ops.append(Op("drop_table", a0, i))
        elif verb == "rename_table" and len(args) >= 2:
            ops.append(Op("rename_table", a0, i, to=table_name(_sym(args[1]))))
        elif verb == "execute":
            hm = re.match(r"<<[~-]?['\"]?(\w+)['\"]?", rest)
            if hm:
                heredoc = (hm.group(1), i, [])
            else:
                lit = re.match(r"(['\"])(.*)\1", rest.strip("()"))
                ops.extend(sql.parse(lit.group(2), i) if lit else [Op("unknown", line=i, text="execute with SQL built at run time")])
        elif verb in ("enable_extension", "create_enum", "add_check_constraint", "remove_check_constraint", "reversible",
                      "class", "end", "def", "say_with_time", "say", "ActiveRecord", "require", "if", "unless", "else"):
            continue
        elif re.match(r"\w+\.(update_all|update|delete_all|insert_all|find_each|where)", s):
            ops.append(Op("data", None, i, text=s[:120], extra={"verb": "UPDATE"}))
    return ops


# ------------------------------------------------------------------ TypeORM, Knex: SQL strings in up()

def js_sql(text: str) -> list[Op]:
    m = re.search(r"\b(async\s+)?up\s*\(|exports\.up\s*=|export\s+(async\s+)?function\s+up\b", text)
    start = m.start() if m else 0
    d = re.search(r"\b(async\s+)?down\s*\(|exports\.down\s*=|export\s+(async\s+)?function\s+down\b", text[start + 1:])
    body = text[start: start + 1 + d.start()] if d else text[start:]
    line0 = text.count("\n", 0, start) + 1
    ops: list[Op] = []
    for cm in re.finditer(r"(?:\.query|\.raw|\.execute|\.schema\.raw|sql)\s*\(\s*(`|'|\")", body):
        q = cm.group(1)
        j = cm.end()
        buf = []
        while j < len(body) and body[j] != q:
            if body[j] == "\\" and j + 1 < len(body):
                buf.append(body[j + 1])
                j += 2
                continue
            buf.append(body[j])
            j += 1
        line = line0 + body.count("\n", 0, cm.end())
        s = "".join(buf)
        if "${" in s:
            s = re.sub(r"\$\{[^}]*\}", "x", s)
        ops.extend(sql.parse(s, line))
    if not ops and re.search(r"queryRunner\.(createTable|addColumn|dropColumn|createForeignKey)|knex\.schema\.|\.createTable\(", body):
        ops.append(Op("unknown", line=line0, text="the schema builder API (createTable / addColumn) is not read"))
    return ops


# ------------------------------------------------------------------ Liquibase

class _Node:
    def __init__(self, tag: str, attrs: dict, line: int):
        self.tag, self.attrs, self.line, self.kids, self.text = tag.split(":")[-1], attrs, line, [], ""


def _xml(text: str) -> _Node:
    root = _Node("#", {}, 0)
    stack = [root]
    p = xml.parsers.expat.ParserCreate()

    def start(tag, attrs):
        n = _Node(tag, attrs, p.CurrentLineNumber)
        stack[-1].kids.append(n)
        stack.append(n)

    def end(tag):
        stack.pop()

    def data(s):
        stack[-1].text += s

    p.StartElementHandler, p.EndElementHandler, p.CharacterDataHandler = start, end, data
    p.Parse(text, True)
    return root


def _lb_column(c: dict) -> dict:
    cons = c.get("constraints") or {}
    d = col(c.get("name", ""), str(c.get("type", "")), nullable=str(cons.get("nullable", "true")).lower() != "false",
            pk=str(cons.get("primaryKey", "false")).lower() == "true", unique=str(cons.get("unique", "false")).lower() == "true",
            auto=str(c.get("autoIncrement", "false")).lower() == "true")
    for k in ("defaultValue", "defaultValueNumeric", "defaultValueBoolean", "defaultValueComputed", "defaultValueDate"):
        if k in c:
            d["default"] = str(c[k])
    ref = cons.get("references") or cons.get("referencedTableName")
    if ref:
        t, _, cc = str(ref).partition("(")
        d["fk"] = {"name": cons.get("foreignKeyName"), "columns": [d["name"]], "ref_table": table_name(t),
                   "ref_columns": [cc.rstrip(")")] if cc else [cons.get("referencedColumnNames", "id")], "on_delete": cons.get("deleteCascade") and "CASCADE"}
    if d["pk"]:
        d["nullable"] = False
    return d


def _lb_change(kind: str, a: dict, cols: list[dict], line: int, text: str = "") -> list[Op]:
    t = table_name(a.get("tableName") or a.get("baseTableName") or "")
    if kind == "createTable":
        tdef = {"columns": [], "pk": [], "fks": [], "uniques": [], "indexes": []}
        for c in cols:
            d = _lb_column(c)
            d["line"] = c.get("_line", line)
            tdef["columns"].append(d)
            if d["pk"]:
                tdef["pk"].append(d["name"])
            if d["fk"]:
                tdef["fks"].append(dict(d["fk"], line=d["line"]))
        return [Op("create_table", t, line, table_def=tdef)]
    if kind == "addColumn":
        return [Op("add_column", t, c.get("_line", line), column=_lb_column(c)) for c in cols]
    if kind == "dropColumn":
        names = [a["columnName"]] if a.get("columnName") else [c.get("name") for c in cols]
        return [Op("drop_column", t, line, name=n) for n in names if n]
    if kind == "dropTable":
        return [Op("drop_table", t, line)]
    if kind == "renameTable":
        return [Op("rename_table", table_name(a.get("oldTableName", "")), line, to=table_name(a.get("newTableName", "")))]
    if kind == "renameColumn":
        return [Op("rename_column", t, line, name=a.get("oldColumnName"), to=a.get("newColumnName"))]
    if kind == "addForeignKeyConstraint":
        cs = [x.strip() for x in str(a.get("baseColumnNames", "")).split(",") if x.strip()]
        fk = {"name": a.get("constraintName"), "columns": cs, "ref_table": table_name(a.get("referencedTableName", "")),
              "ref_columns": [x.strip() for x in str(a.get("referencedColumnNames", "")).split(",") if x.strip()],
              "on_delete": a.get("onDelete")}
        return [Op("add_fk", t, line, name=fk["name"], fk=fk, columns=cs)]
    if kind == "dropForeignKeyConstraint" or kind == "dropUniqueConstraint":
        return [Op("drop_constraint", t, line, name=a.get("constraintName"))]
    if kind == "addUniqueConstraint":
        return [Op("add_unique", t, line, name=a.get("constraintName"), unique=True,
                   columns=[x.strip() for x in str(a.get("columnNames", "")).split(",") if x.strip()])]
    if kind == "addPrimaryKey":
        return [Op("add_pk", t, line, columns=[x.strip() for x in str(a.get("columnNames", "")).split(",") if x.strip()])]
    if kind == "createIndex":
        return [Op("add_index", t, line, name=a.get("indexName"), columns=[c.get("name") for c in cols if c.get("name")],
                   unique=str(a.get("unique", "false")).lower() == "true")]
    if kind == "dropIndex":
        return [Op("drop_index", t or None, line, name=a.get("indexName"))]
    if kind == "addNotNullConstraint":
        ops = []
        if a.get("defaultNullValue") is not None:
            ops.append(Op("data", t, line, text=f"fills {a.get('columnName')} where it is null", extra={"verb": "UPDATE"}))
        ops.append(Op("alter_column", t, line, name=a.get("columnName"), column={"nullable": False}))
        return ops
    if kind == "dropNotNullConstraint":
        return [Op("alter_column", t, line, name=a.get("columnName"), column={"nullable": True})]
    if kind == "modifyDataType":
        return [Op("alter_column", t, line, name=a.get("columnName"), column={"type": a.get("newDataType", "")})]
    if kind == "addDefaultValue":
        v = next((a[k] for k in a if k.startswith("defaultValue")), None)
        return [Op("alter_column", t, line, name=a.get("columnName"), column={"default": str(v)})]
    if kind in ("sql", "sqlFile"):
        return sql.parse(text, line) if text.strip() else [Op("unknown", line=line, text="sqlFile is not read")]
    if kind in ("update", "insert", "delete", "loadData", "loadUpdateData"):
        return [Op("data", t or None, line, text=f"{kind} {t}", extra={"verb": kind.upper()})]
    if kind in ("comment", "rollback", "preConditions", "validCheckSum", "tagDatabase", "output", "empty", "createSequence",
                "createView", "createProcedure", "setTableRemarks", "setColumnRemarks", "dropView", "dropSequence"):
        return []
    return [Op("unknown", t or None, line, text=f"{kind} is not read")]


def liquibase_xml(text: str) -> list[Op]:
    root = _xml(text)
    ops: list[Op] = []
    for log in root.kids:
        for cs in (k for k in log.kids if k.tag == "changeSet"):
            for ch in cs.kids:
                if ch.tag in ("rollback", "comment", "preConditions"):
                    continue
                cols = []
                for c in ch.kids:
                    if c.tag == "column":
                        d = dict(c.attrs)
                        d["_line"] = c.line
                        cons = next((x for x in c.kids if x.tag == "constraints"), None)
                        if cons:
                            d["constraints"] = dict(cons.attrs)
                        cols.append(d)
                ops.extend(_lb_change(ch.tag, dict(ch.attrs), cols, ch.line, ch.text))
    return ops


def liquibase_yaml(text: str) -> list[Op]:
    data = yaml.safe_load(text) or {}
    lines = text.split("\n")
    ops: list[Op] = []
    seen = 0

    def line_of(needle: str) -> int:
        nonlocal seen
        for k in range(seen, len(lines)):
            if needle in lines[k]:
                seen = k
                return k + 1
        return 1

    for item in data.get("databaseChangeLog", []) or []:
        cs = item.get("changeSet") if isinstance(item, dict) else None
        if not cs:
            continue
        for change in cs.get("changes", []) or []:
            for kind, a in (change or {}).items():
                a = a or {}
                line = line_of(f"{kind}:")
                cols = [dict(c.get("column", {})) for c in a.get("columns", []) or [] if isinstance(c, dict)]
                txt = a.get("sql", "") if kind == "sql" else ""
                ops.extend(_lb_change(kind, a, cols, line, txt))
    return ops


# ------------------------------------------------------------------ Prisma

PRISMA_TYPES = {"String": "text", "Int": "integer", "BigInt": "bigint", "Float": "double", "Decimal": "decimal",
                "Boolean": "boolean", "DateTime": "timestamp", "Json": "jsonb", "Bytes": "bytea"}


def prisma(text: str) -> list[Op]:
    """schema.prisma -> one create_table per model (a whole schema, not a change)."""
    ops: list[Op] = []
    models = {m.group(1) for m in re.finditer(r"^\s*model\s+(\w+)\s*\{", text, re.M)}
    enums = {m.group(1) for m in re.finditer(r"^\s*enum\s+(\w+)\s*\{", text, re.M)}
    maps: dict[str, str] = {}
    for m in re.finditer(r"^\s*model\s+(\w+)\s*\{(.*?)^\s*\}", text, re.M | re.S):
        mm = re.search(r"@@map\(\s*\"([^\"]+)\"", m.group(2))
        maps[m.group(1)] = mm.group(1) if mm else m.group(1)
    for m in re.finditer(r"^\s*model\s+(\w+)\s*\{(.*?)^\s*\}", text, re.M | re.S):
        name, body = m.group(1), m.group(2)
        line0 = text.count("\n", 0, m.start(2)) + 1
        t = maps[name]
        tdef = {"columns": [], "pk": [], "fks": [], "uniques": [], "indexes": []}
        fields: dict[str, str] = {}
        for k, raw in enumerate(body.split("\n")):
            s = raw.split("//")[0].strip()
            ln = line0 + k
            if not s:
                continue
            if s.startswith("@@"):
                cm = re.match(r"@@(id|unique|index)\(\s*(?:fields:\s*)?\[([^\]]*)\]", s)
                if cm:
                    cols = [fields.get(x.strip(), x.strip()) for x in cm.group(2).split(",") if x.strip()]
                    {"id": lambda: tdef.__setitem__("pk", cols),
                     "unique": lambda: tdef["uniques"].append({"name": None, "columns": cols}),
                     "index": lambda: tdef["indexes"].append({"name": None, "columns": cols, "unique": False})}[cm.group(1)]()
                continue
            fm = re.match(r"(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$", s)
            if not fm:
                continue
            fname, ftype, many, opt, attrs = fm.groups()
            if many or ftype in models:
                rel = re.search(r"@relation\([^)]*fields:\s*\[([^\]]*)\][^)]*references:\s*\[([^\]]*)\]", attrs)
                if rel and ftype in models:
                    cols = [x.strip() for x in rel.group(1).split(",")]
                    refs = [x.strip() for x in rel.group(2).split(",")]
                    od = re.search(r"onDelete:\s*(\w+)", attrs)
                    tdef["fks"].append({"name": None, "columns": cols, "ref_table": maps.get(ftype, ftype), "ref_columns": refs,
                                        "on_delete": od.group(1).upper() if od else None, "line": ln})
                continue
            colname = re.search(r"@map\(\s*\"([^\"]+)\"", attrs)
            cname = colname.group(1) if colname else fname
            fields[fname] = cname
            dm = re.search(r"@default\((.*?)\)(?=\s|$)", attrs)
            nt = re.search(r"@db\.(\w+(?:\([^)]*\))?)", attrs)
            d = col(cname, nt.group(1).lower() if nt else PRISMA_TYPES.get(ftype, "enum" if ftype in enums else ftype.lower()),
                    nullable=bool(opt), default=dm.group(1) if dm else None, pk="@id" in attrs, unique="@unique" in attrs,
                    auto=bool(dm and "autoincrement" in dm.group(1)))
            d["line"] = ln
            tdef["columns"].append(d)
            if d["pk"]:
                tdef["pk"].append(cname)
        for fk in tdef["fks"]:
            fk["columns"] = [fields.get(c, c) for c in fk["columns"]]
        ops.append(Op("create_table", t, text.count("\n", 0, m.start()) + 1, table_def=tdef))
    return ops
