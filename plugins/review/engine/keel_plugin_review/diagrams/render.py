"""The two diagrams as text: Mermaid (erDiagram, flowchart LR) for the web and a pull request's description, and plain
ASCII in keel's diagram style (+- boxes -+, [+] new, [~] changed, [-] removed) for keel TUI, the IDEs and as the
fallback when Mermaid cannot draw. Pure and deterministic: the same data gives the same text."""

from __future__ import annotations

import re

MARK = {"new": "[+]", "added": "[+]", "changed": "[~]", "removed": "[-]", "same": "   ", "related": "   "}
WORD = {"new": "+ new", "added": "+ new", "changed": "~ changed", "removed": "- removed"}
CLASSDEF = [
    "classDef added fill:#2e9e5b33,stroke:#2e9e5b,stroke-width:2px",
    "classDef changed fill:#d9922e33,stroke:#d9922e,stroke-width:2px",
    "classDef removed fill:#d6453d22,stroke:#d6453d,stroke-width:2px,stroke-dasharray:5 3",
    "classDef faded fill:#8881,stroke:#8888,stroke-dasharray:3 3,color:#888",
]
SHORT_TYPES = [(r"timestamp(\(\d+\))? with time zone", "timestamptz"), (r"timestamp(\(\d+\))? without time zone", "timestamp"),
               (r"character varying", "varchar"), (r"double precision", "double"), (r"\s+unsigned", "_unsigned")]


def mid(s: str) -> str:
    """A Mermaid id: letters, digits and _."""
    out = re.sub(r"[^A-Za-z0-9_]", "_", s)
    return out if re.match(r"[A-Za-z_]", out) else "t_" + out


def mlabel(s: str) -> str:
    return (s or "").replace('"', "#quot;").replace("\n", " ")


def mtype(t: str) -> str:
    t = (t or "").strip().lower() or "unknown"
    for rx, rep in SHORT_TYPES:
        t = re.sub(rx, rep, t)
    t = t.replace(",", "-").replace(" ", "_").replace("'", "")
    t = re.sub(r"[^a-z0-9_()\[\]\-]", "", t)
    return t if re.match(r"[a-z]", t) else "t_" + t


# ------------------------------------------------------------------ database

def er_mermaid(tables: list[dict]) -> str:
    lines = ["erDiagram"]
    classes: dict[str, list[str]] = {"added": [], "changed": [], "removed": [], "faded": []}
    for t in tables:
        eid = mid(t["name"])
        st = t["status"]
        label = {"new": f"+ {t['name']}", "changed": f"~ {t['name']}", "removed": f"- {t['name']}"}.get(st, t["name"])
        if t.get("renamed_from"):
            label += f" (was {t['renamed_from']})"
        lines.append(f'  {eid}["{mlabel(label)}"] {{')
        for c in t["columns"]:
            keys = [k for k, on in (("PK", c.get("pk")), ("FK", c.get("fk")), ("UK", c.get("unique") and not c.get("pk"))) if on]
            name = re.sub(r"[^A-Za-z0-9_\-]", "_", c["name"]) or "column"
            if not re.match(r"[A-Za-z_]", name):
                name = "c_" + name
            note = {"new": "+ new", "removed": "- removed"}.get(c["status"]) if st not in ("new", "removed") else None
            if c["status"] == "changed":
                note = "~ " + (c.get("was") or "changed")
            if c.get("fk") and not note:
                note = "→ " + c["fk"]
            attr = f"    {mtype(c.get('type'))} {name}"
            if keys:
                attr += " " + ", ".join(keys)
            if note:
                attr += f' "{mlabel(note)}"'
            lines.append(attr)
        if not t["columns"]:
            lines.append("    unknown no_columns_read")
        lines.append("  }")
        classes[{"new": "added", "changed": "changed", "removed": "removed"}.get(st, "faded")].append(eid)
    names = {t["name"].lower(): t for t in tables}
    seen = set()
    for t in tables:
        for f in t.get("fks") or []:
            ref = (f.get("ref_table") or "").lower()
            if ref not in names:
                continue
            key = (t["name"], ref, ",".join(f.get("columns") or []))
            if key in seen:
                continue
            seen.add(key)
            child_cols = {c["name"].lower(): c for c in t["columns"]}
            nullable = any((child_cols.get(x.lower()) or {}).get("nullable") is not False for x in f.get("columns") or [])
            parent = "|o" if nullable else "||"
            mark = {"new": "+ ", "removed": "- "}.get(f.get("status") or "", "")
            lines.append(f'  {mid(names[ref]["name"])} {parent}--o{{ {mid(t["name"])} : "{mlabel(mark + ",".join(f.get("columns") or []))}"')
    lines += ["  " + c for c in CLASSDEF]
    for cls, ids in classes.items():
        if ids:
            lines.append(f"  class {','.join(ids)} {cls}")
    return "\n".join(lines) + "\n"


