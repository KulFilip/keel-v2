"""SQL DDL -> ops (ops.py). A tolerant reader of what migrations write, not a SQL engine: CREATE / ALTER / DROP TABLE,
ADD / DROP / ALTER / MODIFY / CHANGE / RENAME COLUMN, keys, foreign keys, unique constraints, CREATE / DROP INDEX and
RENAME TABLE in the PostgreSQL, MySQL, SQLite, H2 and SQL Server spellings. INSERT / UPDATE / DELETE become `data`
ops (a backfill or a cleanup). Views, functions, grants, comments and the like are skipped on purpose; a statement it
cannot read becomes an `unknown` op, never a silent skip.

    parse(text, line0=1) -> list[Op]      line0: the file line the text starts on (SQL inside PHP or Python strings)
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .ops import Op, col, short, table_name

DOWN_MARK = re.compile(r"^[ \t]*--[ \t]*(migrate:down|\+goose[ \t]+down)\b.*$", re.I | re.M)
UP_MARK = re.compile(r"^[ \t]*--[ \t]*(migrate:up|\+goose[ \t]+up)\b.*$", re.I | re.M)

# noise: statements a schema diagram does not draw (read, not "unknown")
SKIP_FIRST = {"grant", "revoke", "comment", "set", "begin", "commit", "start", "use", "do", "select", "analyze", "vacuum",
              "lock", "pragma", "declare", "exec", "execute", "call", "end", "rollback", "savepoint", "release", "reset",
              "refresh", "cluster", "reindex", "notify", "listen", "show", "with", "go", "delimiter", "truncate"}
SKIP_OBJECT = {"view", "function", "procedure", "trigger", "sequence", "extension", "type", "schema", "domain",
               "materialized", "policy", "rule", "role", "user", "database", "aggregate", "operator", "collation",
               "publication", "subscription", "event", "server", "statistics", "tablespace", "language", "cast",
               "synonym", "package", "default", "conversion", "transform", "foreign"}
TYPE_STOP = {"not", "null", "default", "primary", "unique", "references", "check", "constraint", "collate", "generated",
             "auto_increment", "autoincrement", "identity", "comment", "on", "as", "charset", "character", "first",
             "after", "visible", "invisible", "key", "using", "deferrable", "initially", "storage", "compression",
             "encode", "sparse", "with"}
CONSTRAINT_START = {"constraint", "primary", "unique", "foreign", "check", "exclude", "index", "key", "fulltext",
                    "spatial", "like", "period"}
SERIAL = re.compile(r"^(small|big)?serial\d?$", re.I)


@dataclass
class Tok:
    kind: str     # id, qid (quoted identifier), str, num, op
    val: str
    line: int

    def w(self, *words: str) -> bool:
        return self.kind == "id" and self.val.lower() in words

    @property
    def ident(self) -> bool:
        return self.kind in ("id", "qid")


def _blank(text: str, a: int, b: int) -> str:
    return text[:a] + re.sub(r"[^\n]", " ", text[a:b]) + text[b:]


def strip_down(text: str) -> str:
    """dbmate (`-- migrate:down`) and goose (`-- +goose Down`) keep the undo in the same file: drop that half."""
    while (m := DOWN_MARK.search(text)):
        up = UP_MARK.search(text, m.end())
        text = _blank(text, m.start(), up.start() if up else len(text))
    return text


def statements(text: str, line0: int = 1) -> list[list[Tok]]:
    """The statements as token lists: comments dropped, split at a top-level `;` (or a line that is only GO)."""
    out: list[list[Tok]] = []
    cur: list[Tok] = []
    i, n, line = 0, len(text), line0
    depth = 0
    while i < n:
        c = text[i]
        if c == "\n":
            line += 1
            i += 1
            # SQL Server's batch separator
            m = re.match(r"[ \t]*go[ \t]*(?=\n|$)", text[i:], re.I)
            if m and depth == 0:
                if cur:
                    out.append(cur)
                cur = []
                i += m.end()
            continue
        if c.isspace():
            i += 1
            continue
        if text.startswith("--", i) or c == "#" and (i == 0 or text[i - 1] in "\n \t"):
            j = text.find("\n", i)
            i = n if j < 0 else j
            continue
        if text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            line += text.count("\n", i, j)
            i = j
            continue
        if c == "$":
            m = re.match(r"\$([A-Za-z_]\w*)?\$", text[i:])
            if m:
                tag = m.group(0)
                j = text.find(tag, i + len(tag))
                j = n if j < 0 else j + len(tag)
                cur.append(Tok("str", text[i + len(tag): max(i + len(tag), j - len(tag))], line))
                line += text.count("\n", i, j)
                i = j
                continue
        if c in "'\"`[":
            close = {"'": "'", '"': '"', "`": "`", "[": "]"}[c]
            j = i + 1
            buf = []
            while j < n:
                if text[j] == close:
                    if j + 1 < n and text[j + 1] == close and close != "]":
                        buf.append(close)
                        j += 2
                        continue
                    break
                if text[j] == "\\" and c == "'" and j + 1 < n:
                    buf.append(text[j + 1])
                    j += 2
                    continue
                buf.append(text[j])
                j += 1
            kind = "str" if c == "'" else "qid"
            cur.append(Tok(kind, "".join(buf), line))
            line += text.count("\n", i, j)
            i = j + 1
            continue
        if c == ";" and depth == 0:
            if cur:
                out.append(cur)
            cur = []
            i += 1
            continue
        m = re.match(r"[A-Za-z_][\w$]*", text[i:])
        if m:
            cur.append(Tok("id", m.group(0), line))
            i += m.end()
            continue
        m = re.match(r"\d+(\.\d+)?", text[i:])
        if m:
            cur.append(Tok("num", m.group(0), line))
            i += m.end()
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth = max(0, depth - 1)
        m = re.match(r"::|<=|>=|<>|!=|\|\||.", text[i:], re.S)
        cur.append(Tok("op", m.group(0), line))
        i += m.end()
    if cur:
        out.append(cur)
    return out


class Cur:
    def __init__(self, toks: list[Tok]):
        self.t = toks
        self.i = 0

    def peek(self, k: int = 0) -> Tok | None:
        j = self.i + k
        return self.t[j] if j < len(self.t) else None

    def done(self) -> bool:
        return self.i >= len(self.t)

    def next(self) -> Tok | None:
        tok = self.peek()
        self.i += 1
        return tok

    def w(self, *words: str) -> bool:
        tok = self.peek()
        return bool(tok and tok.w(*words))

    def take(self, *words: str) -> bool:
        if self.w(*words):
            self.i += 1
            return True
        return False

    def seq(self, *words: str) -> bool:
        for k, wd in enumerate(words):
            tok = self.peek(k)
            if not tok or not tok.w(wd):
                return False
        self.i += len(words)
        return True

    def op(self, v: str) -> bool:
        tok = self.peek()
        if tok and tok.kind == "op" and tok.val == v:
            self.i += 1
            return True
        return False

    def name(self) -> str | None:
        """A possibly dotted name: schema.table, "Quoted"."name"."""
        tok = self.peek()
        if not tok or not tok.ident:
            return None
        parts = [tok.val]
        self.i += 1
        while self.peek() and self.peek().kind == "op" and self.peek().val == "." and self.peek(1) and self.peek(1).ident:
            parts.append(self.peek(1).val)
            self.i += 2
        return ".".join(parts)

    def group(self) -> list[Tok]:
        """The tokens inside the parentheses that start here (the parentheses consumed)."""
        if not self.op("("):
            return []
        depth, out = 1, []
        while not self.done():
            tok = self.next()
            if tok.kind == "op" and tok.val == "(":
                depth += 1
            elif tok.kind == "op" and tok.val == ")":
                depth -= 1
                if depth == 0:
                    break
            out.append(tok)
        return out


def split_top(toks: list[Tok]) -> list[list[Tok]]:
    """Split at commas outside parentheses."""
    out, cur, depth = [], [], 0
    for tok in toks:
        if tok.kind == "op" and tok.val == "(":
            depth += 1
        elif tok.kind == "op" and tok.val == ")":
            depth -= 1
        if tok.kind == "op" and tok.val == "," and depth == 0:
            out.append(cur)
            cur = []
            continue
        cur.append(tok)
    if cur:
        out.append(cur)
    return out


def names_in(toks: list[Tok]) -> list[str]:
    """Column names in a list such as (a, b DESC, lower(c)): the first identifier of each part."""
    out = []
    for part in split_top(toks):
        idents = [t for t in part if t.ident]
        if idents:
            out.append(idents[0].val)
    return out


def text_of(toks: list[Tok]) -> str:
    out = ""
    for k, tok in enumerate(toks):
        v = f"'{tok.val}'" if tok.kind == "str" else tok.val
        prev = toks[k - 1] if k else None
        glue = k == 0 or v in (")", ",", ".", "::") or (prev and prev.val in ("(", ".", "::") and prev.kind == "op")
        out += ("" if glue else " ") + v
    return out


def _type_of(c: Cur) -> str:
    parts: list[Tok] = []
    while not c.done():
        tok = c.peek()
        if tok.kind == "id" and tok.val.lower() in TYPE_STOP and parts:
            # "character varying", "double precision", "timestamp with time zone": part of the type
            if tok.w("character") and c.peek(1) and c.peek(1).w("varying"):
                pass
            elif tok.w("with", "without") and c.peek(1) and c.peek(1).w("time"):
                pass
            else:
                break
        if tok.kind == "op" and tok.val == "(":
            parts.append(Tok("op", "(", tok.line))
            inner = c.group()
            parts.extend(inner)
            parts.append(Tok("op", ")", tok.line))
            continue
        if tok.kind == "op" and tok.val not in ("[", "]"):
            break
        parts.append(c.next())
    return _join_type(parts)


def _join_type(parts: list[Tok]) -> str:
    """numeric(10,2), character varying(20), timestamp with time zone: spaces only between words."""
    out = ""
    for k, tok in enumerate(parts):
        prev = parts[k - 1] if k else None
        word = tok.kind in ("id", "qid", "num")
        if prev is not None and word and prev.kind in ("id", "qid", "num"):
            out += " "
        out += tok.val
    return out


def _expr(c: Cur, stop: set[str]) -> str:
    """A default's expression: up to the next column keyword at depth 0."""
    parts: list[Tok] = []
    while not c.done():
        tok = c.peek()
        if tok.kind == "id" and tok.val.lower() in stop and parts:
            break
        if tok.kind == "op" and tok.val == "(":
            line = tok.line
            inner = c.group()
            parts += [Tok("op", "(", line), *inner, Tok("op", ")", line)]
            continue
        parts.append(c.next())
    return text_of(parts)


