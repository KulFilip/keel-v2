"""PHP migrations -> ops: Doctrine (`$this->addSql('…')`, the SQL read by sql.py) and Laravel (the Schema builder:
Schema::create / table / drop / rename and the Blueprint calls inside, plus DB::statement SQL). Only `up()` is read.
"""

from __future__ import annotations

import re

from . import sql
from .ops import Op, col, table_name


def up_part(text: str, up: str = "up", down: str = "down") -> tuple[str, int]:
    """The text from `function up(` to `function down(` (or the end), and the line it starts on."""
    m = re.search(rf"function\s+{up}\s*\(", text)
    if not m:
        return text, 1
    d = re.search(rf"function\s+{down}\s*\(", text[m.end():])
    end = m.end() + d.start() if d else len(text)
    return text[m.start():end], text.count("\n", 0, m.start()) + 1


def skip_ws(s: str, i: int) -> int:
    while i < len(s):
        if s[i].isspace():
            i += 1
        elif s.startswith("//", i) or s.startswith("#", i) and not s.startswith("#[", i):
            j = s.find("\n", i)
            i = len(s) if j < 0 else j
        elif s.startswith("/*", i):
            j = s.find("*/", i + 2)
            i = len(s) if j < 0 else j + 2
        else:
            break
    return i


def literal(s: str, i: int) -> tuple[str | None, int]:
    """One PHP string literal at i: '…', "…", heredoc or nowdoc. (value, end) or (None, i)."""
    if i >= len(s):
        return None, i
    c = s[i]
    if c in "'\"":
        j, out = i + 1, []
        while j < len(s) and s[j] != c:
            if s[j] == "\\" and j + 1 < len(s):
                nxt = s[j + 1]
                if c == "'":
                    out.append(nxt if nxt in "'\\" else "\\" + nxt)
                else:
                    out.append({"n": "\n", "t": "\t", "r": "", '"': '"', "\\": "\\", "$": "$"}.get(nxt, "\\" + nxt))
                j += 2
                continue
            out.append(s[j])
            j += 1
        return "".join(out), j + 1
    m = re.match(r"<<<[ \t]*(['\"]?)([A-Za-z_]\w*)\1\r?\n", s[i:])
    if m:
        tag = m.group(2)
        body_start = i + m.end()
        e = re.compile(rf"^[ \t]*{tag}\b", re.M).search(s, body_start)
        if not e:
            return None, i
        body = s[body_start:e.start()]
        indent = re.match(r"[ \t]*", s[e.start():]).group(0)
        if indent:
            body = "\n".join(ln[len(indent):] if ln.startswith(indent) else ln for ln in body.split("\n"))
        # the body starts one line below the <<<: keep that line in the value so line numbers stay true
        return "\n" + body, e.start() + len(indent) + len(tag)
    return None, i


def string_expr(s: str, i: int) -> tuple[str | None, int]:
    """Literals joined with `.` (other parts, e.g. a variable, become a space): the SQL keeps its line breaks."""
    parts: list[str] = []
    i = skip_ws(s, i)
    line = s.count("\n", 0, i)
    ok = False
    while True:
        here = s.count("\n", 0, i)
        v, j = literal(s, i)
        if v is None:
            m = re.match(r"\$\w+(->\w+)*|[A-Za-z_\\]+::\w+|\w+\([^()]*\)", s[i:])
            if not m:
                break
            v, j = " ", i + m.end()
        else:
            ok = True
        parts.append("\n" * max(0, here - line - sum(p.count("\n") for p in parts)) + v)
        i = skip_ws(s, j)
        if i < len(s) and s[i] == ".":
            i = skip_ws(s, i + 1)
            continue
        break
    return ("".join(parts) if ok else None), i


def sql_calls(text: str, names: str, offset_line: int = 1) -> list[Op]:
    """SQL in calls such as addSql( / executeStatement( / DB::statement(: each string read by sql.py at its own line."""
    ops: list[Op] = []
    for m in re.finditer(rf"(?:{names})\s*\(", text):
        start = m.end()
        line = offset_line + text.count("\n", 0, skip_ws(text, start))
        value, _ = string_expr(text, start)
        if value is None:
            ops.append(Op("unknown", line=line, text="SQL built at run time (not a plain string)"))
            continue
        ops.extend(sql.parse(value, line))
    return ops