def _box(title: str, rows: list[str], inner: int) -> list[str]:
    t = title[: inner - 1]
    top = "+- " + t + " " + "-" * max(0, inner - len(t) - 2) + "+"
    body = ["| " + r[: inner - 1].ljust(inner) + "|" for r in rows]
    return [top, *body, "+" + "-" * (inner + 1) + "+"]


def _side_by_side(boxes: list[list[str]], width: int, gap: int = 2) -> list[str]:
    out: list[str] = []
    row: list[list[str]] = []
    used = 0

    def flush():
        h = max(len(b) for b in row)
        for k in range(h):
            out.append((" " * gap).join((b[k] if k < len(b) else " " * len(b[0])) for b in row).rstrip())

    for b in boxes:
        w = len(b[0])
        if row and used + gap + w > width:
            flush()
            row, used = [], 0
        used += (gap if row else 0) + w
        row.append(b)
    if row:
        flush()
    return out


def ascii_text(s: str) -> str:
    return (s or "").replace("→", "->").replace("×", "x").replace("·", "-").replace("—", "-").replace("…", "...") \
        .encode("ascii", "replace").decode()


def er_ascii(tables: list[dict], relations_note: str = "", width: int = 100) -> str:
    counts = {k: sum(1 for t in tables if t["status"] == k) for k in ("new", "changed", "removed", "related")}
    head = ", ".join(f"{n} {k}" for k, n in counts.items() if n) or "no table"
    out = [f"database: {head} table(s)" + (f" ({relations_note})" if relations_note else ""), ""]
    boxes = []
    for t in tables:
        rows = []
        for c in t["columns"]:
            tag = "PK" if c.get("pk") else "FK" if c.get("fk") else "  "
            extra = []
            if c.get("fk"):
                extra.append(f"-> {c['fk']}")
            if c.get("unique") and not c.get("pk"):
                extra.append("UQ")
            if c.get("nullable") is False and not c.get("pk"):
                extra.append("not null")
            if c["status"] == "changed" and c.get("was"):
                extra.append(f"({c['was']})")
            mark = MARK.get(c["status"], "   ") if t["status"] not in ("new", "removed") else "   "
            rows.append(ascii_text(f"{mark} {tag} {c['name']} {c.get('type') or ''}" + (" " + " ".join(extra) if extra else "")))
        for i in t.get("indexes") or []:
            if i.get("status") in ("new", "removed"):
                rows.append(ascii_text(f"{MARK[i['status']]} {'unique ' if i.get('unique') else ''}index ({', '.join(i.get('columns') or [])})"))
        if not rows:
            rows.append("(no columns read)")
        title = f"{MARK.get(t['status'], '').strip()} {t['name']}".strip() + (" (related)" if t["status"] == "related" else "")
        if t.get("renamed_from"):
            title += f" (was {t['renamed_from']})"
        inner = max(24, min(48, max(len(r) for r in rows) + 1, (width - 2) // 2 - 3))
        boxes.append(_box(ascii_text(title), rows, inner))
    out += _side_by_side(boxes, width)
    rels = []
    for t in tables:
        for f in t.get("fks") or []:
            if f.get("status") == "same" and t["status"] == "related":
                pass
            mark = MARK.get(f.get("status") or "same", "   ")
            rc = ",".join(f.get("ref_columns") or [])
            od = f", on delete {f['on_delete'].lower()}" if f.get("on_delete") else ""
            rels.append(ascii_text(f"  {mark} {t['name']}.{','.join(f.get('columns') or [])} --> {f.get('ref_table')}{'.' + rc if rc else ''}{od}"))
    if rels:
        out += ["", "relations:", *sorted(set(rels))]
    return "\n".join(out)


# ------------------------------------------------------------------ system

SHAPE = {
    "db": ('[("', '")]'), "queue": ('[/"', '"/]'), "http-out": ('{{"', '"}}'), "http-in": ('(["', '"])'),
    "cron": ('(["', '"])'), "cli": ('(["', '"])'),
}
NODE_SHAPE = {"repository": ('[["', '"]]'), "consumer": ('>"', '"]'), "migration": ('[/"', '"\\]'), "config": ('[("', '")]')}
EXT_ICON = {"db": "(db)", "queue": "(queue)", "http-out": "(http)", "http-in": "(http in)", "cron": "(cron)", "cli": "(cli)"}


def system_mermaid(sysg: dict) -> str:
    nodes = {n["id"]: n for n in sysg["nodes"]}
    lines = ["flowchart LR"]
    classes: dict[str, list[str]] = {"added": [], "changed": [], "removed": [], "faded": []}
    for g in sysg["groups"]:
        lines.append(f'  subgraph {mid(g["id"])}["{mlabel(g["title"])}"]')
        lines.append("    direction TB")
        for nid in g["nodes"]:
            n = nodes[nid]
            a, b = NODE_SHAPE.get(n["layer"], ('["', '"]'))
            if n["layer"] == "config":
                a, b = '["', '"]'
            word = n["layer"] if n["layer"] not in ("code",) else ""
            label = n["label"] + (f" · {word}" if word and not n["id"].startswith("g_") else "")
            lines.append(f"    {mid(nid)}{a}{mlabel(label)}{b}")
            classes[n["status"] if n["status"] in classes else "changed"].append(mid(nid))
        lines.append("  end")
    for e in sysg["externals"]:
        a, b = SHAPE.get(e["kind"], ('["', '"]'))
        lines.append(f"  {mid(e['id'])}{a}{mlabel(e['label'])}{b}")
    if sysg.get("collapsed"):
        c = sysg["collapsed"]
        lines.append(f'  {mid(c["id"])}["{mlabel(c["label"])}"]')
        classes["faded"].append(mid(c["id"]))
    for e in sysg["edges"]:
        arrow = "-.->" if e.get("kind") == "guess" else "-->"
        lab = f'|"{mlabel(e["label"])}"|' if e.get("label") else ""
        lines.append(f"  {mid(e['from'])} {arrow}{lab} {mid(e['to'])}")
    lines += ["  " + c for c in CLASSDEF]
    for cls, ids in classes.items():
        if ids:
            lines.append(f"  class {','.join(ids)} {cls}")
    return "\n".join(lines) + "\n"


def system_ascii(sysg: dict, width: int = 100) -> str:
    nodes = {n["id"]: n for n in sysg["nodes"]}
    names = {nid: f"{MARK.get(n['status'], '[~]')} {n['label']}" for nid, n in nodes.items()}
    names.update({e["id"]: f"{EXT_ICON.get(e['kind'], '')} {e['label']}".strip() for e in sysg["externals"]})
    n_ext = len(sysg["externals"])
    out = [f"system: {len(nodes)} changed part(s) in {len(sysg['groups'])} area(s), {n_ext} outside system(s)", ""]
    boxes = []
    for g in sysg["groups"]:
        rows = []
        for nid in g["nodes"]:
            n = nodes[nid]
            rows.append(ascii_text(f"{MARK.get(n['status'], '[~]')} {n['label']}  ({n['layer']})"))
        inner = max(26, min(44, max(len(r) for r in rows) + 1))
        boxes.append(_box(ascii_text(g["title"]), rows, inner))
    out += _side_by_side(boxes, width)
    if sysg.get("collapsed"):
        out += ["", ascii_text(f"    {sysg['collapsed']['label']}")]
    if sysg["edges"]:
        out += ["", "flow:"]
        for e in sysg["edges"]:
            arrow = "..>" if e.get("kind") == "guess" else "-->"
            lab = f" ({e['label']})" if e.get("label") else ""
            out.append(ascii_text(f"  {names.get(e['from'], e['from'])} {arrow} {names.get(e['to'], e['to'])}{lab}"))
    if sysg["externals"]:
        out += ["", "outside systems:"]
        for e in sysg["externals"]:
            out.append(ascii_text(f"  {names[e['id']]}" + (f": {e['detail']}" if e.get("detail") else "")))
    return "\n".join(out)