def _references(c: Cur) -> dict:
    ref = table_name(c.name() or "")
    cols = names_in(c.group()) if c.peek() and c.peek().val == "(" else []
    fk = {"name": None, "columns": [], "ref_table": ref, "ref_columns": cols, "on_delete": None}
    while not c.done():
        if c.seq("on", "delete"):
            fk["on_delete"] = _action(c)
        elif c.seq("on", "update"):
            _action(c)
        elif c.take("match", "deferrable", "initially", "not", "deferred", "immediate", "full", "simple", "partial"):
            continue
        else:
            break
    return fk


def _action(c: Cur) -> str:
    words = []
    while c.w("cascade", "restrict", "set", "null", "default", "no", "action"):
        words.append(c.next().val.upper())
        if words[-1] in ("CASCADE", "RESTRICT", "NULL", "DEFAULT", "ACTION"):
            break
    return " ".join(words)


def column_def(toks: list[Tok]) -> dict | None:
    c = Cur(toks)
    name_tok = c.next()
    if not name_tok or not name_tok.ident:
        return None
    typ = _type_of(c)
    d = col(name_tok.val, typ)
    if SERIAL.match(typ.split("(")[0]):
        d["auto"] = True
    while not c.done():
        if c.seq("not", "null"):
            d["nullable"] = False
        elif c.take("null"):
            d["nullable"] = True
        elif c.take("default"):
            d["default"] = _expr(c, TYPE_STOP - {"with"})
            if d["default"].upper() == "NULL":
                d["default"] = None
                if d["nullable"] is None:
                    d["nullable"] = True
        elif c.seq("primary", "key"):
            d["pk"] = True
            c.take("asc", "desc", "autoincrement")
        elif c.take("unique"):
            d["unique"] = True
            c.take("key")
        elif c.take("references"):
            d["fk"] = _references(c)
            d["fk"]["columns"] = [d["name"]]
        elif c.take("auto_increment", "autoincrement", "identity"):
            d["auto"] = True
            if c.peek() and c.peek().val == "(":
                c.group()
        elif c.take("generated"):
            while c.take("always", "by", "default", "on", "null", "as", "identity", "stored", "virtual"):
                pass
            if c.peek() and c.peek().val == "(":
                c.group()
            d["auto"] = True
        elif c.take("constraint"):
            c.name()
        elif c.take("check"):
            c.group()
        elif c.take("collate", "comment", "charset"):
            c.next()
        elif c.seq("character", "set"):
            c.next()
        elif c.seq("on", "update"):
            _expr(c, TYPE_STOP)
        else:
            c.next()
    if d["pk"]:
        d["nullable"] = False
    return d