def doctrine(text: str) -> list[Op]:
    body, line0 = up_part(text)
    ops = sql_calls(body, r"addSql|executeStatement|executeQuery|executeUpdate|->exec", line0)
    # the Schema API ($schema->createTable('x'), $table->addColumn(...)): not read here
    if not ops and re.search(r"\$schema->(createTable|getTable|dropTable)\s*\(", body):
        ln = line0 + body[: re.search(r"\$schema->", body).start()].count("\n")
        ops.append(Op("unknown", line=ln, text="Doctrine Schema API (createTable / addColumn) is not read"))
    return ops


# ------------------------------------------------------------------ Laravel

LARAVEL_TYPES = {
    "id": "bigint", "bigincrements": "bigint", "increments": "integer", "mediumincrements": "mediumint",
    "smallincrements": "smallint", "tinyincrements": "tinyint", "string": "varchar", "char": "char", "text": "text",
    "mediumtext": "mediumtext", "longtext": "longtext", "tinytext": "tinytext", "integer": "integer", "biginteger": "bigint",
    "mediuminteger": "mediumint", "smallinteger": "smallint", "tinyinteger": "tinyint", "unsignedbiginteger": "bigint",
    "unsignedinteger": "integer", "unsignedmediuminteger": "mediumint", "unsignedsmallinteger": "smallint",
    "unsignedtinyinteger": "tinyint", "decimal": "decimal", "unsigneddecimal": "decimal", "float": "float",
    "double": "double", "boolean": "boolean", "date": "date", "datetime": "datetime", "datetimetz": "datetimetz",
    "time": "time", "timetz": "timetz", "timestamp": "timestamp", "timestamptz": "timestamptz", "year": "year",
    "json": "json", "jsonb": "jsonb", "uuid": "uuid", "ulid": "char(26)", "binary": "blob", "enum": "enum", "set": "set",
    "ipaddress": "varchar(45)", "macaddress": "varchar(17)", "geometry": "geometry", "point": "point",
    "foreignid": "bigint", "foreignuuid": "uuid", "foreignulid": "char(26)", "foreignidfor": "bigint",
    "remembertoken": "varchar(100)", "softdeletes": "timestamp", "softdeletestz": "timestamptz", "vector": "vector",
}
AUTO = {"id", "bigincrements", "increments", "mediumincrements", "smallincrements", "tinyincrements"}


def _args(s: str) -> list:
    """Call arguments as values: strings, numbers, true/false/null, [..] lists; anything else as its text."""
    out: list = []
    i = 0
    while True:
        i = skip_ws(s, i)
        if i >= len(s):
            break
        v, j = literal(s, i)
        if v is not None:
            out.append(v)
            i = j
        elif s[i] == "[" or s.startswith("array(", i):
            open_ = "[" if s[i] == "[" else "("
            close = "]" if open_ == "[" else ")"
            k = i + (1 if open_ == "[" else 6)
            depth, start = 1, k
            while k < len(s) and depth:
                if s[k] in "'\"":
                    _, k = literal(s, k)
                    continue
                if s[k] in "[(":
                    depth += 1
                elif s[k] in "])":
                    depth -= 1
                k += 1
            out.append(_args(s[start:k - 1]))
            i = k
        else:
            m = re.match(r"[^,]+", s[i:])
            raw = m.group(0).strip() if m else ""
            low = raw.lower()
            out.append(True if low == "true" else False if low == "false" else None if low == "null"
                       else int(raw) if re.fullmatch(r"-?\d+", raw) else float(raw) if re.fullmatch(r"-?\d+\.\d+", raw)
                       else {"raw": raw})
            i += m.end() if m else 1
        i = skip_ws(s, i)
        if i < len(s) and s[i] in ",=>":
            # "key => value" pairs inside arrays: keep the value
            if s.startswith("=>", i):
                out.pop()
                i += 2
                continue
            i += 1
    return out


def chain(stmt: str) -> list[tuple[str, list]]:
    """$table->string('x', 20)->nullable()->default('a') -> [("string", ["x", 20]), ("nullable", []), ...]."""
    calls = []
    i = 0
    while True:
        m = re.compile(r"(?:->|::)\s*(\w+)\s*\(").search(stmt, i)
        if not m:
            break
        k, depth = m.end(), 1
        while k < len(stmt) and depth:
            if stmt[k] in "'\"":
                _, k = literal(stmt, k)
                continue
            if stmt[k] == "(":
                depth += 1
            elif stmt[k] == ")":
                depth -= 1
            k += 1
        calls.append((m.group(1), _args(stmt[m.end():k - 1])))
        i = k
    return calls


