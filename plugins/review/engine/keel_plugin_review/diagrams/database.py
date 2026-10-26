"""The Database tab's data: what the change does to the database, before -> after, per table, with the migrations in
plain words, the risks keel sees and the files it could not read.

"Before" is the database at the review's base: the Database plugin's live schema when the api sends one and it does
not already hold the change, else the base commit's migrations (or its schema file). "After" is the head commit's
migrations; on the live schema, the live schema with the change's migrations applied.
"""

from __future__ import annotations

import re

from . import gitio, render, sql
from .detect import FRAMEWORK, alembic_order, in_tests, kind_of, order_key, read
from .ops import Op, short
from .schema import Schema, change_ops, describe, diff, related, risks

CANDIDATE = re.compile(r"(^|/)(migrations?|migrate|changelogs?|versions|flyway|liquibase|alembic)/|(^|/)Version\d+\.php$|"
                       r"\.sql$|(^|/)schema\.prisma$|(^|/)db/schema\.rb$|(^|/)database/migrations/", re.I)


def _candidates(paths: list[str]) -> list[str]:
    return [p for p in paths if CANDIDATE.search(p)]


def _sources(root: str, sha: str, paths: list[str]) -> list[tuple[str, str, str, str]]:
    """[(path, kind, role, text)] of the database files at sha, tests left out unless nothing else is found."""
    texts = gitio.read_many(root, sha, _candidates(paths))
    found = []
    for p, text in texts.items():
        if text is None:
            continue
        k = kind_of(p, text)
        if k and k[1] in ("migration", "schema"):
            found.append((p, k[0], k[1], text))
    real = [f for f in found if not in_tests(f[0])]
    return real or found


def _ordered(files: list[tuple[str, str, str, str]]) -> list[tuple[str, str, str, str]]:
    alem = [f for f in files if f[1] == "alembic"]
    rest = sorted((f for f in files if f[1] != "alembic"), key=lambda f: order_key(f[0]))
    if alem:
        chain = alembic_order([(f[0], f[3]) for f in alem])
        by_path = {f[0]: f for f in alem}
        rest += [by_path[p] for p, _ in chain]
    return rest


def _build(files: list[tuple[str, str, str, str]], into: Schema | None = None) -> tuple[Schema, str]:
    s = into or Schema()
    migs = [f for f in files if f[2] == "migration"]
    use = migs or [f for f in files if f[2] == "schema"]
    for path, kind, _, text in _ordered(use):
        try:
            for op in read(kind, path, text):
                s.apply(op, path)
        except Exception:                                   # noqa: BLE001 - one odd file never fails the diagram
            continue
    return s, ("migrations" if migs else "schema file" if use else "")


def _string_at(text: str, offset: int) -> tuple[str, int] | None:
    """The string literal that holds offset (', ", `, ''' or \"\"\"), as (value, offset of its start)."""
    line_start = text.rfind("\n", 0, offset) + 1
    seg = text[line_start:offset]
    q = max((seg.rfind(c), c) for c in ("'", '"', "`"))
    if q[0] < 0:
        return None
    start = line_start + q[0]
    quote = q[1]
    if text[max(0, start - 2):start + 1] == quote * 3:
        start -= 2
        quote = quote * 3
    end = text.find(quote, start + len(quote))
    if end < 0:
        return None
    return text[start + len(quote):end], start


def _code_sql(path: str, text: str, added: list[tuple[int, str]]) -> tuple[list[Op], bool]:
    """DDL in a changed code file's new lines: (ops, read). read is False when there was DDL keel could not read."""
    ops: list[Op] = []
    seen_starts = set()
    ok = True
    lines = text.split("\n")
    offsets = [0]
    for ln in lines:
        offsets.append(offsets[-1] + len(ln) + 1)
    for line, s in added:
        m = sql.DDL_IN_CODE.search(s)
        if not m:
            continue
        at = offsets[line - 1] + m.start() if line - 1 < len(offsets) else 0
        lit = _string_at(text, at)
        if lit:
            value, start = lit
            if start in seen_starts:
                continue
            seen_starts.add(start)
            first = text.count("\n", 0, start) + 1
        else:
            end = text.find(";", at)
            value = text[at: end if end > 0 else len(text)]
            first = line
        got = [o for o in sql.parse(value, first) if o.kind != "data"]
        if not got or all(o.kind == "unknown" for o in got):
            ok = False
        ops.extend(got)
    return ops, ok