def _table_constraint(toks: list[Tok]) -> dict | None:
    """{kind: pk|fk|unique|index|check, name, columns, fk}."""
    c = Cur(toks)
    name = None
    if c.take("constraint"):
        name = c.name()
    if c.seq("primary", "key"):
        c.take("clustered", "nonclustered")
        return {"kind": "pk", "name": name, "columns": names_in(c.group())}
    if c.seq("foreign", "key"):
        if c.peek() and c.peek().ident:
            name = name or c.next().val
        cols = names_in(c.group())
        if not c.take("references"):
            return None
        fk = _references(c)
        fk["name"] = name
        fk["columns"] = cols
        return {"kind": "fk", "name": name, "columns": cols, "fk": fk}
    if c.take("unique"):
        c.take("key", "index", "clustered", "nonclustered")
        if c.peek() and c.peek().ident:
            name = name or c.next().val
        return {"kind": "unique", "name": name, "columns": names_in(c.group())}
    if c.take("index", "key", "fulltext", "spatial"):
        c.take("index", "key")
        if c.peek() and c.peek().ident:
            name = c.next().val
        return {"kind": "index", "name": name, "columns": names_in(c.group())}
    if c.take("check", "exclude", "like", "period"):
        return {"kind": "check", "name": name, "columns": []}
    return None