def split_statements(body: str, line0: int) -> list[tuple[str, int]]:
    out, i, start, depth = [], 0, 0, 0
    while i < len(body):
        c = body[i]
        if c in "'\"":
            _, i = literal(body, i)
            continue
        if body.startswith("//", i):
            j = body.find("\n", i)
            i = len(body) if j < 0 else j
            continue
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif c == ";" and depth <= 0:
            s = body[start:i]
            lead = len(s) - len(s.lstrip())
            out.append((s.strip(), line0 + body.count("\n", 0, start + lead)))
            start = i + 1
        i += 1
    return out


def _str(v) -> str | None:
    return v if isinstance(v, str) else None


def _default_text(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, dict):
        return str(v.get("raw"))
    if v is None:
        return "null"
    return repr(v) if isinstance(v, str) else str(v)


def _guess_ref(column: str) -> str:
    base = column[:-3] if column.endswith("_id") else column
    if base.endswith("y") and not base.endswith(("ay", "ey", "oy", "uy")):
        return base[:-1] + "ies"
    return base if base.endswith("s") else base + "s"


def blueprint(table: str, stmt: str, line: int, creating: bool) -> list[Op]:
    calls = chain(stmt)
    if not calls:
        return []
    name, args = calls[0]
    low = name.lower()
    mods = {m.lower(): a for m, a in calls[1:]}
    ops: list[Op] = []
    if low in ("timestamps", "timestampstz", "nullabletimestamps"):
        t = "timestamptz" if low.endswith("tz") else "timestamp"
        for c in ("created_at", "updated_at"):
            ops.append(Op("add_column", table, line, column=col(c, t, nullable=True)))
        return ops
    if low in ("softdeletes", "softdeletestz"):
        return [Op("add_column", table, line, column=col(_str(args[0]) if args else "deleted_at", LARAVEL_TYPES[low], nullable=True))]
    if low == "remembertoken":
        return [Op("add_column", table, line, column=col("remember_token", "varchar(100)", nullable=True))]
    if low in ("morphs", "nullablemorphs", "uuidmorphs", "nullableuuidmorphs"):
        base = _str(args[0]) or "morph"
        nullable = low.startswith("nullable")
        idt = "uuid" if "uuid" in low else "bigint"
        return [Op("add_column", table, line, column=col(f"{base}_type", "varchar", nullable=nullable)),
                Op("add_column", table, line, column=col(f"{base}_id", idt, nullable=nullable)),
                Op("add_index", table, line, columns=[f"{base}_type", f"{base}_id"])]
    if low in ("dropcolumn", "dropcolumns"):
        names = args[0] if args and isinstance(args[0], list) else args
        return [Op("drop_column", table, line, name=n) for n in names if isinstance(n, str)]
    if low == "droptimestamps":
        return [Op("drop_column", table, line, name=n) for n in ("created_at", "updated_at")]
    if low == "dropsoftdeletes":
        return [Op("drop_column", table, line, name="deleted_at")]
    if low == "renamecolumn" and len(args) >= 2:
        return [Op("rename_column", table, line, name=_str(args[0]), to=_str(args[1]))]
    if low == "rename" and args:
        return [Op("rename_table", table, line, to=table_name(_str(args[0]) or ""))]
    if low in ("index", "unique", "primary", "fulltext", "spatialindex"):
        cols = args[0] if args and isinstance(args[0], list) else ([args[0]] if args and isinstance(args[0], str) else [])
        idx_name = _str(args[1]) if len(args) > 1 else None
        if low == "primary":
            return [Op("add_pk", table, line, columns=cols)]
        if low == "unique":
            return [Op("add_unique", table, line, name=idx_name, columns=cols, unique=True)]
        return [Op("add_index", table, line, name=idx_name, columns=cols)]
    if low == "foreign":
        cols = args[0] if args and isinstance(args[0], list) else [_str(args[0])] if args else []
        ref_t = _str(mods.get("on", [None])[0]) if "on" in mods else None
        ref_c = mods.get("references", [])
        ref_c = ref_c[0] if ref_c and isinstance(ref_c[0], list) else ref_c
        fk = {"name": _str(args[1]) if len(args) > 1 else None, "columns": cols, "ref_table": table_name(ref_t or ""),
              "ref_columns": [c for c in ref_c if isinstance(c, str)], "on_delete": _on_delete(mods)}
        return [Op("add_fk", table, line, name=fk["name"], fk=fk, columns=cols)]
    if low in ("dropforeign", "dropunique", "dropindex", "dropprimary", "dropconstrainedforeignid", "dropforeignidfor"):
        a = args[0] if args else None
        nm = a if isinstance(a, str) else f"{table}_{'_'.join(x for x in a if isinstance(x, str))}" if isinstance(a, list) else None
        ops = [Op("drop_index" if low in ("dropindex",) else "drop_constraint", table, line, name=nm)]
        if low == "dropconstrainedforeignid" and isinstance(a, str):
            ops.append(Op("drop_column", table, line, name=a))
        return ops
    if low not in LARAVEL_TYPES:
        return [Op("unknown", table, line, text=f"$table->{name}(…) is not read")]
    if low in AUTO:
        cname = _str(args[0]) if args else "id"
        return [Op("add_column", table, line, column=col(cname or "id", LARAVEL_TYPES[low], nullable=False, pk=True, auto=True))]
    if low == "foreignidfor":
        model = args[0].get("raw", "") if args and isinstance(args[0], dict) else ""
        stem = re.sub(r"::class$", "", model).split("\\")[-1]
        cname = _str(args[1]) if len(args) > 1 else re.sub(r"(?<!^)(?=[A-Z])", "_", stem).lower() + "_id"
    else:
        cname = _str(args[0]) if args else None
    if not cname:
        return [Op("unknown", table, line, text=f"$table->{name}(…) without a column name")]
    typ = LARAVEL_TYPES[low]
    if low in ("string", "char") and len(args) > 1 and isinstance(args[1], int):
        typ += f"({args[1]})"
    elif low == "string":
        typ += "(255)"
    elif low in ("decimal", "unsigneddecimal") and len(args) > 2:
        typ += f"({args[1]},{args[2]})"
    elif low == "enum" and len(args) > 1 and isinstance(args[1], list):
        typ = "enum(" + ",".join(str(x) for x in args[1]) + ")"
    d = col(cname, typ, nullable="nullable" in mods and (not mods["nullable"] or mods["nullable"][0] is not False))
    if "default" in mods:
        d["default"] = _default_text(mods["default"][0] if mods["default"] else None)
    if "usecurrent" in mods:
        d["default"] = "CURRENT_TIMESTAMP"
    if "autoincrement" in mods:
        d["auto"] = True
    if "primary" in mods:
        d["pk"] = True
    if "unique" in mods:
        d["unique"] = True
    if "constrained" in mods or ("references" in mods and "on" in mods):
        if "constrained" in mods:
            ref_t = _str(mods["constrained"][0]) if mods["constrained"] else None
            ref_c = _str(mods["constrained"][1]) if len(mods["constrained"]) > 1 else "id"
            if not ref_t and low == "foreignidfor":
                ref_t = _guess_ref(cname)
            ref_t = ref_t or _guess_ref(cname)
        else:
            ref_t = _str(mods["on"][0]) if mods["on"] else ""
            r = mods["references"][0] if mods["references"] else "id"
            ref_c = r if isinstance(r, str) else "id"
        d["fk"] = {"name": None, "columns": [cname], "ref_table": table_name(ref_t or ""), "ref_columns": [ref_c or "id"],
                   "on_delete": _on_delete(mods)}
    if "change" in mods:
        ch = {"type": d["type"], "nullable": d["nullable"]}
        if d["default"] is not None:
            ch["default"] = d["default"]
        return [Op("alter_column", table, line, name=cname, column=ch)]
    ops = [Op("add_column", table, line, column=d)]
    if "index" in mods:
        ops.append(Op("add_index", table, line, columns=[cname]))
    return ops


