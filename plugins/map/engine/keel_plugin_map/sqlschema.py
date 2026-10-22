"""SQL migrations -> the schema they leave behind, for the Map page's database diagram.

    parse([(rel, text), ...]) -> {tables, relations, files, skipped}

The files are applied in the order given (the caller sorts them). This is a tolerant reader of DDL, not a SQL engine:
it understands CREATE TABLE / VIEW / INDEX, ALTER TABLE (add, drop, rename, alter and modify columns, add and drop
constraints, rename the table), DROP TABLE / VIEW / INDEX, RENAME TABLE and COMMENT ON, in the PostgreSQL, MySQL,
SQLite, H2 and SQL Server spellings that migrations use. Anything else (DML, functions, grants) is skipped, and a
statement it cannot read is counted in `skipped` rather than failing the map.

Every table, column, key and index carries the file and line it came from (`cite: {rel, line}`), and every table its
`changes`: the later statements that altered it.
"""

from __future__ import annotations

from .sqllex import (  # noqa: F401 - re-exported: sqlschema.py was one module
    column_list, Cur, DEFAULT_STOP, DOWN_MARK, split_top, strip_down_sections, TABLE_CONSTRAINT, Tok, tokens,
    TYPE_STOP, UP_MARK, _blank,
)
from .sqlmodel import (  # noqa: F401 - re-exported: sqlschema.py was one module
    ACTIONS, DEFAULT_SCHEMAS, Schema, Table, _key,
)
from .sqlddl import (  # noqa: F401 - re-exported: sqlschema.py was one module
    alter_table, comment_on, create_index, create_table, create_view, drop, statement, _action, _apply_column_def,
    _column, _drop_column, _drop_constraint, _drop_pk, _is_constraint, _references, _rename_column, _rename_table,
    _table_constraint, _view_columns,
)


# ------------------------------------------------------------------ the result

def _resolve(s: Schema, owner: Table, schema: str | None, name: str) -> Table | None:
    if schema:
        hit = s.get(schema, name)
        if hit:
            return hit
    hit = s.get(owner.schema, name) or s.get(None, name)
    if hit:
        return hit
    same = [t for t in s.tables.values() if t.name.lower() == name.lower()]
    return same[0] if len(same) == 1 else None


def table_id(t: Table) -> str:
    return f"{t.schema}.{t.name}" if t.schema and t.schema.lower() not in DEFAULT_SCHEMAS else t.name


def result(s: Schema) -> dict:
    ids = {_key(t.schema, t.name): table_id(t) for t in s.tables.values()}
    tables, relations = [], []
    for t in sorted(s.tables.values(), key=lambda t: table_id(t).lower()):
        tid = table_id(t)
        fks_out = []
        for n, f in enumerate(t.fks):
            target = _resolve(s, t, f["ref_schema"], f["ref_name"])
            ref_cols = list(f["ref_columns"]) or (list(target.pk["columns"]) if target and target.pk else [])
            to = ids[_key(target.schema, target.name)] if target else None
            fk = {"name": f["name"], "columns": list(f["columns"]), "ref_table": to,
                  "ref_name": f"{f['ref_schema']}.{f['ref_name']}" if f["ref_schema"] else f["ref_name"], "ref_columns": ref_cols,
                  "on_delete": f["on_delete"], "on_update": f["on_update"], "cite": f["cite"], "missing": target is None}
            fks_out.append(fk)
            for i, cn in enumerate(f["columns"]):
                if (col := t.col(cn)) and not col["fk"]:
                    col["fk"] = {"table": to or fk["ref_name"], "column": ref_cols[i] if i < len(ref_cols) else None,
                                 "missing": target is None}
            if target:
                cols = [t.col(cn) for cn in f["columns"]]
                key_sets = ([t.pk["columns"]] if t.pk else []) + [u["columns"] for u in t.uniques] + \
                    [i["columns"] for i in t.indexes if i["unique"] and not i["where"]]
                mine = {x.lower() for x in f["columns"]}       # the FK holds a whole key of its table: one row per parent
                one = any(ks and {x.lower() for x in ks} <= mine for ks in key_sets)
                relations.append({"id": f"fk:{tid}:{f['name'] or n}", "kind": "fk", "name": f["name"], "from": tid,
                                  "from_columns": list(f["columns"]), "to": to, "to_columns": ref_cols,
                                  "on_delete": f["on_delete"], "on_update": f["on_update"],
                                  "nullable": any(col is None or col["nullable"] for col in cols), "one_to_one": one,
                                  "self": to == tid, "cite": f["cite"]})
        uses = []
        for sch, nm in t.uses:
            target = _resolve(s, t, sch, nm)
            if target and target is not t:
                uid = ids[_key(target.schema, target.name)]
                if uid not in uses:
                    uses.append(uid)
                    relations.append({"id": f"uses:{tid}:{uid}", "kind": "uses", "name": None, "from": tid, "from_columns": [],
                                      "to": uid, "to_columns": [], "on_delete": None, "on_update": None, "nullable": False,
                                      "one_to_one": False, "self": False, "cite": t.cite})
        out = {"id": tid, "name": t.name, "schema": t.schema, "kind": t.kind, "cite": t.cite, "comment": t.comment,
               "columns": t.columns, "primary_key": t.pk, "uniques": t.uniques, "indexes": t.indexes, "foreign_keys": fks_out,
               "checks": t.checks, "changes": t.changes}
        if t.kind != "table":
            out["definition"] = t.definition
            out["uses"] = uses
        tables.append(out)
    return {"tables": tables, "relations": relations, "files": s.files, "skipped": s.skipped}


def parse(files: list[tuple[str, str]]) -> dict:
    s = Schema()
    for rel, text in files:
        text = strip_down_sections(text)
        s.start_file(rel, text)
        for toks in tokens(text):
            try:
                statement(s, toks, text)
            except Exception:                                 # noqa: BLE001 - one odd statement never fails the map
                s.skipped += 1
    return result(s)