def build(root: str, base: str, head: str, files: list[dict], head_paths: list[str], base_paths: list[str],
          head_texts: dict[str, str | None], live: dict | None = None, live_name: str | None = None) -> dict:
    changed: list[dict] = []          # the change's database files
    not_parsed: list[dict] = []
    deleted_texts = gitio.read_many(root, base, [f.get("from") or f["path"] for f in files if f.get("status", "")[:1] in ("D", "M", "R")])
    added = gitio.added_lines(root, base, head, [f["path"] for f in files if f.get("status", "")[:1] != "D"])
    code_ops: list[tuple[str, Op]] = []
    for f in files:
        path, st = f["path"], (f.get("status") or "M")[:1]
        text = head_texts.get(path) if st != "D" else deleted_texts.get(path)
        k = kind_of(path, text)
        if k is None:
            if st != "D" and text and not in_tests(path) and any(sql.DDL_IN_CODE.search(s) for _, s in added.get(path, [])):
                ops, ok = _code_sql(path, text, added.get(path, []))
                entry = {"path": path, "framework": "SQL in code", "status": st, "role": "code", "parsed": ok and bool(ops),
                         "steps": [{"line": o.line, "text": describe(o), "kind": o.kind, "table": o.table} for o in ops]}
                changed.append(entry)
                code_ops += [(path, o) for o in ops if o.kind != "unknown"]
                if not entry["parsed"]:
                    first = next((ln for ln, s in added.get(path, []) if sql.DDL_IN_CODE.search(s)), 1)
                    not_parsed.append({"path": path, "line": first, "why": "SQL built in code that keel could not read"})
            continue
        kind, role = k
        entry = {"path": path, "framework": FRAMEWORK.get(kind, kind), "status": st, "role": role, "parsed": True, "steps": [],
                 "kind": kind}
        if role == "mapping":
            entry["parsed"] = False
            not_parsed.append({"path": path, "line": 1, "why": f"{FRAMEWORK['entity']}: keel does not read entity classes"})
        elif st == "D":
            entry["steps"] = [{"line": 0, "text": "the migration file is deleted", "kind": "deleted", "table": None}]
        elif text is None:
            entry["parsed"] = False
            not_parsed.append({"path": path, "line": 1, "why": "the file is binary or too big to read"})
        else:
            try:
                ops = read(kind, path, text)
            except Exception as exc:                        # noqa: BLE001
                ops = None
                entry["parsed"] = False
                not_parsed.append({"path": path, "line": 1, "why": f"keel could not read it ({type(exc).__name__})"})
            if ops is not None:
                entry["ops"] = ops
                entry["steps"] = [{"line": o.line, "text": describe(o), "kind": o.kind, "table": o.table} for o in ops]
                unknown = [o for o in ops if o.kind == "unknown"]
                if ops and len(unknown) == len(ops):
                    entry["parsed"] = False
                    not_parsed.append({"path": path, "line": unknown[0].line, "why": unknown[0].text or "no statement could be read"})
                elif unknown:
                    entry["partly"] = True
                    for o in unknown[:3]:
                        not_parsed.append({"path": path, "line": o.line, "why": f"one statement not read: {short(o.text, 80)}"})
                if not ops:
                    entry["steps"] = [{"line": 0, "text": "no schema change found in it", "kind": "none", "table": None}]
        changed.append(entry)

    shown = bool(changed)
    if not shown:
        return {"shown": False, "count": 0}

    base_files = _sources(root, base, base_paths)
    head_files = _sources(root, head, head_paths)
    change_migs = [e for e in changed if e["role"] == "migration" and e.get("ops") is not None]
    change_migs.sort(key=lambda e: order_key(e["path"]))
    if any(e.get("kind") == "alembic" for e in change_migs):
        chain = [p for p, _ in alembic_order([(e["path"], head_texts.get(e["path"]) or "") for e in change_migs if e.get("kind") == "alembic"])]
        change_migs = [e for e in change_migs if e.get("kind") != "alembic"] + [e for p in chain for e in change_migs if e["path"] == p]
    steps: list[tuple[str, Op]] = [(e["path"], o) for e in change_migs for o in e["ops"] if o.kind != "unknown"]

    notes: list[str] = []
    before_source = ""
    before = None
    if live and live.get("tables"):
        lv = Schema.from_live(live)
        has_it = [o for _, o in steps if (o.kind == "create_table" and lv.has(o.table)) or
                  (o.kind == "add_column" and lv.get(o.table) and o.column and o.column["name"].lower() in lv.get(o.table)["columns"])]
        if has_it and base_files:
            notes.append(f"The live database{f' ({live_name})' if live_name else ''} already has this change, so keel compared "
                         "against the base branch's migrations instead.")
        else:
            before = lv
            before_source = f"the live database{f' ({live_name})' if live_name else ''}"
    if before is None:
        before, kind = _build(base_files)
        before_source = {"migrations": "the base branch's migrations", "schema file": "the base branch's schema file"}.get(kind, "")
        if not kind:
            before_source = "nothing (the base has no migrations keel can read)"
    if before_source.startswith("the live"):
        after = before.copy()
        for path, o in steps:
            after.apply(o, path)
        after_note = "the live database with this change's migrations"
    else:
        after, _ = _build(head_files)
        after_note = "the head's migrations"
    for path, o in code_ops:
        after.apply(o, path)

    renames = {o.table: o.to for _, o in steps if o.kind == "rename_table" and o.table and o.to}
    col_renames = {((renames.get(o.table) or o.table), o.name): o.to for _, o in steps if o.kind == "rename_column" and o.table and o.name and o.to}
    tables = diff(before, after, renames, col_renames)
    if not steps and tables:
        steps = change_ops(before, after, tables)
    steps += code_ops

    db_paths = [p for p, *_ in head_files] + [e["path"] for e in changed]

    def refs(name: str | None) -> list[dict]:
        if not name:
            return []
        camel = re.sub(r"_([a-z])", lambda m: m.group(1).upper(), name)
        hits = gitio.grep(root, head, [name, camel], db_paths)
        return [{"path": p, "line": ln} for p, ln in hits]

    risk = risks(before, after, steps, refs)
    base_paths_set = set(base_paths)
    for e in changed:
        if e["role"] == "migration" and e["status"] == "M" and e["path"] in base_paths_set:
            risk.insert(0, {"kind": "edited_migration", "severity": "high", "path": e["path"], "line": 1,
                            "text": "an existing migration is edited: databases that already ran it will not get the change "
                                    "(add a new migration instead)"})
        if e["role"] == "migration" and e["status"] == "D":
            risk.insert(0, {"kind": "deleted_migration", "severity": "medium", "path": e["path"], "line": 1,
                            "text": "a migration file is deleted: databases that ran it keep its change, new ones will not have it"})
    order = {"high": 0, "medium": 1, "low": 2}
    risk.sort(key=lambda r: order.get(r["severity"], 3))

    rel = related(after, before, tables)
    shown_tables = tables[:40] + rel
    if len(tables) > 40:
        notes.append(f"{len(tables) - 40} more changed tables are not drawn (the list shows them).")
    for e in changed:
        e.pop("ops", None)
        e.pop("kind", None)
    count = sum(1 for t in tables) + len({n["path"] for n in not_parsed})
    note = f"before: {before_source}; after: {after_note}"
    return {
        "shown": True,
        "count": count,
        "before": before_source,
        "after": after_note,
        "notes": notes,
        "tables": shown_tables,
        "changes": {"new": sum(1 for t in tables if t["status"] == "new"),
                    "changed": sum(1 for t in tables if t["status"] == "changed"),
                    "removed": sum(1 for t in tables if t["status"] == "removed")},
        "migrations": changed,
        "risks": risk,
        "not_parsed": not_parsed,
        "mermaid": render.er_mermaid(shown_tables) if shown_tables else "",
        "ascii": render.er_ascii(shown_tables, note) if shown_tables else
        "database: no table change read" + (f" ({len(not_parsed)} file(s) not read: open them)" if not_parsed else ""),
        "table_names": [t["name"] for t in tables],
    }