def _on_delete(mods: dict) -> str | None:
    if "cascadeondelete" in mods:
        return "CASCADE"
    if "nullondelete" in mods:
        return "SET NULL"
    if "restrictondelete" in mods:
        return "RESTRICT"
    if "ondelete" in mods and mods["ondelete"]:
        return str(mods["ondelete"][0]).upper()
    return None


def _closure_body(text: str, i: int) -> tuple[str, int, int]:
    """From i (inside Schema::create( ... ), the body of the `function (...) { … }` and its start and end offsets."""
    b = text.find("{", i)
    if b < 0:
        return "", i, i
    k, depth = b + 1, 1
    while k < len(text) and depth:
        if text[k] in "'\"":
            _, k = literal(text, k)
            continue
        if text[k] == "{":
            depth += 1
        elif text[k] == "}":
            depth -= 1
        k += 1
    return text[b + 1:k - 1], b + 1, k


def laravel(text: str) -> list[Op]:
    body, line0 = up_part(text)
    ops: list[Op] = []
    pos = 0
    pat = re.compile(r"Schema::(?:connection\([^)]*\)->)?(create|table|drop|dropIfExists|rename|dropColumns?)\s*\(")
    stmt_pat = re.compile(r"DB::(statement|unprepared)\s*\(|DB::table\s*\(\s*['\"](\w+)['\"]\s*\)\s*->\s*(update|insert|delete|where)")
    events: list[tuple[int, str, re.Match]] = [(m.start(), "schema", m) for m in pat.finditer(body)]
    events += [(m.start(), "db", m) for m in stmt_pat.finditer(body)]
    for start, kind, m in sorted(events, key=lambda e: e[0]):
        if start < pos:
            continue
        line = line0 + body.count("\n", 0, start)
        if kind == "db":
            if m.group(1):
                value, _ = string_expr(body, m.end())
                ops.extend(sql.parse(value, line) if value else [Op("unknown", line=line, text="DB::statement with SQL built at run time")])
            else:
                ops.append(Op("data", table_name(m.group(2)), line, text=f"DB::table('{m.group(2)}')->{m.group(3)}(…)",
                              extra={"verb": m.group(3).upper()}))
            continue
        verb = m.group(1)
        args_start = m.end()
        name, j = literal(body, skip_ws(body, args_start))
        if not name:
            ops.append(Op("unknown", line=line, text=f"Schema::{verb} with a table name built at run time"))
            continue
        t = table_name(name)
        if verb in ("drop", "dropIfExists"):
            ops.append(Op("drop_table", t, line))
            continue
        if verb == "rename":
            k = skip_ws(body, j)
            to, _ = literal(body, skip_ws(body, k + 1)) if k < len(body) and body[k] == "," else (None, k)
            ops.append(Op("rename_table", t, line, to=table_name(to or "")))
            continue
        if verb in ("dropColumn", "dropColumns"):
            rest = body[j: body.find(")", j)]
            for cname in re.findall(r"['\"](\w+)['\"]", rest):
                ops.append(Op("drop_column", t, line, name=cname))
            continue
        inner, a, b = _closure_body(body, j)
        pos = b
        sub: list[Op] = []
        for stmt, ln in split_statements(inner, line0 + body.count("\n", 0, a)):
            if not re.match(r"\$\w+\s*->", stmt):
                if re.match(r"(DB::|Schema::)", stmt):
                    sub.extend(laravel_inline(stmt, ln))
                continue
            sub.extend(blueprint(t, stmt, ln, verb == "create"))
        if verb == "create":
            tdef = {"columns": [], "pk": [], "fks": [], "uniques": [], "indexes": []}
            rest: list[Op] = []
            for o in sub:
                if o.kind == "add_column":
                    o.column["line"] = o.line
                    tdef["columns"].append(o.column)
                    if o.column.get("fk"):
                        tdef["fks"].append(dict(o.column["fk"], line=o.line))
                    if o.column.get("pk"):
                        tdef["pk"].append(o.column["name"])
                elif o.kind == "add_pk":
                    tdef["pk"] = list(o.columns)
                elif o.kind == "add_fk":
                    tdef["fks"].append(dict(o.fk, line=o.line))
                elif o.kind == "add_unique":
                    tdef["uniques"].append({"name": o.name, "columns": o.columns})
                elif o.kind == "add_index":
                    tdef["indexes"].append({"name": o.name, "columns": o.columns, "unique": False})
                else:
                    rest.append(o)
            for c in tdef["columns"]:
                if c["name"] in tdef["pk"]:
                    c["pk"], c["nullable"] = True, False
            ops.append(Op("create_table", t, line, table_def=tdef))
            ops.extend(rest)
        else:
            ops.extend(sub)
    return ops


def laravel_inline(stmt: str, line: int) -> list[Op]:
    m = re.match(r"DB::(statement|unprepared)\s*\(", stmt)
    if m:
        value, _ = string_expr(stmt, m.end())
        return sql.parse(value, line) if value else []
    return []
