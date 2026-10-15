"""keel v2's own MCP server (stdio): the flow's status, timeline, next action and phase rules, read over the api.

    python -m keel_engine.mcp [--read-only | --write | --admin] [--allow t1,t2] [--yes]

v0.16.0 three levels, each with the one below (TOOLS lists them): read (default; what agents get), write (decide
gates, answer the Inbox, start flows, git / PR / CI / DB writes), admin (stop and delete flows, projects, workflows).
A tool above the level, or not in --allow, is not registered at all, so a client cannot even see it. Agents get
--read-only (the builtin `keel` server in tools/mcp.py and the api's McpService), which always wins over the env.
Push, DB changes, deletes and stops ask the person through the client first (MCP elicitation); a client that cannot
ask is refused unless --yes. Every write says who acted (X-Keel-Via / X-Keel-Client / X-Keel-Tool; api McpAudit).
v0.16.1 the api checks the level too: with the internal token this server asks POST /api/mcp/token for its level's
token and sends it as X-Keel-Mcp-Token (api McpLevelGuard); without it (agents) the api treats it as read.

Every tool takes an optional `project` id. Without it: KEEL_PROJECT, else the project whose root holds the
working directory (an agent runs in its project), else the only (or first) project.
"""

from __future__ import annotations

import argparse
import copy
import os
import sys
import time
from datetime import datetime
from typing import Any, Literal
from urllib.parse import quote

import anyio
import httpx
from mcp.server.fastmcp import Context
from pydantic import BaseModel, Field

from . import rules

API_TIMEOUT = 15
BUCKETS = ["api-main", "api-test", "web-src", "web-test", "contract", "specs", "migration", "e2e", "smoke", "other"]
BUCKET_TEXT = {
    "api-main": "backend production code", "api-test": "backend tests", "web-src": "frontend production code",
    "web-test": "frontend tests", "contract": "the API contract, openapi", "specs": "spec files", "migration": "database migrations",
    "e2e": "end-to-end tests", "smoke": "smoke tests", "other": "any other file: docs, build files",
}
TIMELINE_FILTERS = ("all", "steps", "agents", "failed")
# keel_dashboard: the web app's page for each view (web/src/routes.ts; #/projects/<id>/… picks the project)
DASHBOARD_VIEWS = {"flow": "flow", "map": "map/system", "er": "map/er"}
START_WAIT = 20         # keel_start_flow waits this long for the flow to reach its first gate
START_POLL = 2


MCP_TOKEN_HEADER = "X-Keel-Mcp-Token"


class ApiError(Exception):
    pass


def internal_token() -> str:
    """KEEL_INTERNAL_TOKEN, else the file KEEL_INTERNAL_TOKEN_FILE names (keel2 mcp in Docker: docker/keel-start writes it)."""
    tok = os.environ.get("KEEL_INTERNAL_TOKEN", "").strip()
    path = os.environ.get("KEEL_INTERNAL_TOKEN_FILE", "")
    if not tok and path:
        try:
            with open(path, encoding="utf-8") as f:
                tok = f.read().strip()
        except OSError:
            tok = ""
    return tok


class KeelApi:
    """The keel v2 api over HTTP (KEEL_API_URL). Public /api routes; the api only listens on 127.0.0.1."""

    def __init__(self, url: str | None = None, transport: httpx.BaseTransport | None = None):
        self.url = (url or os.environ.get("KEEL_API_URL") or "http://127.0.0.1:8080").rstrip("/")
        self.http = httpx.Client(base_url=self.url + "/api", timeout=API_TIMEOUT, transport=transport)
        # v0.16.1 the api checks the level: with the internal token (keel2 mcp has it, agents never do) this asks the api
        # for its level's token once and sends it as X-Keel-Mcp-Token; without it, no token, so the api treats it as read.
        # A dict, so the copies acting() makes share it.
        self._proof = {"internal": internal_token(), "level": "read", "asked": False}
        # v0.16.0 who acts: every write the api gets from here says "via MCP · <client>: <tool>" (api McpAudit)
        self.client = "an MCP client"
        self.tool = ""

    def acting(self, client: str, tool: str) -> "KeelApi":
        """A copy for one tool call (the same HTTP client) that says who acts: two calls at once never swap names."""
        c = copy.copy(self)
        c.client, c.tool = client, tool
        return c

    def use_level(self, level: str) -> None:
        """The level to ask the api's token for (build_server sets it); asked on the first request."""
        self._proof.update(level=level, asked=False)
        self.http.headers.pop(MCP_TOKEN_HEADER, None)

    def _prove(self) -> None:
        p = self._proof
        if p["asked"] or not p["internal"]:
            return
        try:
            res = self.http.post("/mcp/token", json={"level": p["level"]}, headers={"X-Keel-Token": p["internal"]})
        except httpx.HTTPError:
            return                                          # the api is not up yet: ask again on the next request
        p["asked"] = True
        try:
            token = res.json().get("token") if res.status_code == 200 else None
        except ValueError:
            token = None
        if token:
            self.http.headers[MCP_TOKEN_HEADER] = token

    def _audit(self, method: str) -> dict:
        if method == "GET":
            return {}
        return {"X-Keel-Via": "mcp", "X-Keel-Client": self.client[:80], "X-Keel-Tool": self.tool[:80]}

    def _raw(self, method: str, path: str, timeout: float | None = None, **kw) -> httpx.Response:
        self._prove()
        try:
            res = self.http.request(method, path, headers=self._audit(method), **({"timeout": timeout} if timeout else {}), **kw)
        except httpx.HTTPError as exc:
            raise ApiError(f"keel's api does not answer at {self.url} ({type(exc).__name__}). Is keel running? (keel2 status)") from exc
        if res.status_code >= 400:
            try:
                body = res.json()
                msg = body.get("error") or res.text
                if body.get("hint"):
                    msg += f" ({body['hint']})"
            except ValueError:
                msg = res.text[:300]
            raise ApiError(f"{method} {path}: {res.status_code} {msg}")
        return res

    def _send(self, method: str, path: str, **kw) -> Any:
        res = self._raw(method, path, **kw)
        return res.json() if res.content else None

    def text(self, route: str, /, **params) -> str:
        return self._raw("GET", route, params={k: v for k, v in params.items() if v is not None}).text

    def put(self, path: str, body: dict) -> Any:
        return self._send("PUT", path, json=body)

    def delete(self, path: str) -> Any:
        return self._send("DELETE", path)

    def get(self, route: str, /, **params) -> Any:
        """GET a route; `params` are the query (a `path` query parameter is fine: the route is positional)."""
        return self._send("GET", route, params={k: v for k, v in params.items() if v is not None})

    def post(self, path: str, body: dict, timeout: float | None = None) -> Any:
        return self._send("POST", path, json=body, timeout=timeout)


