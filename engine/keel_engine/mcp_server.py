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

The plugins' tools (Database, Git, CI/CD: keel_db_*, keel_git_*, keel_pr_*, keel_ci_*) come from the plugins, through
their `keel_mcp` (keel_engine/extensions.py), at the level each part gives them, in keel 0.16.1's places.
The marketplace's four tools come last, at every level (docs/plugins/13-step4-contract.md §7):
keel_marketplace_search, keel_plugin_info, keel_plugins_installed read; keel_plugin_request only opens a request a
person approves in keel's Inbox. There is no install tool: agents ask, people decide.
"""

from __future__ import annotations

import argparse
import copy
import functools
import inspect
import logging
import os
import re
from pathlib import Path
import sys
import time
from datetime import datetime
from typing import Any, Literal
from urllib.parse import quote

import anyio
import httpx
from mcp.server.fastmcp import Context
from pydantic import BaseModel, Field

from . import extensions, rules
from . import mcp_ask as ask_mod
from .runtime import md
from .addons import NAME

log = logging.getLogger("keel.mcp")

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
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status     # the api's HTTP status, when it answered


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
        # v0.18.1 without the internal token, the token the engine gave this server (KEEL_MCP_TOKEN: keel's agents' own
        # server, read level), since the api answers no caller without one.
        self._proof = {"internal": internal_token(), "level": "read", "asked": False,
                       "given": os.environ.get("KEEL_MCP_TOKEN", "").strip()}
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
        if p["asked"]:
            return
        if not p["internal"]:
            if p["given"]:
                self.http.headers[MCP_TOKEN_HEADER] = p["given"]
                p["asked"] = True
            return
        try:
            res = self.http.post("/mcp/token", json={"level": p["level"]}, headers={"X-Keel-Token": p["internal"]})
        except httpx.HTTPError:
            return                                          # the api is not up yet: ask again on the next request
        if res.status_code != 200:
            return                                          # the api is starting or said no: ask again on the next request
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
            raise ApiError(f"{method} {path}: {res.status_code} {msg}", res.status_code)
        return res

    def _send(self, method: str, path: str, **kw) -> Any:
        res = self._raw(method, path, **kw)
        return res.json() if res.content else None

    def text(self, route: str, /, **params) -> str:
        return self._raw("GET", route, params={k: v for k, v in params.items() if v is not None}).text

    def put(self, path: str, body: dict) -> Any:
        return self._send("PUT", path, json=body)

    def patch(self, path: str, body: dict) -> Any:
        return self._send("PATCH", path, json=body)

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
    if api.tool and len(projects) > 1:
        # a write must not land on a project the caller did not pick: the folder matches none, so name the project
        raise ApiError(f"this folder is in none of keel's projects, so keel does not guess which one to change. Pass "
                       f'project (one of: {", ".join(p["id"] for p in projects)}).')
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


def cut(text: str, n: int) -> str:
    """At most n characters, cut at a word boundary, with "…" when something was left out."""
    text = str(text or "")
    if len(text) <= n:
        return text
    head = text[:n]
    at = max(head.rfind(" "), head.rfind("\n"))
    return (head[:at] if at > n // 2 else head).rstrip() + " …"


ORDER_FROM = {"spec": "the spec's ORDER line", "plan": "the plan's ORDER", "keel": "keel moved it (an order question)",
              "person": "you moved it", "id": "criteria ids (no ORDER given)"}


def _choice_lines(w: dict) -> list[str]:
    """A gate with named choices: each name with its label, what it does, the plain approve's pick and whether it needs a
    reason (choice_info; an older engine's prose otherwise)."""
    return ask_mod.choice_lines(w)


def _choice_lines_at(w: dict, indent: str) -> list[str]:
    return ask_mod.choice_lines(w, indent)


GATE_PAGE = 12_000       # 0.18.28 keel_read_gate's page: a gate's text is paged, never cut without a word
STATUS_DETAIL = 4_000    # keel_status shows this much of a gate's text, then says how to read the rest


def plain_lines(w: dict, indent: str = "          ") -> list[str]:
    """0.18.28 what a plain approve and a plain reject do at this gate, and whether the reason is used."""
    out = []
    for k in ("approve", "reject"):
        e = (w.get("plain") or {}).get(k) if isinstance(w.get("plain"), dict) else None
        if isinstance(e, dict) and e.get("does"):
            out.append(f"{indent}a plain {k} here {e['does']} (reason: {e.get('reason') or '-'})")
    return out


def read_gate_hint(thread: dict, project: str | None, page: int = 2) -> str:
    args = ", ".join(x for x in (f"project={project!r}" if project else "", f"flow={thread.get('thread_id')!r}",
                                 f"page={page}" if page != 1 else "") if x)
    return f"keel_read_gate({args})"


def _waiting_lines(w: dict, thread: dict | None = None, project: str | None = None) -> list[str]:
    labels = w.get("labels") or {}
    if w.get("choices"):
        out = [f"waiting   {w.get('kind', 'gate')}: {w.get('title', '')}",
               '          choices (approve with payload {"choice": "<name>"}):', *_choice_lines(w)]
    else:
        opts = " | ".join(f"{o}" + (f' ("{labels[o]}")' if labels.get(o) else "") for o in w.get("options") or [])
        out = [f"waiting   {w.get('kind', 'gate')}: {w.get('title', '')}", f"          options: {opts or '-'}"]
    out += plain_lines(w)
    if w.get("questions"):
        out.append("          questions (answers: {<id>: <label> | [<labels>] | <your words>}):")
        out += ask_mod.question_lines(w["questions"], "            ")
    # a gate's detail is Markdown: the summary first, the fences dropped so a diff or JSON reads as plain text
    detail = md.unfence(w.get("detail") or "").strip()
    if detail:
        shown = detail if len(detail) <= STATUS_DETAIL else cut(detail, STATUS_DETAIL)
        out.append("          " + shown.replace("\n", "\n          "))
        if len(detail) > STATUS_DETAIL:
            # 0.18.28 never cut without a word: how much is left and the call that reads it whole
            pages = -(-len(detail) // GATE_PAGE)
            out.append(f"          (the gate's text goes on: {len(detail):,} characters, {pages} page(s); "
                       f"{read_gate_hint(thread or {}, project, 1)} reads it whole)")
    return out


def read_gate(api: KeelApi, project: str | None = None, flow: str | None = None, page: int = 1) -> str:
    """0.18.28 the whole text of the gate a flow waits at: its title, choices with what each does, questions, the
    plain approve's and reject's effect, its full detail (findings, failure output) and, at a spec gate, the spec,
    paged (GATE_PAGE characters a page)."""
    p = _project(api, project)
    if flow:
        thread = (api.get(f"/projects/{p['id']}/flows/{quote(flow, safe='')}") or {}).get("thread") or {}
    else:
        thread, _ = _flow(api, p["id"])
        thread = thread or {}
    w = thread.get("waiting")
    if thread.get("status") != "waiting" or not w:
        return f"\"{thread.get('title') or flow or p['id']}\" waits for nothing now ({thread.get('status') or 'no flow'})."
    head = [f"gate      {w.get('name') or w.get('step')}: {w.get('title')} · {w.get('kind', 'gate')} · thread {thread.get('thread_id')}"]
    if w.get("choices"):
        head += ['choices (approve with choice="<name>"):', *_choice_lines(w)]
    else:
        head.append("options   " + " | ".join(w.get("options") or ["approve", "reject"]))
    head += plain_lines(w, "")
    if w.get("questions"):
        head += ["questions (answers: {<id>: <label> | [<labels>] | <your words>}):", *ask_mod.question_lines(w["questions"], "  ")]
    body = md.unfence(w.get("detail") or "").strip()
    if thread.get("spec") and (thread.get("phase") in ("spec", "triage") or str(w.get("step") or "").startswith(("spec", "amend"))):
        try:
            from . import mcp_more as more
            body += "\n\n--- the spec ---\n" + more.specs(api, p["id"], thread["spec"])
        except ApiError:
            pass
    pages = max(1, -(-len(body) // GATE_PAGE))
    page = max(1, min(int(page or 1), pages))
    chunk = body[(page - 1) * GATE_PAGE: page * GATE_PAGE]
    out = (head if page == 1 else head[:1]) + ["", f"text      page {page} of {pages} ({len(body):,} characters)", chunk]
    if page < pages:
        out += ["", f"page {page} of {pages}: the next is {read_gate_hint(thread, project, page + 1)}"]
    return "\n".join(out)


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
        order = thread.get("ac_order") or {}
        out.append(f"order     {' → '.join(a.get('id', '') for a in acs)}"
                   + (f" (from {ORDER_FROM.get(order.get('from'), order.get('from'))})" if order.get("from") else ""))
        out += [f"  {('[' + str(a.get('status')) + ']'):<14}{a.get('id')} {a.get('layer', '')}  {a.get('title', '')}" for a in acs]
    if thread.get("waiting"):
        out += _waiting_lines(thread["waiting"], thread, project)
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
            line = "\n".join([f"waiting at {w.get('title')}: answer the {n} question(s), then send them (approve with answers).",
                              *ask_mod.question_lines(w.get("questions"), "  "),
                              *(['  choices (choice="<name>"):', *_choice_lines_at(w, "    ")] if w.get("choices") else []),
                              "  " + ask_mod.how_to_answer(w) + "; keel_answer(ask_person=true) asks the person in a form."])
        elif kind == "budget":
            line = f"waiting at {w.get('title')}: approve to go past the token cap, or reject to stop."
        elif w.get("choices"):
            # before kind fix: a stuck criterion is a fix with real choices, not "approve to try again"
            line = "\n".join([f"waiting at {w.get('step')} ({w.get('title')}){ac}: choose one "
                               '(approve with payload {"choice": "<name>"} and a note):', *_choice_lines(w), *plain_lines(w, "  "),
                              *(["  questions (answers: {<id>: <label> | [<labels>]}):",
                                 *ask_mod.question_lines(w.get("questions"), "    ")] if w.get("questions") else [])])
        elif kind == "fix":
            line = "\n".join([f"waiting at {w.get('title')}: approve to try again, or reject to stop the flow.", *plain_lines(w, "  ")])
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

def start_flow(api: KeelApi, type: str | None, idea: str | None, project: str | None = None, sleep=time.sleep,
               wait: float = START_WAIT, allow_fake: bool = False, title: str | None = None, request: str | None = None,
               ticket: str | None = None, pr: str | None = None, inputs: dict | None = None,
               run_mode: str | None = None) -> str:
    """Start a flow through the dashboard's own endpoint (POST /api/projects/{id}/flows): the same guard, budget, run
    mode and records as a flow started in the web app. It runs until its first human gate, like any flow. No type:
    the flows the project can start, each with what it is for and its inputs."""
    from . import mcp_flows

    p = _project(api, project)
    if not type:
        return mcp_flows.startable(api, p["id"])
    idea = (request or idea or "").strip()
    if not idea and not (ticket or pr):
        raise ApiError("the request is empty: say in a sentence or two what the flow should build or fix "
                       "(or give the ticket / pr a flow like review-pr reads).")
    known = [w.get("id") for w in mcp_flows.catalog(api, p["id"])]
    if known and type not in known:
        raise ApiError(f'no flow type "{type}".\n' + mcp_flows.startable(api, p["id"]))
    body = mcp_flows.start_body(type, title, idea, ticket, pr, inputs)
    title = body["title"]
    if allow_fake:
        body["allow_fake"] = True        # v0.17.5 like the web's "Run with the fake model anyway" box
    if run_mode:
        # 0.18.28 the run mode the person asked for, from the first gate on (a keel_run_mode call after the start came
        # too late for the gates before it, and without a thread id could set another flow's mode)
        if run_mode not in ("manual", "important", "auto", "readonly"):
            raise ApiError("run_mode is one of manual, important, auto, readonly.")
        body["run_mode"] = run_mode
    try:
        state = api.post(f"/projects/{p['id']}/flows", body) or {}
    except ApiError as exc:
        if exc.status == 409 and "fake model" in str(exc) and not allow_fake:
            raise ApiError(f"{exc}\nTo run it on the fake model anyway (example files, committed on the flow's branch), "
                           "call keel_start_flow again with allow_fake=true.", exc.status) from exc
        raise
    tid = state.get("thread_id")
    deadline = time.monotonic() + wait
    while tid and state.get("status") == "running" and time.monotonic() < deadline:
        sleep(START_POLL)
        thread, _ = _flow(api, p["id"])
        if thread and thread.get("thread_id") == tid:
            state = thread
    # still no step and no phase after the wait: the graph has not reached its first step, so say it is starting
    at = f" at {state.get('current') or '-'} (phase {state.get('phase') or 'none'})" if state.get("current") or state.get("phase") else ""
    now = (f"The flow is {state.get('status')}{at}." if at or state.get("status") not in (None, "", "running")
           else "The flow is starting: it has not reached its first step yet.")
    out = [f'started {type} "{title}" on {p["id"]} (thread {tid}) in {state.get("run_mode") or run_mode or "the project\'s"} mode, '
           "recorded as started via MCP.", now]
    if state.get("waiting"):
        out.append(f"It waits for a human: {state['waiting'].get('title')}. Decide it in the dashboard or with keel_approve_gate.")
    elif state.get("status") == "running":
        out.append("It is still running; keel_status follows it, and it stops at its first gate for a human.")
    if state.get("cap_note"):
        out.append(str(state["cap_note"]))
    out.append(f"Watch it: {dashboard_url(api, 'flow', p['id'])}")
    return "\n".join(out)


def approve_gate(api: KeelApi, decision: str, project: str | None = None, why: str | None = None,
                 answers: dict[str, str | list[str]] | None = None, choice: str | None = None,
                 question_id: str | None = None) -> str:
    if decision not in ("approve", "reject"):
        raise ApiError("decision must be approve or reject")
    p = _project(api, project)
    thread, _ = _flow(api, p["id"])
    if not thread or thread.get("status") != "waiting" or not thread.get("waiting"):
        return f"nothing is waiting on {p['id']}: {next_action(api, p['id']).splitlines()[0]}"
    w = thread["waiting"]
    if decision not in (w.get("options") or ["approve", "reject"]):
        return f"{w.get('title')} takes only: {', '.join(w.get('options') or [])}"
    payload: dict[str, Any] = {"answers": answers} if answers else {}
    if w.get("kind") == "clarify" and not answers and decision == "approve":
        return "pass answers, a map of question id to the chosen label(s) or your own words.\n" + ask_mod.text_of(w)
    if choice:
        if w.get("choices") and choice not in w["choices"]:
            return f"{w.get('title')}: \"{choice}\" is not a choice here. Choose one of: {', '.join(w['choices'])}."
        payload["choice"] = choice
    missing = ask_mod.missing_reason(w, decision, choice, why)
    if missing:
        return f"{w.get('title')}: {missing}"
    # the answer is for the question that was shown (a form shows it for minutes): a flow that moved on refuses it (409)
    return _resume(api, thread["thread_id"], decision, why, payload or None, before=w, question_id=question_id or w.get("id"))


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


def _resume(api: KeelApi, tid: str, decision: str, why: str | None, payload: dict | None, before: dict | None = None,
            question_id: str | None = None) -> str:
    body: dict[str, Any] = {"decision": decision}
    if why:
        body["why"] = why
    if question_id:
        # in the payload: the api passes the payload through to the engine as it is
        payload = {**(payload or {}), "question_id": question_id}
    if payload:
        body["payload"] = payload
    state = api.post(f"/threads/{tid}/resume", body) or {}
    what = f" {before.get('title')}" if before else ""
    after = f"{state.get('status')} at {state.get('current') or '-'} (phase {state.get('phase') or 'none'})"
    if state.get("waiting"):
        after += f"; now waiting: {state['waiting'].get('title')}"
    done = "approved" if decision == "approve" else "sent back"
    return f"{done}{what} on thread {tid}. The flow is {after}."


# ---------------------------------------------------------------- the marketplace (step 4): agents find and ask

ASK_IN_PLUGINS = "Ask the person to install it in Control › Plugins."


def _items(body, key: str = "plugins") -> list:
    return body if isinstance(body, list) else (body or {}).get(key) or []


def _perms(perms: dict | None) -> str:
    parts = [f"{k}: {', '.join(str(x) for x in v) if isinstance(v, list) else v}" for k, v in (perms or {}).items()]
    return "; ".join(parts) or "none"


def _source_lines(body) -> list[str]:
    srcs = body.get("sources") if isinstance(body, dict) else None
    return [f"source {s.get('id')}: {s.get('problem') or 'the catalog is old (installs wait for a refresh)'}"
            for s in srcs or [] if s.get("on", True) and (s.get("problem") or s.get("old"))]


def marketplace_search(api: KeelApi, q: str = "", category: str | None = None) -> str:
    body = api.get("/marketplace", q=q or None, category=category or None)
    out = _source_lines(body)
    hits = _items(body)
    if not hits:
        out.append("no plugin in the catalogs matches" + (f' "{q}"' if q else "") + ".")
    for h in hits:
        have = (f"installed {h['installed']}" + (f", update {h['update']}" if h.get("update") else "")
                if h.get("installed") else "not installed")
        fits = f"version {h['version']}" if h.get("version") else f"does not fit: {h.get('why_not') or '?'}"
        out.append(f"{h.get('name')}  {h.get('title')} · trust {h.get('trust')} · {have} · {fits}")
        if h.get("summary"):
            out.append(f"  {h['summary']}")
    if hits:
        out.append("More with keel_plugin_info; keel_plugin_request asks a person to install one.")
    return "\n".join(out)


def _name(name: str) -> str:
    if not isinstance(name, str) or not NAME.match(name):
        raise ApiError(f"'{name}' is not a plugin name (a-z, 0-9 and '-', like db).")
    return name


def plugin_info(api: KeelApi, name: str) -> str:
    p = api.get(f"/marketplace/{_name(name)}") or {}
    pub = f"{p.get('publisher_title') or p.get('publisher')} ({'verified' if p.get('verified') else 'unverified'})"
    out = [f"{p.get('name')}  {p.get('title')} · publisher {pub} · trust {p.get('trust')} · category {p.get('category')}"]
    if p.get("summary"):
        out.append(p["summary"])
    have = (f"installed {p['installed']}" + (f" ({p['installed_from']})" if p.get("installed_from") else "")
            if p.get("installed") else "not installed")
    if p.get("update"):
        have += f"; update {p['update']}"
    if p.get("revoked"):
        have += f"; the installed version is revoked: {p['revoked'].get('why')}"
    out.append(have)
    out.append("versions:")
    for v in p.get("versions") or []:
        req = v.get("requires") or {}
        needs = ", ".join(f"{k} {s}".strip() for k, s in (req.get("plugins") or {}).items())
        state = ("revoked: " + v["revoked"]) if v.get("revoked") else "fits" if v.get("fits") else f"does not fit: {v.get('why_not')}"
        out.append(f"  {v.get('version')}  {v.get('released') or ''} · keel {req.get('keel') or 'any'}"
                   + (f" · needs {needs}" if needs else "") + f" · permissions {_perms(v.get('permissions'))} · {state}")
    plan = p.get("plan")
    if plan:
        steps = ", ".join(f"{s['name']} {s['version']}" + (f" (needed by {s['needed_by']})" if s.get("needed_by") else "")
                          for s in plan.get("install") or [])
        out.append(f"an install adds: {steps}" + (f"; turns on {', '.join(plan['turn_on'])}" if plan.get("turn_on") else ""))
    elif p.get("refused"):
        r = p["refused"]
        out.append(f"keel would refuse an install: {r.get('error')}" + (f" ({r['hint']})" if r.get("hint") else ""))
    out.append("Agents cannot install plugins: keel_plugin_request asks a person.")
    return "\n".join(out)


def plugins_installed(api: KeelApi, project: str | None = None) -> str:
    body = api.get("/plugins/installed") or {}
    out = ["keel has:"]
    for p in _items(body):
        out.append(f"  {p.get('name')} {p.get('version')}  {p.get('title')} · from {p.get('from')} · "
                   f"{'on' if p.get('on') else 'off'} · {p.get('status')}"
                   + (f" · update {p['update']}" if p.get("update") else "")
                   + (f" · problem: {'; '.join(p['problems'])}" if p.get("problems") else ""))
    if len(out) == 1:
        out = ["keel has no plugins (a core-only keel)."]
    if isinstance(body, dict) and any((body.get(k) or {}).get("pending") for k in ("restart", "pending_restart")):
        out.append("changes wait for a restart of keel.")
    try:
        p = _project(api, project)
        on = [x["name"] for x in api.get(f"/projects/{p['id']}/plugins") or [] if x.get("enabled")]
        out.append(f"on in {p['id']}: {', '.join(on) or 'none of the per-project plugins'}")
    except ApiError:
        pass
    return "\n".join(out)


def plugin_request(api: KeelApi, name: str, reason: str, version: str | None = None, project: str | None = None) -> str:
    _name(name)
    if not (reason or "").strip():
        return "Give a reason: the person reads it on the request card in keel's Inbox."
    try:
        if (api.get("/plugins/rules") or {}).get("agents_may_ask") is False:
            return ASK_IN_PLUGINS
    except ApiError:
        pass
    body: dict[str, Any] = {"name": name, "reason": reason.strip()[:2000], "source": "agent"}
    if version:
        body["version"] = version
    try:
        body["project"] = _project(api, project)["id"]
    except ApiError:
        pass
    try:
        r = api.post("/plugins/requests", body) or {}
    except ApiError as exc:
        if exc.status == 409:
            return f"{ASK_IN_PLUGINS} (keel did not open a request: {exc})"
        raise
    joined = " (it joined the request that already waits)" if r.get("joined") else ""
    return (f"Asked a person to install {name}{' ' + version if version else ''}: request {r.get('id')}{joined}. It "
            "waits in keel's Inbox. The plugin can be used only after a person approves it and keel restarts, so go on "
            "without it.")


# ---------------------------------------------------------------- server

# ---- v0.10.0 plugins (Control › Plugins): each part adds its tools (its `keel_mcp`, keel_engine/extensions.py), through
# the api and keel's rules; these are what they share

ASK_WAIT = 600          # an acting tool waits this long for the person's answer in keel's Inbox
ASK_POLL = 3


def _plugin_on(api: KeelApi, pid: str, name: str):
    on = [p["name"] for p in api.get(f"/projects/{pid}/plugins") or [] if p.get("enabled")]
    if name not in on:
        raise ApiError(f"The {extensions.title(name)} plugin is off for {pid}: turn it on in keel (Control › Plugins).")


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


LEVELS = ("read", "write", "admin")
RANK = {"read": 0, "write": 1, "admin": 2}
# Tools that change something hard to undo: the client asks the person first (MCP elicitation), or with --yes not.
# A part's acting tool says so itself (PartServer.act confirm=True: keel_git_push, keel_db_change, as in 0.16.1).
CONFIRM = {"keel_delete_run", "keel_stop_flow", "keel_pause", "keel_stop_flows", "keel_remove_project", "keel_edit_workflow", "keel_restore_doc",
           "keel_rule_edit", "keel_keelbot_keep", "keel_keelbot_undo",
           "keel_workflow_create", "keel_rule_create", "keel_agent_create", "keel_agent_model",
           "keel_skill_create", "keel_skill_import", "keel_skill_attach", "keel_skill_market_install"}
# 0.18.9 a new stack, a removed one and one from the marketplace (turning one off is easy to undo: no question)
CONFIRM |= {"keel_stack_create", "keel_stack_remove", "keel_stack_market_install"}
CONFIRM_ACTIONS = {"open_pr", "pr"}        # keel_run_action actions that publish something: the person is asked first
NO_ELICIT = ("this MCP client cannot ask you to confirm {what}, so keel refuses it. Run keel2 mcp with --yes to allow "
             "it without asking, or do it in keel's dashboard.")


# what every client reads first (the server's instructions): how to answer keel's questions, and the failure rule
QUESTION_HINT = (" A waiting question (keel_status, keel_inbox, keel_next: questions with options, \"pick any\" ones, named "
                 "choices with what each does) and KeelBot's keel-questions cards are the person's to answer: show the "
                 "options, or with --write ask in a form (keel_answer ask_person=true), and send a label per question, a "
                 "list for a pick-any one, or their own words. When something fails, do not run it again unchanged: say "
                 "why in one line and offer the ways forward.")


class Confirm(BaseModel):
    confirm: bool = Field(description="Yes, do it")


def tool_level(name: str) -> str | None:
    """The level a tool is registered at (None: not a keel tool): keel's own (TOOLS), a part's (part_tools), the
    marketplace's (read)."""
    for lv, names in TOOLS.items():
        if name in names:
            return lv
    if name in MARKET_TOOLS:
        return "read"
    for lv, names in part_tools().items():
        if name in names:
            return lv
    return None


class PartServer:
    """What a part's `keel_mcp(server, api, guard, write)` gets as `server` (keel_engine/extensions.py): `tool()`
    registers a tool as keel's own are (only within this server's level and --allow; the part's read tools at read,
    its acting ones at write), and `act()` runs an acting tool as keel's own do (who acts, for the api's audit; with
    `confirm`, the person's OK through the client first)."""

    def __init__(self, reg, act, level: str):
        self._reg, self._act, self.level = reg, act, level

    def tool(self, annotations=None, structured_output: bool = False, **_kw):
        return self._reg(annotations, self.level)

    async def act(self, ctx, name: str, what: str, fn, *a, confirm: bool = False, **kw) -> str:
        return await self._act(ctx, name, what, fn, *a, confirm=confirm, **kw)


class _Names:
    """A stand-in server that only notes the names a part's keel_mcp registers (part_tools)."""

    def __init__(self):
        self.names: list[str] = []

    def tool(self, *_a, **_kw):
        def deco(fn):
            self.names.append(fn.__name__)
            return fn
        return deco


def part_tools() -> dict[str, list[str]]:
    """The parts' tools in keel's MCP server by level: their read tools, and their acting ones (write)."""
    out: dict[str, list[str]] = {}
    for lv, write in (("read", False), ("write", True)):
        rec = _Names()
        extensions.keel_mcp(rec, None, None, write=write)
        out[lv] = rec.names
    return out


# keel's own tools by level, in 0.16.1's order. The parts' tools (Database, Git, CI/CD) come from the parts, in 0.16.1's
# places: their read tools after keel_dashboard, their acting ones after keel_restore_doc (part_tools, build_server).
TOOLS: dict[str, tuple[str, ...]] = {
    "read": ("keel_status", "keel_read_gate", "keel_projects", "keel_timeline", "keel_next", "keel_explain", "keel_dashboard",
             "keel_flows", "keel_inbox", "keel_live", "keel_budget", "keel_specs", "keel_knowledge", "keel_search",
             "keel_read_file", "keel_actions", "keel_run_action", "keel_rules",
             # 0.18.5 what keel TUI shows: the workflows, the agents, one agent, KeelBot's chats and changes, diagrams
             "keel_workflows", "keel_agents", "keel_agent", "keel_keelbot_chats", "keel_keelbot_changes", "keel_diagram",
             # 0.18.5 a new workflow, rule pack or agent: the format, a check that saves nothing, the agents there are
             "keel_format", "keel_workflow_check", "keel_rule_check", "keel_agent_definitions",
             # 0.18.6 skills: the project's (and which agents use each), one skill's text
             "keel_skills", "keel_skill",
             # 0.18.9 stacks: the project's, one with its YAML, what keel reads for a new one, a check that saves nothing
             "keel_stacks", "keel_stack", "keel_stack_suggest", "keel_stack_check"),
    "write": ("keel_approve_gate", "keel_resume", "keel_start_flow", "keel_answer", "keel_edit_gate", "keel_restore_doc",
              # 0.18.5 what keel TUI does: stop flows (asks first), a run mode, go on with a stopped flow, start an
              # agent, ask KeelBot, keep or undo its changes (asks first)
              "keel_stop_flow", "keel_stop_flows", "keel_run_mode", "keel_resume_flow", "keel_agent_start",
              "keel_keelbot_ask", "keel_keelbot_keep", "keel_keelbot_undo",
              # 0.18.5 save a new one (each asks the person first)
              "keel_workflow_create", "keel_rule_create", "keel_agent_create",
              # 0.18.6 a new skill (written here, from a link, from the marketplace) and which agents load it (each asks first)
              "keel_skill_create", "keel_skill_import", "keel_skill_attach", "keel_skill_market_install",
              # 0.18.9 an agent's or KeelBot's model and thinking effort (asks first)
              "keel_agent_model",
              # 0.18.9 a new stack, one removed, one turned off or on, one from the marketplace
              "keel_stack_create", "keel_stack_remove", "keel_stack_off", "keel_stack_market_install"),
    "admin": ("keel_delete_run", "keel_add_project", "keel_remove_project",
              # 0.19.x what the dashboard and keel TUI do with projects: pause a flow, switch the focused project
              "keel_pause", "keel_focus",
              # 0.18.30 connect GitHub with a one-time code (the token is never returned)
              "keel_connect_github",
              "keel_edit_workflow", "keel_rule_install", "keel_rule_edit"),
}
# the marketplace's tools (step 4), after every tool keel 0.16.1 lists, at every level; keel_plugin_request only asks
MARKET_TOOLS = ("keel_marketplace_search", "keel_plugin_info", "keel_plugins_installed", "keel_plugin_request")


def build_server(write: bool = False, api: KeelApi | None = None, level: str | None = None,
                 allow: set[str] | None = None, yes: bool = False):
    """The MCP server at a level (read, write, admin: each includes the one below). A tool above the level, or not in
    `allow` when it is given, is not registered at all, so the client cannot see it."""
    from mcp.server.fastmcp import FastMCP
    from mcp.types import ToolAnnotations

    from . import mcp_more as more
    from . import mcp_tui as tui
    from . import mcp_create as create
    from . import mcp_models as mm
    from . import mcp_skills as sk
    from . import mcp_stacks as stk
    from . import mcp_flows as flows_mod

    api = api or KeelApi()
    lvl = level or ("write" if write else "read")
    if lvl not in LEVELS:
        raise ValueError(f"level must be one of {', '.join(LEVELS)}")
    if hasattr(api, "use_level"):      # (a stand-in object lists the tools without an api)
        api.use_level(lvl)
    ro = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
    rw = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
    rx = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False)
    srv = FastMCP("keel", instructions="keel v2: the flow on each project (phase, criteria, gates), what happened, what to do next, "
                                         "and what each phase permits." + QUESTION_HINT + {"read": "", "write": " Write tools can decide gates, start, stop and resume flows, set a run mode, start agents and ask KeelBot.",
                                                                          "admin": " Write tools can decide gates, start, stop and resume flows, set a run mode, start agents and ask KeelBot; admin tools can also change projects and workflows."}[lvl],
                  log_level="WARNING")

    def reg(ann, at: str | None = None):
        """Registers a tool within the level and --allow. `at`: a part's tool's level (else keel's own, TOOLS).
        0.18.28 a plain (sync) tool runs in a worker thread: its HTTP call to keel's api (up to 15 s) blocked the
        server's event loop, so the client's pings and its other calls waited, and opencode dropped keel's tools
        mid-chat ("Model tried to call unavailable tool")."""
        def deco(fn):
            name = fn.__name__
            if RANK[lvl] < RANK[at or tool_level(name) or "admin"] or (allow is not None and name not in allow):
                return fn
            if not inspect.iscoroutinefunction(fn):
                sync = fn

                @functools.wraps(sync)
                async def threaded(*a, **kw):
                    return await anyio.to_thread.run_sync(lambda: sync(*a, **kw))
                fn = threaded
            return srv.tool(annotations=ann, structured_output=False)(fn)
        return deco

    def guard(fn, *a, **kw) -> str:
        try:
            return fn(*a, **kw)
        except ApiError as exc:
            return f"keel: {exc}"
        except Exception as exc:  # noqa: BLE001 - 0.18.28 one tool's bug is its answer, never the server's end
            log.warning("keel mcp: %s failed", getattr(fn, "__name__", fn), exc_info=True)
            return f"keel: {getattr(fn, '__name__', 'the tool')} failed ({type(exc).__name__}: {str(exc)[:300]})."

    def guard_pair(fn, *a, **kw) -> tuple:
        """A (value, text) call: (None, the api's refusal) when it fails."""
        try:
            return fn(*a, **kw)
        except ApiError as exc:
            return None, str(exc)

    async def act(ctx: Context | None, name: str, what: str, fn, *a, confirm: bool | None = None, **kw) -> str:
        """A write or admin call: says who acts (audit headers), asks the person first when the tool needs it (CONFIRM,
        or a part's `confirm`)."""
        try:
            params = ctx.session.client_params if ctx else None
            client = (params.clientInfo.name if params and params.clientInfo else None) or "an MCP client"
        except Exception:  # noqa: BLE001
            client = "an MCP client"
        mine = api.acting(client, name)
        a = tuple(mine if x is api else x for x in a)
        if (name in CONFIRM if confirm is None else confirm) and not yes:
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

    async def ask_first(ctx, project, thread_id, decision, why, answers, choice, ask_person):
        """keel 0.19.x a waiting question asked as a form: with ask_person, or an approve of a question gate (kind
        clarify) that has no answers yet. The answer, or the text to give back instead (no form, closed, nothing waits).
        Written from the question's data (questions, choice_info), so any new question gate works without code here."""
        w, tid = await anyio.to_thread.run_sync(lambda: guard_pair(more.waiting_of, api, project, thread_id))
        if not w:
            return f"keel: {tid}" if ask_person else (decision, why, answers, choice, thread_id, None)
        if not (ask_person or ask_mod.needs_answers(w, decision, answers, choice)):
            return decision, why, answers, choice, thread_id, None
        got = await ask_mod.ask(ctx, w)
        if isinstance(got, str):
            return got
        d, y, payload = got
        return d, y or why, payload.get("answers"), payload.get("choice"), tid, w.get("id")

    # ---------------------------------------------------------------- read

    @reg(ro)
    def keel_status(project: str | None = None) -> str:
        """The project's flow: branch, workflow, current step and phase, every acceptance criterion with its status,
        what is waiting on a human (title, kind, options, questions), token usage against the cap, and blockers."""
        return guard(status, api, project)

    @reg(ro)
    def keel_read_gate(project: str | None = None, flow: str | None = None, page: int = 1) -> str:
        """The whole text of the gate a flow waits at (flow: its thread id, default the project's flow): its choices
        with what each does, its questions, what a plain approve or reject does, and its full text (findings, the
        failing output, at a spec gate the spec), paged: "page 1 of 3" with the call for the next page."""
        return guard(read_gate, api, project, flow, page)

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
    def keel_rules(project: str | None = None) -> str:
        """keel's rules for the project in plain words: the always-on rules, the ones switched off, the project's lists
        (.keel/config.yml), its rule packs (.keel/rules/), which engines check them before the action or only after the
        step, and — with a flow running — what agents may change now and which rules stopped something."""
        return guard(more.rules, api, project)

    @reg(ro)
    def keel_dashboard(project: str | None = None, view: Literal["flow", "map", "er"] = "flow") -> str:
        """The web address of a dashboard view for the project, to open in a browser: flow (the flow page), map (the
        project map) or er (the database diagram)."""
        return guard(dashboard, api, view, project)

    # the parts' read tools (Database, Git, CI/CD), in the parts' order, where keel 0.16.1 listed them
    extensions.keel_mcp(PartServer(reg, act, "read"), api, guard, write=False)

    @reg(ro)
    def keel_flows(project: str | None = None, limit: int = 10) -> str:
        """The project's flows, newest first: type, title, status, step, criteria, tokens, cost, branch; then every
        flow it can start, one line each on what it is for and the inputs it reads (keel_start_flow starts one)."""
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
        # an action that opens a pull request is asked about first, like keel_git_push (CONFIRM lists tools, not actions)
        return await act(ctx, "keel_run_action", f"run the action {action}", more.run_action, api, action, lvl, args, project,
                         confirm=True if action in CONFIRM_ACTIONS else None)

    # ---------------------------------------------------------------- write

    @reg(rw)
    async def keel_approve_gate(decision: Literal["approve", "reject"], project: str | None = None, why: str | None = None,
                                answers: dict[str, str | list[str]] | None = None, choice: str | None = None,
                                ask_person: bool = False, question_id: str | None = None,
                                ctx: Context | None = None) -> str:
        """Decide the gate the project's flow waits at. approve, or reject (send back) with `why`.
        For questions pass `answers`: question id -> the chosen option label, a list of labels for a "pick any" question,
        or your own words. For a gate with named choices pass `choice` (its name) and `why` when the choice needs a reason.
        An approve of questions without answers (or ask_person) asks the person in a form when this client can show one
        (pick one, tick several, or own words), else gives the questions back as text."""
        got = await ask_first(ctx, project, None, decision, why, answers, choice, ask_person)
        if isinstance(got, str):
            return got
        decision, why, answers, choice, _, shown = got
        return await act(ctx, "keel_approve_gate", "decide the gate", approve_gate, api, decision, project, why, answers, choice,
                         question_id=question_id or shown)

    @reg(rw)
    async def keel_resume(decision: Literal["approve", "reject"] | None = None, thread_id: str | None = None,
                          project: str | None = None, why: str | None = None, payload: dict[str, Any] | None = None,
                          ctx: Context | None = None) -> str:
        """Resume a flow. A waiting one: as the dashboard decides a gate (POST /api/threads/{id}/resume with decision,
        why, payload). A paused (stopped) or failed one, with no decision: go on from its last saved step, like
        keel_resume_flow. thread_id defaults to the project's current flow."""
        if decision is None:
            return await act(ctx, "keel_resume", "resume the flow", tui.resume_flow, api, project, thread_id)
        return await act(ctx, "keel_resume", "resume the flow", resume, api, decision, thread_id, project, why, payload)

    @reg(rw)
    async def keel_start_flow(type: str | None = None, idea: str | None = None, project: str | None = None,
                              allow_fake: bool = False, title: str | None = None, request: str | None = None,
                              ticket: str | None = None, pr: str | None = None, inputs: dict[str, Any] | None = None,
                              run_mode: Literal["manual", "important", "auto", "readonly"] | None = None,
                              ctx: Context | None = None) -> str:
        """Start a keel flow on the project, as the dashboard's "Start a flow" does. No type: every flow the project can
        start (quick, small, implement, change, feature, fix, spike, clarify, review-pr, ...), one line each on what it is for
        and the inputs it reads. type: the workflow id; request (or idea): in your words what to build, fix or find out;
        title: its name (default the request's first line); ticket / pr: the ticket text or key and the pull request a
        flow like review-pr reviews (review-pr also reads the PR number or URL, or `branch: <name>`, from the request's
        first line, and the ticket from the lines after it); inputs: any other input the flow lists (e.g. lens for
        review, scope for lint, branch and base for review-pr). It runs under keel's guard, budget and records, and
        stops at its first human gate. allow_fake: start it even though agents use the fake model (it writes example
        files), like the dashboard's checkbox. run_mode: manual, important, auto or readonly for this flow (default the
        project's setting); pass it here when the person names one, not with keel_run_mode afterwards."""
        if not type:
            from . import mcp_flows
            return guard(mcp_flows.startable, api, project)
        return await act(ctx, "keel_start_flow", f"start a {type} flow", start_flow, api, type, idea, project,
                         time.sleep, START_WAIT, allow_fake, title, request, ticket, pr, inputs, run_mode)

    @reg(rw)
    async def keel_answer(decision: Literal["approve", "reject"] = "approve", project: str | None = None,
                          thread_id: str | None = None, why: str | None = None,
                          answers: dict[str, str | list[str]] | None = None, choice: str | None = None,
                          item_id: str | None = None, ask_person: bool = False, question_id: str | None = None,
                          ctx: Context | None = None) -> str:
        """Answer what waits in keel's Inbox: a gate (approve or reject with why), questions (answers: id -> a label, a
        list of labels for a "pick any" question, or your own words), a named choice (choice, with why when it needs a
        reason), or a task item (item_id). ask_person (or an approve of questions with no answers): keel asks the person
        the waiting question in a form through this client (elicitation: pick one, tick several, own words, a named
        choice with its reason) and sends their answer; a client without forms gets the question as text."""
        if not item_id:
            got = await ask_first(ctx, project, thread_id, decision, why, answers, choice, ask_person)
            if isinstance(got, str):
                return got
            decision, why, answers, choice, thread_id, shown = got
            question_id = question_id or shown
        return await act(ctx, "keel_answer", "answer the Inbox", more.answer, api, decision, project, thread_id, why,
                         answers, choice, item_id, question_id=question_id)

    @reg(rw)
    async def keel_edit_gate(notes: str, project: str | None = None, ctx: Context | None = None) -> str:
        """Send the waiting gate back with notes on what to change; the agent reworks it and the gate asks again."""
        return await act(ctx, "keel_edit_gate", "send the gate back", more.edit_gate, api, notes, project)

    @reg(rw)
    async def keel_restore_doc(path: str, version: int | None = None, project: str | None = None, ctx: Context | None = None) -> str:
        """Put back a spec, knowledge section, ADR or runbook as it was in a stored version (default: the newest)."""
        return await act(ctx, "keel_restore_doc", f"restore {path}", more.restore_doc, api, path, version, project)

    # the parts' acting tools (CI/CD, Database, Git: by name, as keel 0.16.1 listed them); each asks in keel's Inbox first
    extensions.keel_mcp(PartServer(reg, act, "write"), api, guard, write=True)

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

    @reg(rx)
    async def keel_pause(project: str | None = None, thread_id: str | None = None, ctx: Context | None = None) -> str:
        """Pause a running or waiting flow (default: the project's current one): keel stops it and every finished step
        stays saved; keel_resume with no decision goes on from there. keel has no separate cancel: a paused flow that
        is never resumed is cancelled, and keel_delete_run takes it off the history."""
        return await act(ctx, "keel_pause", "pause the flow", flows_mod.pause, api, project, thread_id)

    @reg(rw)
    async def keel_focus(project: str | None = None, chat: str | None = None, ctx: Context | None = None) -> str:
        """The project the dashboard and keel TUI look at (shared between them). No arguments: which one is in focus.
        project: switch both to it; chat: also open this KeelBot chat there."""
        if not project and not chat:
            return guard(flows_mod.focus, api)
        return await act(ctx, "keel_focus", f"switch keel to {project or 'this chat'}", flows_mod.focus, api, project, chat)

    @reg(rw)
    async def keel_connect_github(host: str | None = None, ctx: Context | None = None) -> str:
        """Connect GitHub the way the dashboard's "Sign in with GitHub" does: returns a one-time code and the link
        (github.com/login/device, or your Enterprise host) for the person to open. keel saves the token itself when they
        allow access; this tool never returns the token. host: a GitHub Enterprise host (default github.com)."""
        return await act(ctx, "keel_connect_github", f"start the GitHub sign-in on {host or 'github.com'}", more.connect_github, api, host, confirm=False)

    @reg(ro)
    def keel_workflows(project: str | None = None, workflow: str | None = None) -> str:
        """The project's workflows (id, name, steps); with `workflow`, its YAML."""
        return guard(more.workflows, api, project, workflow)

    # ---------------------------------------------------------------- 0.18.5 what keel TUI can do

    @reg(rx)
    async def keel_stop_flows(flows: list[str] | None = None, all: bool = False, project: str | None = None,
                              ctx: Context | None = None) -> str:
        """Stop flows: these ids (keel_flows lists them; a start of 6+ characters is enough), or every running and waiting
        one (`all`), or none given: the project's current one. Agents at work stop; every finished step stays saved."""
        what = "stop every running or waiting flow" if all else f"stop {', '.join(flows)}" if flows else "stop the flow"
        return await act(ctx, "keel_stop_flows", what, tui.stop_flows, api, project, flows, all)

    @reg(rw)
    async def keel_run_mode(mode: Literal["manual", "important", "auto", "readonly"] | None = None, thread_id: str | None = None,
                            project: str | None = None, ctx: Context | None = None) -> str:
        """A flow's run mode, from its next gate on: manual stops at every gate; important approves a criterion's gate when
        its checks and review pass; auto approves every gate keel can decide (it still stops for money, new dependencies,
        secrets and failures); readonly lets agents read but change nothing. No `mode`: what it is now."""
        if not mode:
            return guard(tui.run_mode, api, None, project, thread_id)
        return await act(ctx, "keel_run_mode", f"run in {mode} mode", tui.run_mode, api, mode, project, thread_id)

    @reg(rw)
    async def keel_resume_flow(thread_id: str | None = None, project: str | None = None, ctx: Context | None = None) -> str:
        """Go on with a stopped or failed flow from its last saved step (the dashboard's Resume). A waiting flow is answered
        with keel_approve_gate instead."""
        return await act(ctx, "keel_resume_flow", "resume the flow", tui.resume_flow, api, project, thread_id)

    @reg(ro)
    def keel_agents(project: str | None = None) -> str:
        """The agents at work on the project's flows, and the person's own agents (keel_agent_start), with their ids."""
        return guard(tui.agents, api, project)

    @reg(ro)
    def keel_agent(agent_id: str, project: str | None = None, steps: int = 15) -> str:
        """One agent: a flow's agent call (its last steps: what it reads, runs and writes, live) or one of the person's own
        (its chat: the task and its answer)."""
        return guard(tui.agent, api, agent_id, project, steps)

    @reg(rw)
    async def keel_agent_start(task: str, mode: Literal["side", "ask"] = "side", project: str | None = None,
                               ctx: Context | None = None) -> str:
        """Start an agent of the person's own on a task: side works in its own git worktree and branch (the project's
        folder stays as it is), ask only reads. It works on its own; keel_agent shows how it does."""
        return await act(ctx, "keel_agent_start", f"start an agent: {task[:60]}", tui.agent_start, api, task, mode, project)

    @reg(rw)
    async def keel_keelbot_ask(text: str, chat: str | None = None, mode: Literal["ask", "edit", "fix", "side"] = "ask", wait: int = 120,
                               project: str | None = None, ctx: Context | None = None) -> str:
        """Ask KeelBot, keel's own assistant that knows the project, its flows and keel's rules: a new chat, or `chat` to go
        on. ask only reads; edit changes the project folder with no flow (a command that changes something asks the person
        in keel first); fix changes files under keel's rules while a flow waits; side works in its own worktree. Waits
        up to `wait` seconds for the answer. Its buttons come back as the keel tools that do them. A keel-questions card
        in its answer (questions with options, "pick any" ones too) comes back with the answers message to send: ask the
        person, then call this again with chat and that text (a label per question, a list joined with "; ", or their
        own words). When a command fails KeelBot does not run it again unchanged: it says why in one line and offers 2
        to 4 ways forward as such a card, the safe one recommended; the person picks, nobody retries blindly."""
        return await act(ctx, "keel_keelbot_ask", "ask KeelBot", tui.keelbot_ask, api, text, project, chat, mode, wait)

    @reg(ro)
    def keel_keelbot_chats(project: str | None = None) -> str:
        """KeelBot's chats on the project (and the person's agents), newest first, with their ids."""
        return guard(tui.keelbot_chats, api, project)

    @reg(ro)
    def keel_keelbot_changes(chat: str, project: str | None = None, diffs: bool = True) -> str:
        """The files KeelBot (or an agent of the person's) changed in a chat and has not kept yet, with their diffs."""
        return guard(tui.keelbot_changes, api, chat, project, diffs)

    @reg(rw)
    async def keel_keelbot_keep(chat: str, paths: list[str] | None = None, message: str = "", project: str | None = None,
                                ctx: Context | None = None) -> str:
        """Keep KeelBot's changes of a chat (these paths, or all): keel runs the checks, then commits them."""
        return await act(ctx, "keel_keelbot_keep", f"keep {', '.join(paths) if paths else 'every change'} of chat {chat}",
                         tui.keelbot_keep, api, chat, paths, message, project)

    @reg(rx)
    async def keel_keelbot_undo(chat: str, path: str | None = None, project: str | None = None, ctx: Context | None = None) -> str:
        """Put back what KeelBot changed in a chat (one path, or every file)."""
        return await act(ctx, "keel_keelbot_undo", f"put back {path or 'every file'} of chat {chat}", tui.keelbot_undo, api, chat, path, project)

    # ---------------------------------------------------------------- 0.18.5 new workflows, rule packs and agents

    @reg(ro)
    def keel_format(kind: Literal["workflow", "rule", "agent", "skill", "stack"]) -> str:
        """How a new workflow (YAML), rule pack (YAML), agent (JSON), skill (SKILL.md) or stack (YAML) is written, with an
        example. Read it before keel_workflow_create, keel_rule_create, keel_agent_create, keel_skill_create or
        keel_stack_create."""
        return guard(create.fmt, kind)

    @reg(ro)
    def keel_workflow_check(yaml: str, project: str | None = None) -> str:
        """What a workflow YAML would be (steps, gates, agents, commands) and its errors, line by line; saves nothing."""
        return guard(create.check_workflow, api, yaml, project)

    @reg(rw)
    async def keel_workflow_create(yaml: str, folder: str | None = None, project: str | None = None, ctx: Context | None = None) -> str:
        """Save a new workflow (its whole YAML; keel_format kind=workflow shows how), in a folder of the Workflows page if
        given. keel checks it first and saves nothing when it has errors. Asks the person first."""
        return await act(ctx, "keel_workflow_create", "save this new workflow", create.create_workflow, api, yaml, folder, project)

    @reg(ro)
    def keel_rule_check(yaml: str, project: str | None = None) -> str:
        """Check a rule pack's YAML and what it would have refused on the project's recent tool calls; saves nothing."""
        return guard(create.check_rule, api, yaml, project)

    @reg(rw)
    async def keel_rule_create(yaml: str, project: str | None = None, ctx: Context | None = None) -> str:
        """Save a new rule pack (its YAML; keel_format kind=rule shows how) in .keel/rules/: it only refuses, from the next
        tool call on. keel checks it first. Asks the person first."""
        return await act(ctx, "keel_rule_create", "save this new rule pack", create.create_rule, api, yaml, project)

    @reg(ro)
    def keel_agent_definitions(project: str | None = None) -> str:
        """The agents a workflow can use on the project (keel's and the person's own): id, tools, phases, what each is for."""
        return guard(create.agent_definitions, api, project)

    @reg(rw)
    async def keel_agent_create(name: str, prompt: str, about: str = "", tools: list[str] | None = None,
                                phases: list[str] | None = None, provider: str | None = None, mode: str | None = None,
                                model: str | None = None, effort: str | None = None, project: str | None = None,
                                ctx: Context | None = None) -> str:
        """Save a new agent for the project: its name, instructions (prompt), what it is for, its tools (Read, Grep, Glob
        read only; Edit, Write change files; Bash runs commands) and phases (any, or keel phases); optionally its model
        (provider claude | codex | copilot | fake, mode, model) and thinking effort (low, medium, high, xhigh, max: what
        the model offers; none = the engine's default). keel's rules and the phase still decide what it may change.
        Asks the person first."""
        return await act(ctx, "keel_agent_create", f"save the new agent {name}", create.create_agent, api, name, prompt, about,
                         tools, phases, project, provider=provider, mode=mode, model=model, effort=effort)

    @reg(rw)
    async def keel_agent_model(agent: str, provider: str | None = None, mode: str | None = None, model: str | None = None,
                               effort: str | None = None, chat: str | None = None, project: str | None = None,
                               ctx: Context | None = None) -> str:
        """Change the model and thinking effort an agent uses on the project (agent: its id from keel_agent_definitions,
        or keelbot for KeelBot). Give only what changes: provider (claude | codex | copilot | fake), mode
        (subscription | api | opencode), model, effort (what the model offers, e.g. low, medium, high, xhigh, max;
        "default" = the engine's own). With `chat`, only that KeelBot chat changes. Asks the person first."""
        what = f"use {'/'.join(x for x in (provider, model) if x) or 'its model'}" + (f" with effort {effort}" if effort else "")
        return await act(ctx, "keel_agent_model", f"{what} for {chat and f'KeelBot chat {chat}' or agent}", mm.agent_model, api,
                         agent, provider, mode, model, effort, chat, project)

    # ---------------------------------------------------------------- 0.18.6 skills

    @reg(ro)
    def keel_skills(project: str | None = None) -> str:
        """The project's skills (keel's, its stack packs', the person's own and the marketplace's): id, kind, where it
        comes from, its size in tokens, the agents that load it and when, and whether it is off."""
        return guard(sk.skills, api, project)

    @reg(ro)
    def keel_skill(skill: str, project: str | None = None) -> str:
        """One skill: its SKILL.md text, the agents that load it, its size, and its references (read only when asked)."""
        return guard(sk.skill, api, skill, project)

    @reg(rw)
    async def keel_skill_create(text: str, agents: list[str] | None = None, project: str | None = None,
                                ctx: Context | None = None) -> str:
        """Save a new skill: its whole SKILL.md (front matter name and description, then the text; keel_format
        kind=skill shows how), and put it on these agents if given. Asks the person first."""
        return await act(ctx, "keel_skill_create", "save this new skill" + (f" for {', '.join(agents)}" if agents else ""),
                         sk.create, api, text, agents, project)

    @reg(rw)
    async def keel_skill_import(url: str, agents: list[str] | None = None, project: str | None = None,
                                ctx: Context | None = None) -> str:
        """Save a skill from a link to its SKILL.md (https, the raw file, at most 256 KB), and put it on these agents if
        given. Asks the person first."""
        return await act(ctx, "keel_skill_import", f"save the skill at {url}", sk.import_url, api, url, agents, project)

    @reg(rw)
    async def keel_skill_attach(skill: str, agents: list[str], detach: bool = False, project: str | None = None,
                                ctx: Context | None = None) -> str:
        """Put a skill on these agents (their prompt gets its text from the next run), or take it off them with
        detach=true. keel_agent_definitions lists the agents. Asks the person first."""
        what = f"{'take' if detach else 'put'} the skill {skill} {'off' if detach else 'on'} {', '.join(agents)}"
        return await act(ctx, "keel_skill_attach", what, sk.attach, api, skill, agents, detach, project)

    @reg(rw)
    async def keel_skill_market_install(name: str, version: str | None = None, agents: list[str] | None = None,
                                        replace: bool = False, project: str | None = None,
                                        ctx: Context | None = None) -> str:
        """Install a skill from the marketplace's catalogs (keel_marketplace_search finds them) into the project, its
        signed SKILL.md checked first, and put it on these agents if given. replace=true updates an installed one.
        Asks the person first."""
        return await act(ctx, "keel_skill_market_install", f"install the skill {name} from the marketplace",
                         sk.market_install, api, name, version, agents, replace, project)

    # ---------------------------------------------------------------- 0.18.9 stacks

    @reg(ro)
    def keel_stacks(project: str | None = None) -> str:
        """How the project builds and tests: every stack keel knows for it (keel's, its packs, the project's own, the
        marketplace's), its lane, where it comes from, and whether the project uses it, turned it off, or may remove it."""
        return guard(stk.stacks, api, project)

    @reg(ro)
    def keel_stack(stack: str, project: str | None = None) -> str:
        """One stack: its test layers, commands and tools, where it comes from, whether it can be removed, and its YAML."""
        return guard(stk.stack, api, stack, project)

    @reg(ro)
    def keel_stack_suggest(lane: Literal["api", "web"] | None = None, project: str | None = None) -> str:
        """What keel reads in the project's files for a new stack: the lane, the files that detect it, test layers, and per
        command (test one criterion, every test, a package, coverage, static checks, migrate, compile) the project's own
        commands with where each was found (package.json, Gradle, Maven, pyproject, composer.json, a Makefile); tools."""
        return guard(stk.suggest, api, lane, project)

    @reg(ro)
    def keel_stack_check(yaml: str, replace: bool = False, project: str | None = None) -> str:
        """Check a stack's YAML (keel_format kind=stack shows how): its errors and warnings, and whether its detect block
        matches the project. Saves nothing."""
        return guard(stk.check, api, yaml, project, replace)

    @reg(rw)
    async def keel_stack_create(yaml: str, replace: bool = False, project: str | None = None, ctx: Context | None = None) -> str:
        """Save a new stack for the project (.keel/stacks/<name>.yml): its whole YAML. keel checks it first and saves
        nothing when it has errors; replace=true writes over the project's stack with that name. Asks the person first."""
        return await act(ctx, "keel_stack_create", "save this stack", stk.create, api, yaml, replace, project)

    @reg(rx)
    async def keel_stack_remove(stack: str, project: str | None = None, ctx: Context | None = None) -> str:
        """Remove a stack the project added (its own, an installed pack, one from the marketplace). keel's own stacks
        cannot be removed: turn them off with keel_stack_off. Asks the person first."""
        return await act(ctx, "keel_stack_remove", f"remove the stack {stack}", stk.remove, api, stack, project)

    @reg(rw)
    async def keel_stack_off(stack: str, off: bool = True, project: str | None = None, ctx: Context | None = None) -> str:
        """Turn a stack off for the project (keel does not use it there: no detection, its tools never run), or on again
        with off=false. Needs .keel/config.yml."""
        return await act(ctx, "keel_stack_off", f"turn the stack {stack} {'off' if off else 'on'}", stk.switch, api, stack, off,
                         project)

    @reg(rw)
    async def keel_stack_market_install(name: str, version: str | None = None, replace: bool = False,
                                        project: str | None = None, ctx: Context | None = None) -> str:
        """Install a stack from the marketplace's catalogs (keel_marketplace_search finds them) into the project, its
        signed YAML checked first. replace=true updates an installed one. Asks the person first."""
        return await act(ctx, "keel_stack_market_install", f"install the stack {name} from the marketplace",
                         stk.market_install, api, name, version, replace, project)

    @reg(ro)
    def keel_diagram(kind: Literal["flow", "workflow", "map-er", "map-system", "map-modules", "graph"], arg: str | None = None,
                     project: str | None = None, width: int = 120) -> str:
        """keel's ASCII diagrams: flow (the running flow, done steps and the waiting gate; arg zooms to a step), workflow
        (arg: its id), map-er (arg: a table to focus), map-system, map-modules, graph (arg: a symbol's name)."""
        return guard(tui.diagram, api, kind, arg, project, width)

    @reg(rx)
    async def keel_edit_workflow(workflow: str, yaml: str, project: str | None = None, ctx: Context | None = None) -> str:
        """Change a workflow: the whole YAML (keel_workflows with `workflow` shows it). keel checks it first; nothing is
        saved when the check finds errors."""
        return await act(ctx, "keel_edit_workflow", f"change the workflow {workflow}", more.edit_workflow, api, workflow, yaml, project)

    @reg(rw)
    async def keel_rule_install(pack: str, project: str | None = None, ctx: Context | None = None) -> str:
        """Install a rule pack from keel's library into the project (.keel/rules/<pack>.yaml): strict-secrets,
        no-new-dependencies, migrations-only-in-flow, frontend-not-api, stack-spring, stack-node, stack-python."""
        return await act(ctx, "keel_rule_install", f"install the rule pack {pack}", more.rule_install, api, pack, project)

    @reg(rx)
    async def keel_rule_edit(op: Literal["add", "change", "remove", "off", "on"], pack: str | None = None, yaml: str | None = None,
                             rule: str | None = None, project: str | None = None, ctx: Context | None = None) -> str:
        """Change the project's rules. add / change: a rule pack's whole YAML (keel checks it and says how many recent
        tool calls it would have refused); remove: a pack; off / on: a built-in rule that may be switched off (e.g.
        read-twice) or a pack as pack/<id>. Rules that protect secrets or history never switch off."""
        what = {"add": "add a rule pack", "change": f"change the rule pack {pack}", "remove": f"remove the rule pack {pack}",
                "off": f"switch off {rule}", "on": f"switch on {rule}"}.get(op, op)
        return await act(ctx, "keel_rule_edit", what, more.rule_edit, api, op, pack, yaml, rule, project)

    # ---------------------------------------------------------------- the marketplace (step 4)
    # last at every level (keel 0.16.1's list keeps its order); asking for a plugin is allowed read-only

    @reg(ro)
    def keel_marketplace_search(q: str = "", category: str | None = None) -> str:
        """Search the plugin catalogs keel reads: each plugin's name, title, trust level (content, web or code),
        summary, and whether this keel has it. category: code, knowledge, tickets, review, product or other. The skills
        and stacks that match come after (the catalogs' and keel's own)."""
        def both() -> str:
            from . import mcp_skills, mcp_stacks
            text = marketplace_search(api, q, category)
            more = [] if category else mcp_skills.market_lines(api, q) + mcp_stacks.market_lines(api, q)
            return text + ("\n" + "\n".join(more) if more else "")
        return guard(both)

    @reg(ro)
    def keel_plugin_info(name: str) -> str:
        """One plugin of the catalogs: its versions, the permissions each asks for, the plugins it needs, and what an
        install would add."""
        return guard(plugin_info, api, name)

    @reg(ro)
    def keel_plugins_installed(project: str | None = None) -> str:
        """The plugins this keel has (version, from the image or the marketplace, on or off, loaded or waiting for a
        restart) and the ones that are on in the project."""
        return guard(plugins_installed, api, project)

    ask = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False)

    @reg(ask)
    def keel_plugin_request(name: str, reason: str, version: str | None = None, project: str | None = None) -> str:
        """Ask a person to install a plugin: it opens a request in keel's Inbox with your reason (required, in your
        own words) and never installs anything itself. One request per plugin; a second one joins it."""
        return guard(plugin_request, api, name, reason, version, project)

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
        every = {n for v in TOOLS.values() for n in v} | set(MARKET_TOOLS) | {n for v in part_tools().values() for n in v}
        raise SystemExit(f"keel mcp: no tool called {', '.join(unknown)}. Tools: {', '.join(sorted(every))}")
    return names


PLUGIN_ENV = ("KEEL_PLUGIN_PATHS", "KEEL_PLUGIN_ADDONS")
IMAGE_RUN_DIR = Path("/data/plugins/run")   # keel's image keeps its data in /data (Dockerfile KEEL_DATA)


def plugin_env() -> None:
    """The plugins whose tools this server adds (their `keel_mcp`). The engine hands its own to the servers it starts
    (tools/mcp.py keel_server_env). `keel2 mcp` runs beside the engine (docker exec), not as its child: then the ones
    keel's last start resolved ($KEEL_DATA/plugins/run/env), so the person gets the same tools as before. Codex and
    Copilot start MCP servers with no environment at all (no KEEL_DATA either): then keel's image folder, /data."""
    if any(os.environ.get(k) for k in PLUGIN_ENV):
        return
    from .pluginhost import resolver

    env = resolver.read_env()
    if not env and not os.environ.get("KEEL_DATA"):
        env = resolver.read_env(IMAGE_RUN_DIR)
    found = {k: v for k, v in env.items() if k in PLUGIN_ENV and v}
    if found:
        os.environ.update(found)
        extensions.reload()


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
    plugin_env()                    # before allowed(): --allow may name a plugin's tool
    run_stdio(build_server(level=level(argv), allow=allowed(argv), yes=bool(args.yes)))


def run_stdio(srv) -> None:
    """0.18.28 the stdio transport on the real stdout, and every other write to stdout (a print in a part, a library's
    warning) goes to stderr: one stray line on stdout broke the JSON-RPC stream and the client dropped the server.
    Logs go to stderr only."""
    import io

    from mcp.server.stdio import stdio_server

    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    out = sys.stdout.buffer
    sys.stdout = sys.stderr

    async def serve():
        protocol = anyio.wrap_file(io.TextIOWrapper(out, encoding="utf-8"))
        async with stdio_server(stdout=protocol) as (read, write):
            await srv._mcp_server.run(read, write, srv._mcp_server.create_initialization_options())

    anyio.run(serve)
