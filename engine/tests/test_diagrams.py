"""keel's ASCII diagrams (keel_engine/diagrams.py): the shared flow map fixtures, golden pictures, the rules every
picture keeps (ASCII, width, max lines, same bytes) and the routes.

    KEEL_UPDATE_GOLDEN=1 uv run pytest tests/test_diagrams.py     writes the golden files again
"""

import json
import os
from pathlib import Path

import pytest

from keel_engine import diagrams
from keel_engine.workflows.templates import templates

HERE = Path(__file__).parent
FIXTURES = HERE / "fixtures" / "flowmap"
GOLDEN = HERE / "golden" / "diagrams"


def _wf(wid: str) -> dict:
    t = next(t for t in templates() if t.id == wid)
    return {"id": t.id, "name": t.name, "steps": [s.model_dump(exclude_none=True) for s in t.steps]}


# ------------------------------------------------------------------ the shared fixtures (web flowmap.ts reads them too)

def test_one_fixture_per_workflow_and_up_to_date():
    have = {p.stem for p in FIXTURES.glob("*.json")}
    want = {t.id for t in templates()}
    assert have == want, "run: cd engine && uv run python ../scripts/flowmap_fixtures.py"
    for t in templates():
        fx = json.loads((FIXTURES / f"{t.id}.json").read_text())
        steps = [s.model_dump(exclude_none=True) for s in t.steps]
        assert fx["steps"] == json.loads(json.dumps(steps)), f"{t.id} changed: run scripts/flowmap_fixtures.py again"


@pytest.mark.parametrize("path", sorted(FIXTURES.glob("*.json")), ids=lambda p: p.stem)
def test_port_matches_the_fixture(path):
    fx = json.loads(path.read_text())
    got = diagrams.summary(diagrams.build_flow_map(diagrams._steps_of({"steps": fx["steps"]})))
    assert json.loads(json.dumps(got)) == fx["expect"]


# ------------------------------------------------------------------ cases

THREAD = {
    "thread_id": "t1", "project_id": "demo", "workflow_id": "feature", "title": "Add a health endpoint", "status": "waiting",
    "current": "spec_gate", "phase": "spec", "ac": None,
    "acs": [{"id": "AC-1", "layer": "API", "title": "GET /health answers 200", "status": "todo"},
            {"id": "AC-2", "layer": "WEB", "title": "the page shows it", "status": "todo"}],
    "waiting": {"step": "spec_gate", "kind": "gate", "title": "spec approval", "detail": "Read the spec",
                "options": ["approve", "reject"], "labels": {"approve": "Approve the spec", "reject": "Send back"}},
    "usage": {"tokens_in": 12000, "tokens_out": 3400, "cost_usd": 0.42, "premium_requests": 0, "cap_tokens": 500000},
    "checkpoints": 4, "updated_at": "2026-10-16T10:00:00Z",
}

LEVEL = {"nodes": [
    {"id": "web", "kind": "app", "title": "web (React)", "sub": "the dashboard", "rows": [{"t": "pages: 12"}], "x": 0, "y": 0, "w": 1, "h": 1},
    {"id": "api", "kind": "service", "title": "api (Kotlin)", "rows": [{"t": "REST + SSE"}, {"t": "SQLite"}], "x": 200, "y": 100, "w": 1, "h": 1},
    {"id": "engine", "kind": "service", "title": "engine (Python)", "rows": [{"t": "LangGraph"}], "x": 400, "y": 100, "w": 1, "h": 1},
    {"id": "db", "kind": "store", "title": "keel.db", "x": 200, "y": 200, "w": 1, "h": 1}],
    "edges": [{"from": "web", "to": "api", "kind": "http", "label": "REST", "d": ""},
              {"from": "api", "to": "engine", "kind": "http", "d": ""},
              {"from": "api", "to": "db", "kind": "sql", "label": "jdbc", "d": ""}],
    "width": 600, "height": 300}


def _col(name, type_="bigint", pk=False, fk=None, unique=False, nullable=True):
    return {"name": name, "type": type_, "pk": pk, "fk": fk, "unique": unique, "nullable": nullable}


SCHEMA = {"tables": [
    {"id": "orgs", "name": "orgs", "kind": "table", "columns": [_col("id", pk=True), _col("name", "text", nullable=False)]},
    {"id": "users", "name": "users", "kind": "table", "columns": [
        _col("id", pk=True), _col("email", "text", unique=True, nullable=False), _col("org_id", fk={"table": "orgs", "column": "id"})]},
    {"id": "orders", "name": "orders", "kind": "table", "columns": [
        _col("id", pk=True), _col("user_id", fk={"table": "users", "column": "id"}, nullable=False), _col("total", "numeric(10,2)")]},
    {"id": "audit", "name": "audit", "kind": "view", "columns": [_col("at", "timestamptz")]}],
    "relations": [
        {"id": "r1", "kind": "fk", "from": "users", "from_columns": ["org_id"], "to": "orgs", "to_columns": ["id"]},
        {"id": "r2", "kind": "fk", "from": "orders", "from_columns": ["user_id"], "to": "users", "to_columns": ["id"], "on_delete": "cascade"}]}

BIG = {"tables": [{"id": f"t{i:02d}", "name": f"table_{i:02d}", "columns": [_col("id", pk=True)]} for i in range(14)],
       "relations": [{"id": f"r{i}", "from": f"t{i:02d}", "from_columns": ["id"], "to": "t00", "to_columns": ["id"]} for i in range(1, 14)]}