# ---------------------------------------------------------------- helpers

def _project(api: KeelApi, project: str | None) -> dict:
    projects = api.get("/projects") or []
    want = project or os.environ.get("KEEL_PROJECT") or ""
    if want:
        for p in projects:
            if want in (p.get("id"), p.get("name")):
                return p
        raise ApiError(f'no project "{want}". keel knows: {", ".join(p["id"] for p in projects) or "none yet"}')
    if not projects:
        raise ApiError("keel has no project yet. Add one in the dashboard (Projects › Add).")
    cwd = os.path.realpath(os.getcwd())
    inside = [p for p in projects if p.get("root") and (cwd == p["root"] or cwd.startswith(p["root"].rstrip("/") + "/"))]
    if inside:
        return max(inside, key=lambda p: len(p["root"]))
    return projects[0]


def _flow(api: KeelApi, pid: str) -> tuple[dict | None, dict | None]:
    view = api.get(f"/projects/{pid}/flow") or {}
    return view.get("thread"), view.get("workflow")


def _n(x: Any) -> str:
    try:
        return f"{int(x or 0):,}"
    except (TypeError, ValueError):
        return str(x)


def _when(at: str | None) -> datetime:
    try:
        return datetime.fromisoformat(str(at).replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return datetime.min


def _clock(at: str | None) -> str:
    d = _when(at)
    return d.strftime("%m-%d %H:%M:%S") if d != datetime.min else "--"


def _flow_name(thread: dict, workflow: dict | None) -> str:
    wid = thread.get("workflow_id") or "?"
    name = (workflow or {}).get("name")
    return f"{name} ({wid})" if name and name != wid else wid


def _waiting_lines(w: dict) -> list[str]:
    labels = w.get("labels") or {}
    opts = " | ".join(f"{o}" + (f' ("{labels[o]}")' if labels.get(o) else "") for o in w.get("options") or [])
    out = [f"waiting   {w.get('kind', 'gate')}: {w.get('title', '')}", f"          options: {opts or '-'}"]
    for q in w.get("questions") or []:
        choices = " / ".join(o.get("label", "") + (" (recommended)" if o.get("recommended") else "") for o in q.get("options") or [])
        out.append(f"          {q.get('id')}: {q.get('question')}  [{choices}]")
    detail = (w.get("detail") or "").strip()
    if detail:
        out.append("          " + detail[:600].replace("\n", "\n          "))
    return out


# ---------------------------------------------------------------- read tools

def status(api: KeelApi, project: str | None = None) -> str:
    p = _project(api, project)
    thread, workflow = _flow(api, p["id"])
    head = f"project   {p['id']} · branch {p.get('branch') or '-'}"
    if not thread:
        return f"{head}\nflow      none. Start one in the dashboard (Flow › Start a flow)."
    out = [head, f"flow      {_flow_name(thread, workflow)} · \"{thread.get('title', '')}\" · {thread.get('status')} · thread {thread.get('thread_id')}",
           f"step      {thread.get('current') or '-'} · phase {thread.get('phase') or 'none'}" + (f" · {thread['ac']}" if thread.get("ac") else "")
           + (f" · run mode {thread['run_mode']}" if thread.get("run_mode") not in (None, "", "manual") else "")]
    acs = thread.get("acs") or []
    if acs:
        done = sum(1 for a in acs if a.get("status") in ("done", "already-met"))
        out.append(f"criteria  {done}/{len(acs)} done")
        out += [f"  {('[' + str(a.get('status')) + ']'):<14}{a.get('id')} {a.get('layer', '')}  {a.get('title', '')}" for a in acs]
    if thread.get("waiting"):
        out += _waiting_lines(thread["waiting"])
    u = thread.get("usage") or {}
    total = int(u.get("tokens_in") or 0) + int(u.get("tokens_out") or 0)
    cap = f" of cap {_n(u['cap_tokens'])}" if u.get("cap_tokens") else " (no cap)"
    cap_usd = f" of cap ${float(u['cap_usd']):.2f}" if u.get("cap_usd") else ""
    out.append(f"usage     {_n(total)} tokens{cap} · in {_n(u.get('tokens_in'))} · out {_n(u.get('tokens_out'))} · cached "
               f"{_n(u.get('tokens_cached'))} · ${float(u.get('cost_usd') or 0):.2f}{cap_usd} · {_n(u.get('premium_requests'))} premium requests")
    if thread.get("error"):
        out.append(f"error     {thread['error']}")
    for b in thread.get("blockers") or []:
        out.append(f"blocker   {b.get('gate')}: {b.get('why')} -> {b.get('fix')}")
    return "\n".join(out)


def projects(api: KeelApi) -> str:
    rows = api.get("/projects") or []
    if not rows:
        return "keel has no project yet. Add one in the dashboard (Projects › Add)."
    out = []
    for p in rows:
        acs = p.get("acs") or [0, 0]
        out.append(f"{p['id']}  branch {p.get('branch') or '-'} · flow {p.get('flow') or 'none'} · phase {p.get('phase') or 'none'} · "
                   f"criteria {acs[0]}/{acs[1] if len(acs) > 1 else 0} · waiting {'yes' if p.get('waiting') else 'no'}"
                   + (f" · {p['running']} running" if p.get("running") else ""))
    return "\n".join(out)


def timeline(api: KeelApi, project: str | None = None, limit: int = 20, filter: str = "all") -> str:
    if filter not in TIMELINE_FILTERS:
        raise ApiError(f'filter must be one of: {", ".join(TIMELINE_FILTERS)}')
    limit = max(1, min(int(limit or 20), 200))
    p = _project(api, project)
    thread, _ = _flow(api, p["id"])
    events: list[tuple[datetime, str]] = []
    if filter in ("all", "steps") and thread:
        for c in api.get(f"/threads/{thread['thread_id']}/history") or []:
            events.append((_when(c.get("at")), f"{_clock(c.get('at'))}  step   {c.get('step')}" + (f" · {c['note']}" if c.get("note") else "")))
    if filter in ("all", "agents", "failed"):
        for j in api.get("/jobs", project=p["id"], limit=limit) or []:
            if filter == "failed" and j.get("status") not in ("failed", "guard"):
                continue
            tokens = int(j.get("tokens_in") or 0) + int(j.get("tokens_out") or 0)
            where = " ".join(x for x in (j.get("step"), j.get("ac")) if x)
            events.append((_when(j.get("started_at")), f"{_clock(j.get('started_at'))}  agent  {j.get('agent')} {j.get('status')} · {where} · "
                                                         f"{_n(tokens)} tokens · {j.get('provider')}/{j.get('model')} · job {j.get('id')}"))
    if filter == "failed" and thread and thread.get("error"):
        events.append((_when(thread.get("updated_at")), f"{_clock(thread.get('updated_at'))}  flow   failed · {thread['error']}"))
    if not events:
        return "nothing yet: no flow has run on this project." if not thread else f"no {filter} events."
    events.sort(key=lambda e: e[0], reverse=True)
    return "\n".join(line for _, line in events[:limit])


def next_action(api: KeelApi, project: str | None = None) -> str:
    p = _project(api, project)
    thread, workflow = _flow(api, p["id"])
    if not thread:
        return "no flow: start one in the dashboard (Flow › Start a flow: feature, change, fix, diagnose, review, cover, ship, hunt, lint, init …)."
    st, w = thread.get("status"), thread.get("waiting")
    ac = f" for {thread['ac']}" if thread.get("ac") else ""
    if st == "waiting" and w:
        kind = w.get("kind")
        if kind == "clarify":
            n = len(w.get("questions") or [])
            line = f"waiting at {w.get('title')}: answer the {n} question(s), then send them (approve with answers)."
        elif kind == "budget":
            line = f"waiting at {w.get('title')}: approve to go past the token cap, or reject to stop."
        elif kind == "fix":
            line = f"waiting at {w.get('title')}: approve to try again, or reject to stop the flow."
        else:
            labels = w.get("labels") or {}
            line = (f"waiting at {w.get('step')} ({w.get('title')}){ac}: approve"
                    + (f' ("{labels["approve"]}")' if labels.get("approve") else "")
                    + (" or send back with a reason" + (f' ("{labels["reject"]}")' if labels.get("reject") else "")
                       if "reject" in (w.get("options") or []) else "") + ".")
        out = [line, "A human decides in the dashboard (or a client with keel2 mcp --write: keel_approve_gate)."]
    elif st == "running":
        out = [f"running {thread.get('current') or 'the next step'} (phase {thread.get('phase') or 'none'}){ac}: nothing to do, keel is working."]
    elif st == "done":
        out = [f"flow {_flow_name(thread, workflow)} is done. Review the branch {p.get('branch') or ''} and open a PR, or start a new flow."]
    elif st == "failed":
        out = [f"flow failed at {thread.get('current')}: {thread.get('error') or 'see keel_timeline filter=failed'}. Rewind or start it again from the dashboard."]
    elif st == "stopped":
        out = [f"flow stopped at {thread.get('current')}. Rewind to a checkpoint in the dashboard, or start a new flow."]
    else:
        out = [f"flow is {st} at {thread.get('current')}."]
    blockers = thread.get("blockers") or []
    if blockers:
        out += ["", "blocking a push:"] + [f"  {b.get('gate')}: {b.get('why')} -> {b.get('fix')}" for b in blockers]
    return "\n".join(out)


def explain(api: KeelApi | None, phase: str | None = None, project: str | None = None) -> str:
    if not phase:
        thread = _flow(api, _project(api, project)["id"])[0] if api else None
        phase = (thread or {}).get("phase") or "none"
    if phase not in rules.PHASES:
        return f'no phase "{phase}". keel knows: {", ".join(rules.PHASES)}'
    out = [f"phase  {phase}"]
    for flow, names in rules.RAILS.items():
        if phase in names:
            i = names.index(phase)
            out += ["", f"on the {flow} rail, step {i + 1} of {len(names)}:", "  " + " - ".join(f"[{n}]" if j == i else n for j, n in enumerate(names))]
    row = rules.MATRIX.get(phase) or rules.CLOSED
    fallback = row.get("*", "deny")
    allowed, refused, other = [], [], []
    for b in BUCKETS:
        rule = row.get(b, fallback)
        item = f"{b} ({BUCKET_TEXT[b]})"
        (allowed if rule == "allow" else refused if rule == "deny" else other).append(item if rule in ("allow", "deny") else f"{item}: {rule}")
    out += ["", "may edit:", *[f"  {x}" for x in allowed or ["nothing"]], "refused:", *[f"  {x}" for x in refused or ["nothing"]]]
    if other:
        out += ["conditional:", *[f"  {x}" for x in other]]
    out += ["always refused:", *[f"  {b}: {why}" for b, why in rules.ALWAYS_DENY.items()]]
    if phase in rules.LANE_SCOPED_PHASES:
        out.append(f"in {phase}, an agent edits only its criterion's lane (api or web).")
    hint = rules._hint(phase, {"red": "api-main", "green": "api-test"}.get(phase, "other")).strip()
    if hint:
        out += ["", hint]
    ctype = rules.commit_type_for(phase)
    cr = rules.COMMIT_RULES.get(ctype)
    if cr:
        out += ["", f"commits here are '{ctype}': may hold {', '.join(cr.get('allow') or []) or '-'}; never {', '.join(cr.get('deny') or []) or '-'}."]
    if phase != "none":
        out += ["shell: commits, git reset --hard and interactive rebase are refused during a flow (the engine commits); "
                "adding a dependency needs the spec gate; shell writes follow the edit rules above."]
    out += ["an unlock (dashboard › Repo › Unlock) lets one path through in one phase."]
    nxt = rules.TRANSITIONS.get(phase) or []
    if nxt:
        out.append(f"next phases: {', '.join(nxt)}")
    return "\n".join(out)


def dashboard_url(api: KeelApi, view: str = "flow", project: str | None = None) -> str:
    """The web app's URL for a view of the project: KEEL_PUBLIC_URL (keel2 mcp sets it from the running port), else
    the api's own address (inside the container that is keel's port 8080, not the one on your machine)."""
    if view not in DASHBOARD_VIEWS:
        raise ApiError(f'view must be one of: {", ".join(DASHBOARD_VIEWS)}')
    p = _project(api, project)
    base = (os.environ.get("KEEL_PUBLIC_URL") or api.url).rstrip("/")
    return f"{base}/#/projects/{quote(p['id'], safe='')}/{DASHBOARD_VIEWS[view]}"


def dashboard(api: KeelApi, view: str = "flow", project: str | None = None) -> str:
    url = dashboard_url(api, view, project)
    what = {"flow": "the flow page", "map": "the map", "er": "the database diagram (ER)"}[view]
    return f"{url}\nOpen it in a browser: {what} of this project in keel's dashboard."


# ---------------------------------------------------------------- write tools (only with --write)

def start_flow(api: KeelApi, type: str, idea: str, project: str | None = None, sleep=time.sleep,
               wait: float = START_WAIT) -> str:
    """Start a flow through the dashboard's own endpoint (POST /api/projects/{id}/flows): the same guard, budget, run
    mode and records as a flow started in the web app. It runs until its first human gate, like any flow."""
    idea = (idea or "").strip()
    if not idea:
        raise ApiError("idea is empty: say in a sentence or two what the flow should build or fix.")
    p = _project(api, project)
    known = [w.get("id") for w in api.get(f"/projects/{p['id']}/workflows") or [] if w.get("id")]
    if known and type not in known:
        raise ApiError(f'no flow type "{type}". keel has: {", ".join(known)}')
    first = idea.splitlines()[0].strip()
    title = first if len(first) <= 72 else first[:71].rstrip() + "…"
    state = api.post(f"/projects/{p['id']}/flows", {"workflow_id": type, "title": title, "request": idea,
                                                    "options": {"started_via": "mcp"}}) or {}
    tid = state.get("thread_id")
    deadline = time.monotonic() + wait
    while tid and state.get("status") == "running" and time.monotonic() < deadline:
        sleep(START_POLL)
        thread, _ = _flow(api, p["id"])
        if thread and thread.get("thread_id") == tid:
            state = thread
    out = [f'started {type} "{title}" on {p["id"]} (thread {tid}), recorded as started via MCP.',
           f"The flow is {state.get('status')} at {state.get('current') or '-'} (phase {state.get('phase') or 'none'})."]
    if state.get("waiting"):
        out.append(f"It waits for a human: {state['waiting'].get('title')}. Decide it in the dashboard or with keel_approve_gate.")
    elif state.get("status") == "running":
        out.append("It is still running; keel_status follows it, and it stops at its first gate for a human.")
    if state.get("cap_note"):
        out.append(str(state["cap_note"]))
    out.append(f"Watch it: {dashboard_url(api, 'flow', p['id'])}")
    return "\n".join(out)


def approve_gate(api: KeelApi, decision: str, project: str | None = None, why: str | None = None,
                 answers: dict[str, str] | None = None) -> str:
    if decision not in ("approve", "reject"):
        raise ApiError("decision must be approve or reject")
    p = _project(api, project)
    thread, _ = _flow(api, p["id"])
    if not thread or thread.get("status") != "waiting" or not thread.get("waiting"):
        return f"nothing is waiting on {p['id']}: {next_action(api, p['id']).splitlines()[0]}"
    w = thread["waiting"]
    if decision not in (w.get("options") or ["approve", "reject"]):
        return f"{w.get('title')} takes only: {', '.join(w.get('options') or [])}"
    payload = {"answers": answers} if answers else None
    if w.get("kind") == "clarify" and not answers:
        ids = ", ".join(q.get("id", "") for q in w.get("questions") or [])
        return f"{w.get('title')}: pass answers, a map of question id to the chosen label or your own words ({ids})."
    return _resume(api, thread["thread_id"], decision, why, payload, before=w)


def resume(api: KeelApi, decision: str, thread_id: str | None = None, project: str | None = None, why: str | None = None,
           payload: dict | None = None) -> str:
    if decision not in ("approve", "reject"):
        raise ApiError("decision must be approve or reject")
    if not thread_id:
        thread, _ = _flow(api, _project(api, project)["id"])
        if not thread:
            return "no flow on this project, so nothing to resume."
        thread_id = thread["thread_id"]
    return _resume(api, thread_id, decision, why, payload)


def _resume(api: KeelApi, tid: str, decision: str, why: str | None, payload: dict | None, before: dict | None = None) -> str:
    body: dict[str, Any] = {"decision": decision}
    if why:
        body["why"] = why
    if payload:
        body["payload"] = payload
    state = api.post(f"/threads/{tid}/resume", body) or {}
    what = f" {before.get('title')}" if before else ""
    after = f"{state.get('status')} at {state.get('current') or '-'} (phase {state.get('phase') or 'none'})"
    if state.get("waiting"):
        after += f"; now waiting: {state['waiting'].get('title')}"
    done = "approved" if decision == "approve" else "sent back"
    return f"{done}{what} on thread {tid}. The flow is {after}."


# ---------------------------------------------------------------- server

# ---- v0.10.0 plugins (Tools › Plugins): the Database and Git plugins' tools, through the api and keel's rules

ASK_WAIT = 600          # an acting tool waits this long for the person's answer in keel's Inbox
ASK_POLL = 3


def _plugin_on(api: KeelApi, pid: str, name: str):
    on = [p["name"] for p in api.get(f"/projects/{pid}/plugins") or [] if p.get("enabled")]
    if name not in on:
        title = {"db": "Database", "git": "Git"}[name]
        raise ApiError(f"The {title} plugin is off for {pid}: turn it on in keel (Tools › Plugins).")


def db_schema(api: KeelApi, project: str | None = None, connection: str | None = None, table: str | None = None) -> str:
    from .plugins.db.tools import _schema_text

    pid = _project(api, project)["id"]
    _plugin_on(api, pid, "db")
    return _schema_text(api.get(f"/projects/{pid}/db/schema", connection=connection), table or "")


def db_query(api: KeelApi, sql: str, project: str | None = None, connection: str | None = None) -> str:
    from .plugins.db.tools import query_text

    pid = _project(api, project)["id"]
    _plugin_on(api, pid, "db")
    return query_text(api.post(f"/projects/{pid}/db/query", {"sql": sql, "connection": connection or "", "mask": True}))


def git_status(api: KeelApi, project: str | None = None) -> str:
    from .plugins.git.tools import status_text

    pid = _project(api, project)["id"]
    _plugin_on(api, pid, "git")
    return status_text(api.get(f"/projects/{pid}/git/status"))


def pr_status(api: KeelApi, project: str | None = None) -> str:
    from .plugins.git.tools import pr_text

    pid = _project(api, project)["id"]
    _plugin_on(api, pid, "git")
    return pr_text((api.get(f"/projects/{pid}/git/pr") or {}).get("pr"))


def ci_runs(api: KeelApi, project: str | None = None, branch: str | None = None) -> str:
    from .plugins.ci.tools import runs_text

    pid = _project(api, project)["id"]
    _plugin_on(api, pid, "ci")
    return runs_text(api.get(f"/projects/{pid}/ci/runs", branch=branch))


def ci_failure(api: KeelApi, project: str | None = None, run_id: int | None = None) -> str:
    from .plugins.ci.tools import failure_text

    pid = _project(api, project)["id"]
    _plugin_on(api, pid, "ci")
    if not run_id:
        failed = [r for r in api.get(f"/projects/{pid}/ci/runs") or [] if r.get("failed")]
        if not failed:
            return "No failed pipeline: they pass, or none ran yet."
        run_id = failed[0]["id"]
    return failure_text(api.get(f"/projects/{pid}/ci/runs/{int(run_id)}"))


def ci_rerun(api: KeelApi, run_id: int, project: str | None = None, sleep=time.sleep) -> str:
    pid = _project(api, project)["id"]
    _plugin_on(api, pid, "ci")
    ok, why = _ask_person(api, pid, f"Claude Code: run the failed jobs of run #{int(run_id)} again?", f"gh run rerun {int(run_id)} --failed", sleep)
    if not ok:
        return f"The person said no in keel's Inbox: {why}".strip()
    api.post(f"/projects/{pid}/ci/runs/{int(run_id)}/rerun", {})
    return f"The failed jobs of run #{int(run_id)} run again."


def _ask_person(api: KeelApi, pid: str, title: str, command: str, sleep=time.sleep) -> tuple[bool, str]:
    """Ask the person in keel's Inbox and wait for the answer (Claude Code cannot show keel's card)."""
    q = api.post(f"/projects/{pid}/plugins/ask", {"title": title, "command": command})
    deadline = time.monotonic() + ASK_WAIT
    while time.monotonic() < deadline:
        a = api.get(f"/plugins/asks/{q['id']}")
        if not a.get("waiting"):
            return a.get("decision") == "allow", a.get("why") or ""
        sleep(ASK_POLL)
    return False, "Nobody answered in keel's Inbox in 10 minutes."


def db_change(api: KeelApi, sql: str, project: str | None = None, connection: str | None = None, sleep=time.sleep) -> str:
    pid = _project(api, project)["id"]
    _plugin_on(api, pid, "db")
    dry = api.post(f"/projects/{pid}/db/query", {"sql": sql, "connection": connection or "", "change": True})
    ok, why = _ask_person(api, pid, f"Claude Code: change {dry['changed']} row(s) in {dry['connection']}?", dry["sql"], sleep)
    if not ok:
        return f"The person said no in keel's Inbox: {why}".strip()
    r = api.post(f"/projects/{pid}/db/query", {"sql": sql, "connection": connection or "", "change": True, "confirm": True})
    return f"{r['changed']} row(s) changed in {r['connection']}."


def git_act(api: KeelApi, op: str, project: str | None = None, sleep=time.sleep, **body) -> str:
    pid = _project(api, project)["id"]
    _plugin_on(api, pid, "git")
    what = {"commit": f"commit: {body.get('message', '')}", "push": "push the branch",
            "pr": f"open the pull request: {body.get('title', '')}"}[op]
    ok, why = _ask_person(api, pid, f"Claude Code: {what.split(':')[0]}?", what, sleep)
    if not ok:
        return f"The person said no in keel's Inbox: {why}".strip()
    r = api.post(f"/projects/{pid}/git/{op}", body)
    if op == "commit":
        return f"Committed {r['sha'][:7]} {r['subject']} ({len(r['files'])} file(s))."
    if op == "push":
        return f"Pushed {r['branch']} ({r['sha'][:7]})."
    return f"{'Updated' if r.get('updated') else 'Opened'} the pull request: {r.get('url')}"


LEVELS = ("read", "write", "admin")
RANK = {"read": 0, "write": 1, "admin": 2}
# Tools that change something hard to undo: the client asks the person first (MCP elicitation), or with --yes not.
CONFIRM = {"keel_git_push", "keel_db_change", "keel_delete_run", "keel_stop_flow", "keel_remove_project",
           "keel_edit_workflow", "keel_restore_doc"}
NO_ELICIT = ("this MCP client cannot ask you to confirm {what}, so keel refuses it. Run keel2 mcp with --yes to allow "
             "it without asking, or do it in keel's dashboard.")


class Confirm(BaseModel):
    confirm: bool = Field(description="Yes, do it")


def tool_level(name: str) -> str | None:
    """The level a tool is registered at (None: not a keel tool)."""
    for lv, names in TOOLS.items():
        if name in names:
            return lv
    return None


TOOLS: dict[str, tuple[str, ...]] = {
    "read": ("keel_status", "keel_projects", "keel_timeline", "keel_next", "keel_explain", "keel_dashboard",
             "keel_db_schema", "keel_db_query", "keel_git_status", "keel_pr_status", "keel_ci_runs", "keel_ci_failure",
             "keel_flows", "keel_inbox", "keel_live", "keel_budget", "keel_specs", "keel_knowledge", "keel_search",
             "keel_read_file", "keel_actions", "keel_run_action"),
    "write": ("keel_approve_gate", "keel_resume", "keel_start_flow", "keel_answer", "keel_edit_gate", "keel_restore_doc",
              "keel_ci_rerun", "keel_db_change", "keel_git_commit", "keel_git_push", "keel_pr_create"),
    "admin": ("keel_stop_flow", "keel_delete_run", "keel_add_project", "keel_remove_project", "keel_workflows",
              "keel_edit_workflow"),
}


def build_server(write: bool = False, api: KeelApi | None = None, level: str | None = None,
                 allow: set[str] | None = None, yes: bool = False):
    """The MCP server at a level (read, write, admin: each includes the one below). A tool above the level, or not in
    `allow` when it is given, is not registered at all, so the client cannot see it."""
    from mcp.server.fastmcp import FastMCP
    from mcp.types import ToolAnnotations

    from . import mcp_more as more

    api = api or KeelApi()
    lvl = level or ("write" if write else "read")
    if lvl not in LEVELS:
        raise ValueError(f"level must be one of {', '.join(LEVELS)}")
    api.use_level(lvl)
    ro = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
    rw = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
    rx = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False)
    srv = FastMCP("keel", instructions="keel v2: the flow on each project (phase, criteria, gates), what happened, what to do next, "
                                         "and what each phase permits." + {"read": "", "write": " Write tools can decide gates and start flows.",
                                                                          "admin": " Admin tools can also stop flows and change projects and workflows."}[lvl],
                  log_level="WARNING")

    def reg(ann):
        def deco(fn):
            name = fn.__name__
            if RANK[lvl] < RANK[tool_level(name) or "admin"] or (allow is not None and name not in allow):
                return fn
            return srv.tool(annotations=ann, structured_output=False)(fn)
        return deco

    def guard(fn, *a, **kw) -> str:
        try:
            return fn(*a, **kw)
        except ApiError as exc:
            return f"keel: {exc}"

    async def act(ctx: Context | None, name: str, what: str, fn, *a, **kw) -> str:
        """A write or admin call: says who acts (audit headers), asks the person first when the tool needs it."""
        try:
            params = ctx.session.client_params if ctx else None
            client = (params.clientInfo.name if params and params.clientInfo else None) or "an MCP client"
        except Exception:  # noqa: BLE001
            client = "an MCP client"
        mine = api.acting(client, name)
        a = tuple(mine if x is api else x for x in a)
        if name in CONFIRM and not yes:
            can = False
            try:
                can = bool(ctx and ctx.session.client_params and ctx.session.client_params.capabilities.elicitation)
            except Exception:  # noqa: BLE001
                can = False
            if not can:
                return "keel: " + NO_ELICIT.format(what=what)
            res = await ctx.elicit(message=f"keel: {what}?", schema=Confirm)
            if res.action != "accept" or not getattr(res.data, "confirm", False):
                return f"keel: not done — you said no to {what}."
        return await anyio.to_thread.run_sync(lambda: guard(fn, *a, **kw))

    # ---------------------------------------------------------------- read

    @reg(ro)
    def keel_status(project: str | None = None) -> str:
        """The project's flow: branch, workflow, current step and phase, every acceptance criterion with its status,
        what is waiting on a human (title, kind, options, questions), token usage against the cap, and blockers."""
        return guard(status, api, project)

    @reg(ro)
    def keel_projects() -> str:
        """Every keel project, one line each: id, branch, flow, phase, criteria done, and whether it waits on a human.
        Pass an id as `project` to the other keel tools."""
        return guard(projects, api)

    @reg(ro)
    def keel_timeline(project: str | None = None, limit: int = 20, filter: Literal["all", "steps", "agents", "failed"] = "all") -> str:
        """Recent events, newest first: flow checkpoints (steps) and agent runs (status, tokens, model).
        filter: all, steps, agents or failed. limit: 1-200 (default 20)."""
        return guard(timeline, api, project, limit, filter)

    @reg(ro)
    def keel_next(project: str | None = None) -> str:
        """The single next action for a human or an agent (e.g. a gate to approve, a step running), plus what blocks a push."""
        return guard(next_action, api, project)

    @reg(ro)
    def keel_explain(phase: str | None = None, project: str | None = None) -> str:
        """What a phase permits and refuses (which files may be edited, commit rules, shell rules) and where it sits on
        each flow's rail. phase: e.g. spec, red, green, gate, hunt-sweep; default the project's current phase."""
        return guard(explain, api, phase, project)

    @reg(ro)
    def keel_dashboard(project: str | None = None, view: Literal["flow", "map", "er"] = "flow") -> str:
        """The web address of a dashboard view for the project, to open in a browser: flow (the flow page), map (the
        project map) or er (the database diagram)."""
        return guard(dashboard, api, view, project)

    @reg(ro)
    def keel_db_schema(project: str | None = None, connection: str | None = None, table: str | None = None) -> str:
        """Database plugin: the project's tables with columns, primary keys (*) and foreign keys; with `table`, one table."""
        return guard(db_schema, api, project, connection, table)

    @reg(ro)
    def keel_db_query(sql: str, project: str | None = None, connection: str | None = None) -> str:
        """Database plugin: one read-only query (SELECT, EXPLAIN, SHOW) under keel's rules: at most 200 rows and 15
        seconds; columns named like a secret show as •••."""
        return guard(db_query, api, sql, project, connection)

    @reg(ro)
    def keel_git_status(project: str | None = None) -> str:
        """Git plugin: the project's branch, how far it is from the base branch and its remote, and what changed."""
        return guard(git_status, api, project)

    @reg(ro)
    def keel_pr_status(project: str | None = None) -> str:
        """Git plugin: the branch's pull request: state, review, CI checks and review comments."""
        return guard(pr_status, api, project)

    @reg(ro)
    def keel_ci_runs(project: str | None = None, branch: str | None = None) -> str:
        """CI/CD plugin: the project's newest pipeline runs on GitHub Actions (workflow, branch, result, link)."""
        return guard(ci_runs, api, project, branch)

    @reg(ro)
    def keel_ci_failure(project: str | None = None, run_id: int | None = None) -> str:
        """CI/CD plugin: why a run failed (failed jobs, steps and the end of the log); default the newest failed run."""
        return guard(ci_failure, api, project, run_id)

    @reg(ro)
    def keel_flows(project: str | None = None, limit: int = 10) -> str:
        """The project's flows, newest first: type, title, status, step, criteria, tokens, cost, branch."""
        return guard(more.flows, api, project, limit)

    @reg(ro)
    def keel_inbox(project: str | None = None) -> str:
        """What waits for a person in keel's Inbox (gates, questions, choices), on every project or one."""
        return guard(more.inbox, api, project)

    @reg(ro)
    def keel_live(project: str | None = None) -> str:
        """The agents running now: agent, step, criterion, model, tokens and their last step."""
        return guard(more.live, api, project)

    @reg(ro)
    def keel_budget(project: str | None = None) -> str:
        """Tokens and cost today and this month, each running flow against its cap, and what is left of every cap."""
        return guard(more.budget, api, project)

    @reg(ro)
    def keel_specs(project: str | None = None, path: str | None = None, history: bool = False) -> str:
        """The project's specs (where its layout keeps them) with their criteria counts; with `path`, one spec's text,
        and with history=true its versions (who, phase, commit)."""
        return guard(more.specs, api, project, path, history)

    @reg(ro)
    def keel_knowledge(project: str | None = None, section: str | None = None) -> str:
        """keel's knowledge of the project: the sections (architecture, domain, ...) with their state, and the memory
        facts; with `section`, that section's text."""
        return guard(more.knowledge, api, project, section)

    @reg(ro)
    def keel_search(query: str, project: str | None = None, kind: Literal["text", "symbol"] = "text") -> str:
        """Search the project: text in code and docs (file:line), or a class, function or route in the code graph."""
        return guard(more.search, api, query, project, kind)

    @reg(ro)
    def keel_read_file(path: str, project: str | None = None, start: int = 1, lines: int = 200) -> str:
        """One file of the project, with line numbers: `lines` lines (at most 400) from `start`. Secret files are refused."""
        return guard(more.read_file, api, path, project, start, lines)

    @reg(ro)
    def keel_actions() -> str:
        """keel's engine actions (checks, traces, reports ...), each with its level: read, write, admin or flow-only."""
        return more.actions(lvl)

    @reg(ro)
    async def keel_run_action(action: str, args: dict[str, Any] | None = None, project: str | None = None,
                              ctx: Context | None = None) -> str:
        """Run one engine action on the project (keel_actions lists them). An action above this server's level, or one
        that only runs inside a flow, is refused."""
        from .runtime import action_docs

        lv = action_docs.action_level(action)
        if lv == "read":
            return await anyio.to_thread.run_sync(lambda: guard(more.run_action, api, action, lvl, args, project))
        return await act(ctx, "keel_run_action", f"run the action {action}", more.run_action, api, action, lvl, args, project)

    # ---------------------------------------------------------------- write

    @reg(rw)
    async def keel_approve_gate(decision: Literal["approve", "reject"], project: str | None = None, why: str | None = None,
                                answers: dict[str, str] | None = None, ctx: Context | None = None) -> str:
        """Decide the gate the project's flow waits at. approve, or reject (send back) with `why`.
        For a clarify gate pass `answers`: question id -> the chosen option label or your own words."""
        return await act(ctx, "keel_approve_gate", "decide the gate", approve_gate, api, decision, project, why, answers)

    @reg(rw)
    async def keel_resume(decision: Literal["approve", "reject"], thread_id: str | None = None, project: str | None = None,
                          why: str | None = None, payload: dict[str, Any] | None = None, ctx: Context | None = None) -> str:
        """Resume a waiting flow thread as the dashboard does (POST /api/threads/{id}/resume with decision, why,
        payload). thread_id defaults to the project's current flow."""
        return await act(ctx, "keel_resume", "resume the flow", resume, api, decision, thread_id, project, why, payload)

    @reg(rw)
    async def keel_start_flow(type: str, idea: str, project: str | None = None, ctx: Context | None = None) -> str:
        """Start a keel flow on the project, as the dashboard's "Start a flow" does: type is the workflow id
        (feature, change, fix, review, ...), idea says in your words what to build or fix (the first line is the
        title). It runs under keel's guard, budget and records, and stops at its first human gate."""
        return await act(ctx, "keel_start_flow", f"start a {type} flow", start_flow, api, type, idea, project)

    @reg(rw)
    async def keel_answer(decision: Literal["approve", "reject"] = "approve", project: str | None = None,
                          thread_id: str | None = None, why: str | None = None, answers: dict[str, str] | None = None,
                          choice: str | None = None, item_id: str | None = None, ctx: Context | None = None) -> str:
        """Answer what waits in keel's Inbox: a gate (approve or reject with why), a clarify question (answers: id ->
        your words), a choice (choice), or a task item (item_id)."""
        return await act(ctx, "keel_answer", "answer the Inbox", more.answer, api, decision, project, thread_id, why,
                         answers, choice, item_id)

    @reg(rw)
    async def keel_edit_gate(notes: str, project: str | None = None, ctx: Context | None = None) -> str:
        """Send the waiting gate back with notes on what to change; the agent reworks it and the gate asks again."""
        return await act(ctx, "keel_edit_gate", "send the gate back", more.edit_gate, api, notes, project)

    @reg(rw)
    async def keel_restore_doc(path: str, version: int | None = None, project: str | None = None, ctx: Context | None = None) -> str:
        """Put back a spec, knowledge section, ADR or runbook as it was in a stored version (default: the newest)."""
        return await act(ctx, "keel_restore_doc", f"restore {path}", more.restore_doc, api, path, version, project)

    @reg(rw)
    async def keel_ci_rerun(run_id: int, project: str | None = None, ctx: Context | None = None) -> str:
        """CI/CD plugin: run the failed jobs of a pipeline again, after the person's OK in keel's Inbox."""
        return await act(ctx, "keel_ci_rerun", "rerun the pipeline", ci_rerun, api, run_id, project)

    @reg(rx)
    async def keel_db_change(sql: str, project: str | None = None, connection: str | None = None, ctx: Context | None = None) -> str:
        """Database plugin: change data (INSERT, UPDATE, DELETE) on a local or test database. keel counts the rows,
        then waits up to 10 minutes for the person's OK in keel's Inbox."""
        return await act(ctx, "keel_db_change", "change data in the database", db_change, api, sql, project, connection)

    @reg(rw)
    async def keel_git_commit(message: str, project: str | None = None, ctx: Context | None = None) -> str:
        """Git plugin: commit every change (keel's secret check, the author from keel's settings), after the person's
        OK in keel's Inbox."""
        return await act(ctx, "keel_git_commit", "commit", git_act, api, "commit", project, message=message)

    @reg(rx)
    async def keel_git_push(project: str | None = None, ctx: Context | None = None) -> str:
        """Git plugin: push the branch (never with force, never to main or master), after the person's OK."""
        return await act(ctx, "keel_git_push", "push the branch", git_act, api, "push", project)

    @reg(rw)
    async def keel_pr_create(title: str, body: str = "", project: str | None = None, ctx: Context | None = None) -> str:
        """Git plugin: open the branch's pull request (or update its title and body), after the person's OK."""
        return await act(ctx, "keel_pr_create", "open the pull request", git_act, api, "pr", project, title=title, body=body)

    # ---------------------------------------------------------------- admin

    @reg(rx)
    async def keel_stop_flow(project: str | None = None, thread_id: str | None = None, ctx: Context | None = None) -> str:
        """Stop a running or waiting flow (default: the project's current one). Its work so far stays."""
        return await act(ctx, "keel_stop_flow", "stop the flow", more.stop_flow, api, project, thread_id)

    @reg(rx)
    async def keel_delete_run(thread_id: str, project: str | None = None, ctx: Context | None = None) -> str:
        """Delete a finished flow from the project's run history (not one that runs or waits)."""
        return await act(ctx, "keel_delete_run", f"delete the flow {thread_id} from the history", more.delete_run, api, thread_id, project)

    @reg(rw)
    async def keel_add_project(path: str, name: str | None = None, ctx: Context | None = None) -> str:
        """Add a git repo keel can already see (in a folder `keel2 add` mounted) as a project."""
        return await act(ctx, "keel_add_project", f"add {path}", more.add_project, api, path, name)

    @reg(rx)
    async def keel_remove_project(project: str, ctx: Context | None = None) -> str:
        """Take a project off keel's list; its history stays, and adding the folder again shows it again."""
        return await act(ctx, "keel_remove_project", f"remove the project {project}", more.remove_project, api, project)

    @reg(ro)
    def keel_workflows(project: str | None = None, workflow: str | None = None) -> str:
        """The project's workflows (id, name, steps); with `workflow`, its YAML."""
        return guard(more.workflows, api, project, workflow)

    @reg(rx)
    async def keel_edit_workflow(workflow: str, yaml: str, project: str | None = None, ctx: Context | None = None) -> str:
        """Change a workflow: the whole YAML (keel_workflows with `workflow` shows it). keel checks it first; nothing is
        saved when the check finds errors."""
        return await act(ctx, "keel_edit_workflow", f"change the workflow {workflow}", more.edit_workflow, api, workflow, yaml, project)

    return srv


