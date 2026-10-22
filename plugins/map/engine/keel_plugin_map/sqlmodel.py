"""The schema being built: Table and Schema (a part of sqlschema.py)."""

from __future__ import annotations

import bisect
import re
from dataclasses import dataclass, field

from .sqllex import Tok

DEFAULT_SCHEMAS = {"public", "dbo", "main"}
ACTIONS = ("cascade", "restrict", "set null", "set default", "no action")


# ------------------------------------------------------------------ the schema being built

def _key(schema: str | None, name: str) -> tuple[str, str]:
    s = (schema or "").lower()
    return ("" if s in DEFAULT_SCHEMAS else s, name.lower())


@dataclass
class Table:
    name: str
    schema: str | None
    kind: str                       # table | view | materialized view
    cite: dict
    columns: list[dict] = field(default_factory=list)
    pk: dict | None = None          # {name, columns, cite}
    uniques: list[dict] = field(default_factory=list)
    indexes: list[dict] = field(default_factory=list)
    fks: list[dict] = field(default_factory=list)
    checks: int = 0
    comment: str | None = None
    changes: list[dict] = field(default_factory=list)
    definition: str | None = None
    uses: list[tuple[str | None, str]] = field(default_factory=list)

    def col(self, name: str) -> dict | None:
        low = name.lower()
        return next((c for c in self.columns if c["name"].lower() == low), None)


class Schema:
    def __init__(self):
        self.tables: dict[tuple[str, str], Table] = {}
        self.index_owner: dict[str, tuple[str, str]] = {}   # index name -> table key
        self.files: list[str] = []
        self.skipped = 0
        self.rel = ""
        self.text = ""
        self._lines: list[int] = []

    # ---- positions
    def start_file(self, rel: str, text: str):
        self.rel, self.text = rel, text
        self._lines = [m.end() for m in re.finditer(r"\n", text)]
        self.files.append(rel)

    def cite(self, tok: Tok) -> dict:
        return {"rel": self.rel, "line": bisect.bisect_right(self._lines, tok.pos) + 1}

    def get(self, schema: str | None, name: str) -> Table | None:
        return self.tables.get(_key(schema, name))

    def note(self, t: Table, tok: Tok, what: str):
        t.changes.append({**self.cite(tok), "what": what})