def _is_constraint(toks: list[Tok]) -> bool:
    first = toks[0] if toks else None
    if not first or first.kind != "id":
        return False
    if first.val.lower() in ("key", "index") and len(toks) > 1 and toks[1].kind == "id" and len(toks) > 2 \
            and not (toks[2].kind == "op" and toks[2].val == "("):
        return False   # a column named key or index: "key varchar(20)"
    return first.val.lower() in CONSTRAINT_START


def _create_table(c: Cur, line: int) -> list[Op]:
    c.seq("if", "not", "exists")
    raw = c.name()
    if not raw:
        return [Op("unknown", line=line, text="CREATE TABLE without a name")]
    t = table_name(raw)
    tdef = {"columns": [], "pk": [], "fks": [], "uniques": [], "indexes": []}
    if c.w("as") or not (c.peek() and c.peek().val == "("):
        return [Op("create_table", t, line, table_def=tdef, extra={"as_select": True})]
    for part in split_top(c.group()):
        if not part:
            continue
        if _is_constraint(part):
            k = _table_constraint(part)
            if not k:
                continue
            if k["kind"] == "pk":
                tdef["pk"] = k["columns"]
            elif k["kind"] == "fk":
                tdef["fks"].append(k["fk"])
            elif k["kind"] == "unique":
                tdef["uniques"].append({"name": k["name"], "columns": k["columns"]})
            elif k["kind"] == "index":
                tdef["indexes"].append({"name": k["name"], "columns": k["columns"], "unique": False})
            continue
        d = column_def(part)
        if d:
            d["line"] = part[0].line
            tdef["columns"].append(d)
            if d["fk"]:
                tdef["fks"].append(dict(d["fk"], line=part[0].line))
    for d in tdef["columns"]:
        if d["pk"] and d["name"] not in tdef["pk"]:
            tdef["pk"].append(d["name"])
    for d in tdef["columns"]:
        if d["name"] in tdef["pk"]:
            d["pk"] = True
            d["nullable"] = False
    return [Op("create_table", t, line, table_def=tdef)]