def level(argv: list[str]) -> str:
    """read, write or admin. --read-only always wins (agents get it), so an env setting cannot give an agent more."""
    if "--read-only" in argv:
        return "read"
    if "--admin" in argv or os.environ.get("KEEL_MCP_LEVEL") == "admin":
        return "admin"
    if "--write" in argv or os.environ.get("KEEL_MCP_WRITE", "0") == "1" or os.environ.get("KEEL_MCP_LEVEL") == "write":
        return "write"
    return "read"


def write_mode(argv: list[str]) -> bool:
    return level(argv) != "read"


def allowed(argv: list[str]) -> set[str] | None:
    """--allow t1,t2 (or KEEL_MCP_ALLOW): only these tools. An unknown name is an error, so a typo never hides a tool."""
    text = None
    for i, a in enumerate(argv):
        if a == "--allow" and i + 1 < len(argv):
            text = argv[i + 1]
        elif a.startswith("--allow="):
            text = a.split("=", 1)[1]
    text = text if text is not None else os.environ.get("KEEL_MCP_ALLOW")
    if not text:
        return None
    names = {t.strip() for t in text.split(",") if t.strip()}
    unknown = sorted(n for n in names if tool_level(n) is None)
    if unknown:
        raise SystemExit(f"keel mcp: no tool called {', '.join(unknown)}. Tools: {', '.join(sorted(n for v in TOOLS.values() for n in v))}")
    return names


def main(argv: list[str] | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    parser = argparse.ArgumentParser(prog="python -m keel_engine.mcp", description="keel v2 MCP server (stdio)")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--read-only", action="store_true", help="only the read tools (default; what agents get)")
    group.add_argument("--write", action="store_true", help="also deciding gates, answering, starting flows, git / PR / CI / DB writes")
    group.add_argument("--admin", action="store_true", help="also stopping and deleting flows, projects and workflows")
    parser.add_argument("--allow", help="only these tools, comma-separated (within the level)")
    parser.add_argument("--yes", action="store_true", help="no confirm question for push, DB change, delete, stop (when the client cannot ask)")
    args = parser.parse_args(argv)
    build_server(level=level(argv), allow=allowed(argv), yes=bool(args.yes)).run("stdio")
