"""The schema changes every migration reader gives: one list of plain ops, whatever the framework.

    Op(kind, table, line, ...)   kinds: create_table, drop_table, rename_table, add_column, drop_column, alter_column,
                                 rename_column, add_fk, drop_constraint, add_unique, add_pk, add_index, drop_index,
                                 data (an INSERT / UPDATE / DELETE: a backfill or a cleanup), unknown (not read)

A column is a dict: {name, type, nullable (True / False / None = not said), default (text or None), pk, unique, auto,
fk ({table, columns: [..]} or None)}. A foreign key: {name, columns, ref_table, ref_columns, on_delete}.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

DEFAULT_SCHEMAS = {"public", "dbo", "main"}


@dataclass
class Op:
    kind: str
    table: str | None = None
    line: int = 0
    column: dict | None = None        # add_column, alter_column (the new definition, only the parts it changes)
    name: str | None = None           # a column, constraint or index name; rename's old name
    to: str | None = None             # rename's new name
    columns: list[str] = field(default_factory=list)
    unique: bool = False
    fk: dict | None = None
    table_def: dict | None = None     # create_table: {columns: [...], pk: [...], fks: [...], uniques: [[...]], indexes: [...]}
    text: str = ""                    # unknown and data: what the statement says (short)
    extra: dict[str, Any] = field(default_factory=dict)


def col(name: str, type_: str = "", *, nullable: bool | None = None, default: str | None = None, pk: bool = False,
        unique: bool = False, auto: bool = False, fk: dict | None = None) -> dict:
    return {"name": name, "type": type_, "nullable": nullable, "default": default, "pk": pk, "unique": unique,
            "auto": auto, "fk": fk}


def table_name(raw: str) -> str:
    """A table's name as the diagram shows it: quotes gone, the default schema (public, dbo) dropped."""
    parts = [p.strip().strip('"`[]') for p in raw.strip().split(".") if p.strip()]
    if len(parts) >= 2 and parts[-2].lower() in DEFAULT_SCHEMAS:
        parts = parts[-1:]
    return ".".join(parts[-2:]) if parts else raw


def short(text: str, n: int = 120) -> str:
    one = " ".join(text.split())
    return one if len(one) <= n else one[: n - 1] + "…"