def _alter_table(c: Cur, line: int, stmt: str) -> list[Op]:
    c.seq("if", "exists")
    c.take("only")
    raw = c.name()
    if not raw:
        return [Op("unknown", line=line, text=stmt)]
    t = table_name(raw)
    ops: list[Op] = []
    for part in split_top(c.t[c.i:]):
        if not part:
            continue
        a = Cur(part)
        ln = part[0].line
        if a.take("add"):
            if a.w("constraint", "primary", "foreign", "unique", "check", "index", "key", "fulltext", "spatial", "exclude") \
                    and not (a.w("key", "index") and a.peek(1) and a.peek(1).ident and a.peek(2) and a.peek(2).ident):
                k = _table_constraint(part[1:])
                if not k:
                    ops.append(Op("unknown", t, ln, text=text_of(part)))
                elif k["kind"] == "pk":
                    ops.append(Op("add_pk", t, ln, columns=k["columns"]))
                elif k["kind"] == "fk":
                    ops.append(Op("add_fk", t, ln, name=k["name"], fk=k["fk"], columns=k["columns"]))
                elif k["kind"] == "unique":
                    ops.append(Op("add_unique", t, ln, name=k["name"], columns=k["columns"], unique=True))
                elif k["kind"] == "index":
                    ops.append(Op("add_index", t, ln, name=k["name"], columns=k["columns"]))
                continue
            a.take("column")
            a.seq("if", "not", "exists")
            # ADD (a int, b int): MySQL's list of columns
            if a.peek() and a.peek().val == "(":
                for sub in split_top(a.group()):
                    d = column_def(sub)
                    if d:
                        ops.append(Op("add_column", t, ln, column=d))
                continue
            d = column_def(part[a.i:])
            ops.append(Op("add_column", t, ln, column=d) if d else Op("unknown", t, ln, text=text_of(part)))
            continue
        if a.take("drop"):
            if a.take("constraint"):
                a.seq("if", "exists")
                ops.append(Op("drop_constraint", t, ln, name=a.name()))
            elif a.seq("foreign", "key"):
                ops.append(Op("drop_constraint", t, ln, name=a.name()))
            elif a.seq("primary", "key"):
                ops.append(Op("drop_constraint", t, ln, name="PRIMARY"))
            elif a.take("index", "key"):
                ops.append(Op("drop_index", t, ln, name=a.name()))
            else:
                a.take("column")
                a.seq("if", "exists")
                nm = a.name()
                ops.append(Op("drop_column", t, ln, name=nm) if nm else Op("unknown", t, ln, text=text_of(part)))
            continue
        if a.take("alter", "modify", "change"):
            verb = part[0].val.lower()
            a.take("column")
            if verb == "modify":
                d = column_def(part[a.i:])
                ops.append(Op("alter_column", t, ln, name=d["name"], column=_full(d)) if d else Op("unknown", t, ln, text=text_of(part)))
                continue
            if verb == "change":
                old = a.name()
                d = column_def(part[a.i:])
                if not old or not d:
                    ops.append(Op("unknown", t, ln, text=text_of(part)))
                    continue
                if d["name"].lower() != old.lower():
                    ops.append(Op("rename_column", t, ln, name=old, to=d["name"]))
                ops.append(Op("alter_column", t, ln, name=d["name"], column=_full(d)))
                continue
            nm = a.name()
            ch: dict = {}
            if a.seq("set", "data", "type") or a.take("type"):
                ch["type"] = _type_of(a)
                if a.take("using"):
                    _expr(a, set())
            elif a.seq("set", "not", "null"):
                ch["nullable"] = False
            elif a.seq("drop", "not", "null"):
                ch["nullable"] = True
            elif a.seq("set", "default"):
                ch["default"] = _expr(a, set())
            elif a.seq("drop", "default"):
                ch["default"] = None
                ch["default_dropped"] = True
            elif a.peek() and a.peek().ident and not a.w("set", "drop", "add"):
                # SQL Server / H2: ALTER COLUMN name type [NOT NULL]
                d = column_def(part[a.i - 1:])
                if d:
                    ch = _full(d)
            else:
                ops.append(Op("unknown", t, ln, text=text_of(part)) if not a.w("set", "drop") else Op("alter_column", t, ln, name=nm, column={}))
                continue
            ops.append(Op("alter_column", t, ln, name=nm, column=ch))
            continue
        if a.take("rename"):
            if a.take("column"):
                old = a.name()
                a.take("to")
                ops.append(Op("rename_column", t, ln, name=old, to=a.name()))
            elif a.take("to", "as"):
                ops.append(Op("rename_table", t, ln, to=table_name(a.name() or "")))
            elif a.take("constraint", "index", "key"):
                continue
            else:
                old = a.name()
                if a.take("to"):
                    ops.append(Op("rename_column", t, ln, name=old, to=a.name()))
                else:
                    ops.append(Op("unknown", t, ln, text=text_of(part)))
            continue
        if a.take("owner", "enable", "disable", "set", "cluster", "replica", "inherit", "no", "validate", "engine",
                  "default", "charset", "collate", "auto_increment", "comment", "row_format", "convert", "force",
                  "algorithm", "lock", "attach", "detach", "reset", "of", "not"):
            continue
        ops.append(Op("unknown", t, ln, text=text_of(part)))
    return ops