FOCUS = {"available": True, "level": "unit", "depth": 2,
         "focus": {"id": "class:Engine", "name": "Engine", "kind": "class", "qualified": "keel_engine.runtime.service.Engine",
                   "signature": "class Engine(bus, store)", "file": "engine/keel_engine/runtime/service.py", "line": 120,
                   "group": "runtime", "unit": None, "members": []},
         "nodes": [
             {"id": "function:create_app", "name": "create_app", "kind": "function", "unit": "app", "group": "", "file": "app.py", "line": 300, "col": -1},
             {"id": "function:main", "name": "main", "kind": "function", "unit": "main", "group": "", "file": "main.py", "line": 10, "col": -2},
             {"id": "class:EventBus", "name": "EventBus", "kind": "class", "unit": "events", "group": "", "file": "events/bus.py", "line": 5, "col": 1},
             {"id": "function:compile", "name": "compile", "kind": "function", "unit": "compiler", "group": "", "file": "runtime/compiler.py", "line": 40, "col": 1},
             {"id": "function:emit", "name": "emit", "kind": "function", "unit": "events", "group": "", "file": "events/bus.py", "line": 30, "col": 2}],
         "edges": [{"from": "function:create_app", "to": "class:Engine", "n": 1, "k": {"instantiates": 1}, "sites": [{"file": "app.py", "line": 310}]},
                   {"from": "class:Engine", "to": "function:compile", "n": 3, "k": {"calls": 3}, "sites": [{"file": "runtime/service.py", "line": 200}]}],
         "more": {"1": 4}, "impact": 17, "impact_capped": False}

CASES = {
    "workflow-feature": ("workflow", {"workflow": "feature"}, {}),
    "workflow-feature-zoom-ac": ("workflow", {"workflow": "feature"}, {"zoom": "ac", "max_lines": 200}),
    "workflow-fix": ("workflow", {"workflow": "fix"}, {"max_lines": 200}),
    "workflow-ship-80": ("workflow", {"workflow": "ship"}, {"width": 80}),
    "workflow-review-pr": ("workflow", {"workflow": "review-pr"}, {}),
    "flow-feature-waiting": ("flow", {"workflow": "feature", "thread": THREAD, "visited": ["preflight", "spec", "spec_sync"]}, {}),
    "map-system": ("map-system", LEVEL, {}),
    "map-er": ("map-er", {"schema": SCHEMA}, {}),
    "map-er-focus": ("map-er", {"schema": SCHEMA, "focus": "users"}, {}),
    "map-er-list": ("map-er", {"schema": BIG}, {}),
    "graph": ("graph", FOCUS, {}),
}


def _case(name):
    kind, data, opts = CASES[name]
    if isinstance(data.get("workflow"), str):
        data = {**data, "workflow": _wf(data["workflow"])}
    return kind, data, opts


@pytest.mark.parametrize("name", sorted(CASES))
def test_golden(name):
    kind, data, opts = _case(name)
    got = diagrams.render(kind, data, **opts)
    path = GOLDEN / f"{name}.txt"
    if os.environ.get("KEEL_UPDATE_GOLDEN") == "1" or not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(got)
    assert got == path.read_text()


@pytest.mark.parametrize("name", sorted(CASES))
def test_every_picture_keeps_the_rules(name):
    kind, data, opts = _case(name)
    width = opts.get("width", 100)
    max_lines = opts.get("max_lines", 60)
    a = diagrams.render(kind, data, **opts)
    assert a == diagrams.render(kind, json.loads(json.dumps(data)), **opts)       # same input, same bytes
    assert all(ord(c) < 128 for c in a)
    lines = a.splitlines()
    assert all(len(line) <= width for line in lines)
    assert len(lines) <= max_lines


def test_long_pictures_end_with_a_zoom_line():
    text = diagrams.render("workflow", {"workflow": _wf("feature")}, max_lines=20)
    lines = text.splitlines()
    assert len(lines) == 20
    assert lines[-1].startswith("... ") and "more (zoom with id=" in lines[-1]


def test_flow_marks_state_and_says_how_to_answer():
    text = diagrams.render("flow", {"workflow": _wf("feature"), "thread": THREAD, "visited": ["spec"]}, max_lines=400)
    assert "[x] preflight + own branch" in text
    assert "[?] spec approval" in text and "<-- waiting for you" in text
    assert 'approve ("Approve the spec") or reject with a reason ("Send back")' in text
    assert "criteria 0/2: [ ]AC-1 [ ]AC-2" in text


def test_non_ascii_is_spelled_out():
    wf = {"id": "x", "name": "x", "steps": [{"id": "a", "kind": "agent", "name": "write → commit … café ☃"}]}
    text = diagrams.render("workflow", {"workflow": wf})
    assert "write -> commit ... cafe ?" in text


@pytest.mark.parametrize("kind,data,msg", [
    ("nope", {}, "no diagram kind"),
    ("workflow", {"workflow": {"steps": [{"kind": "agent"}]}}, "each with an id"),
    ("flow", {"workflow": {"steps": []}}, "data.thread"),
    ("map-er", {"schema": SCHEMA, "focus": "ghost"}, 'no table "ghost"'),
    ("graph", {"missing": "symbol x"}, "no symbol x"),
])
def test_errors_say_what_is_wrong(kind, data, msg):
    with pytest.raises(diagrams.DiagramError, match=msg):
        diagrams.render(kind, data)


# ------------------------------------------------------------------ the engine route (conftest's client)

def test_route_draws_and_refuses(client):
    res = client.post("/diagrams/ascii", json={"kind": "map-er", "data": {"schema": SCHEMA}, "width": 80})
    assert res.status_code == 200
    body = res.json()
    assert body["kind"] == "map-er" and body["text"] == diagrams.render("map-er", {"schema": SCHEMA}, width=80)
    assert body["lines"] == len(body["text"].splitlines())
    bad = client.post("/diagrams/ascii", json={"kind": "pie", "data": {}})
    assert bad.status_code == 400 and "no diagram kind" in bad.json()["error"]