def _full(d: dict) -> dict:
    """MODIFY / CHANGE restate the whole column: nullable not said means NULL in MySQL."""
    out = {"type": d["type"], "nullable": d["nullable"] if d["nullable"] is not None else True, "default": d["default"]}
    if d["unique"]:
        out["unique"] = True
    if d["auto"]:
        out["auto"] = True
    return out


def _create_index(c: Cur, line: int, unique: bool) -> list[Op]:
    c.take("concurrently")
    c.seq("if", "not", "exists")
    name = None
    if not c.w("on"):
        name = c.name()
    if not c.take("on"):
        return [Op("unknown", line=line, text="CREATE INDEX")]
    c.take("only")
    t = table_name(c.name() or "")
    if c.take("using"):
        c.next()
    cols = names_in(c.group())
    partial = c.take("where")
    return [Op("add_index", t, line, name=name, columns=cols, unique=unique, extra={"partial": partial})]


def statement(toks: list[Tok]) -> list[Op]:
    c = Cur(toks)
    first = c.peek()
    line = first.line
    stmt = short(text_of(toks))
    if first.kind != "id":
        return [Op("unknown", line=line, text=stmt)]
    w = first.val.lower()
    if w == "create":
        c.next()
        c.seq("or", "replace")
        while c.take("temporary", "temp", "unlogged", "global", "local", "transient", "external", "virtual"):
            pass
        if c.take("table"):
            return _create_table(c, line)
        if c.take("unique"):
            c.take("clustered", "nonclustered")
            if c.take("index"):
                return _create_index(c, line, True)
        c.take("clustered", "nonclustered", "fulltext", "spatial", "bitmap")
        if c.take("index"):
            return _create_index(c, line, False)
        if c.peek() and c.peek().val.lower() in SKIP_OBJECT:
            return []
        return [Op("unknown", line=line, text=stmt)]
    if w == "alter":
        c.next()
        if c.take("table"):
            return _alter_table(c, line, stmt)
        if c.peek() and (c.peek().val.lower() in SKIP_OBJECT or c.w("index")):
            return []
        return [Op("unknown", line=line, text=stmt)]
    if w == "drop":
        c.next()
        c.take("temporary")
        if c.take("table"):
            c.seq("if", "exists")
            ops = []
            while not c.done():
                nm = c.name()
                if nm:
                    ops.append(Op("drop_table", table_name(nm), line))
                if not c.op(","):
                    break
            return ops or [Op("unknown", line=line, text=stmt)]
        if c.take("index"):
            c.take("concurrently")
            c.seq("if", "exists")
            nm = c.name()
            t = table_name(c.name() or "") if c.take("on") else None
            return [Op("drop_index", t, line, name=nm)]
        if c.peek() and c.peek().val.lower() in SKIP_OBJECT:
            return []
        return [Op("unknown", line=line, text=stmt)]
    if w == "rename":
        c.next()
        if c.take("table"):
            ops = []
            while not c.done():
                a = c.name()
                c.take("to")
                b = c.name()
                if a and b:
                    ops.append(Op("rename_table", table_name(a), line, to=table_name(b)))
                if not c.op(","):
                    break
            return ops
        return [Op("unknown", line=line, text=stmt)]
    if w in ("insert", "update", "delete", "merge", "replace", "copy", "upsert"):
        c.next()
        c.take("into", "from", "low_priority", "ignore", "only")
        c.take("into", "from")
        nm = c.name()
        return [Op("data", table_name(nm) if nm else None, line, text=stmt, extra={"verb": w.upper()})]
    if w == "sp_rename":
        return [Op("unknown", line=line, text=stmt)]
    if w in SKIP_FIRST:
        return []
    return [Op("unknown", line=line, text=stmt)]


def parse(text: str, line0: int = 1) -> list[Op]:
    ops: list[Op] = []
    for toks in statements(strip_down(text), line0):
        try:
            ops.extend(statement(toks))
        except Exception:                      # noqa: BLE001 - one odd statement never fails the diagram
            ops.append(Op("unknown", line=toks[0].line if toks else line0, text=short(text_of(toks))))
    return ops


DDL_IN_CODE = re.compile(r"\b(create|alter|drop)\s+table\b", re.I)
