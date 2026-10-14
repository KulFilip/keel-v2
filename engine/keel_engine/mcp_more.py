"""keel v2 0.16.0 MCP tools beyond the first ones (mcp_server.py registers them by level): flows, inbox, live
agents, budget, specs, knowledge, search, files and engine actions (read); answering and sending back (write);
stopping and deleting flows, adding and removing projects, workflows (admin).

Each function takes the KeelApi and returns text for the client. Nothing here reads a secret: no route of keel's
logins, keys or connection secrets is called, and secret files are refused before the api is asked.
"""

from __future__ import annotations

import posixpath
from typing import Any
from urllib.parse import quote

from .mcp_server import ApiError, KeelApi, _flow, _n, _project

SECRET_NAMES = {".env", ".npmrc", ".pypirc", ".netrc", "credentials", "credentials.json", "master.key", "secrets.yml", "secrets.yaml"}
SECRET_SUFFIX = (".pem", ".key", ".p12", ".pfx", ".keystore", ".jks")
READ_MAX_LINES = 400


def is_secret(path: str) -> bool:
    """The same names the api treats as secrets (RepoService.isSecret): never read through MCP."""
    n = posixpath.basename(str(path)).lower()
    if n in (".env.example", ".env.sample", ".env.template"):
        return False
    return (n in SECRET_NAMES or n.startswith(".env.") or n.endswith(SECRET_SUFFIX)
            or n.startswith(("id_rsa", "id_ed25519", "id_ecdsa")))


def _q(x: str) -> str:
    return quote(str(x), safe="")


# ---------------------------------------------------------------- read

def flows(api: KeelApi, project: str | None = None, limit: int = 10) -> str:
    p = _project(api, project)
    rows = api.get(f"/projects/{p['id']}/runs", limit=max(1, min(int(limit or 10), 50))) or []
    if not rows:
        return f"no flow has run on {p['id']} yet."
    return "\n".join(
        f"{r.get('thread_id')}  {r.get('workflow_id') or '?'} \"{r.get('title')}\" · {r.get('status')}"
        + (f" at {r['current']}" if r.get("current") else "") + f" · criteria {r.get('acs_done', 0)}/{r.get('acs_total', 0)}"
        + f" · {_n(r.get('tokens'))} tokens · ${float(r.get('cost_usd') or 0):.2f} · {r.get('where') or 'folder'}"
        + (f" · branch {r['branch']}" if r.get("branch") else "") + (f" · error: {r['error']}" if r.get("error") else "")
        for r in rows)


def inbox(api: KeelApi, project: str | None = None) -> str:
    pid = _project(api, project)["id"] if project else None
    view = api.get("/inbox", project=pid) or {}
    items = view.get("items") or []
    if not items:
        return "nothing waits for a person."
    out = []
    for i in items:
        out.append(f"{i.get('project_id')} · thread {i.get('thread_id')} · {i.get('kind')}: {i.get('title')}"
                   + (f" ({i['ac']})" if i.get("ac") else "") + f" · options {', '.join(i.get('options') or []) or '-'}")
        for q in i.get("questions") or []:
            out.append(f"    {q.get('id')}: {q.get('question')}")
        if i.get("detail"):
            out.append("    " + str(i["detail"])[:300].replace("\n", "\n    "))
    return "\n".join(out)


def live(api: KeelApi, project: str | None = None) -> str:
    pid = _project(api, project)["id"] if project else None
    jobs = api.get("/jobs", project=pid, status="running", limit=50) or []
    if not jobs:
        return "no agent is running."
    out = []
    for j in jobs:
        out.append(f"{j.get('agent')} on {j.get('project_id')} · {' '.join(x for x in (j.get('step'), j.get('ac')) if x)} · "
                   f"{j.get('provider')}/{j.get('model')} · {_n(int(j.get('tokens_in') or 0) + int(j.get('tokens_out') or 0))} tokens · "
                   f"since {j.get('started_at')} · job {j.get('id')}")
        steps = (api.get(f"/jobs/{_q(j['id'])}/steps") or {}).get("steps") or []
        if steps:
            out.append(f"    last: {steps[-1].get('kind')}: {str(steps[-1].get('text') or '')[:160]}")
    return "\n".join(out)


def budget(api: KeelApi, project: str | None = None) -> str:
    p = _project(api, project)
    now = api.get(f"/projects/{p['id']}/budget/now") or {}
    t, m = now.get("today") or {}, now.get("month") or {}
    out = [f"today  {_n(t.get('tokens'))} tokens · ${float(t.get('cost_usd') or 0):.2f}",
           f"month  {_n(m.get('tokens'))} tokens · ${float(m.get('cost_usd') or 0):.2f}"]
    for f in now.get("flows") or []:
        cap = f" of cap {_n(f['cap_tokens'])}" if f.get("cap_tokens") else ""
        out.append(f"flow   \"{f.get('title')}\" ({f.get('status')}) · {_n(f.get('tokens'))} tokens{cap} · ${float(f.get('cost_usd') or 0):.2f}")
    for c in now.get("caps") or []:
        out.append(f"cap    {c.get('scope')} {c.get('window')}: {c.get('left')} of {c.get('limit')} {c.get('unit')} left"
                   + (f" (resets {c['resets_at']})" if c.get("resets_at") else "") + f" · then {c.get('action')}")
    return "\n".join(out)


def specs(api: KeelApi, project: str | None = None, path: str | None = None, history: bool = False) -> str:
    p = _project(api, project)
    pid = p["id"]
    if not path:
        docs = [d for d in api.get(f"/projects/{pid}/keel-docs") or [] if str(d.get("what", "")).startswith("Spec")]
        if not docs:
            lay = api.get(f"/projects/{pid}/layout") or {}
            return f"no spec yet on {pid} (new specs go to {lay.get('specs', 'the spec folder')}/)."
        return "\n".join(f"{d['path']}  {d.get('what')} · updated {d.get('updated') or '-'}" for d in docs)
    page = api.get(f"/projects/{pid}/wiki/page", id=f"spec:{path}") or {}
    out = [page.get("markdown") or ""]
    if history:
        vs = api.get(f"/projects/{pid}/docs/history/versions", path=path) or []
        out += ["", "history (newest first):"] + [
            f"  version {v.get('version')} · {v.get('by_kind')} {v.get('by_name') or ''} · {v.get('phase') or '-'} · {v.get('at')}"
            + (f" · commit {str(v['commit_sha'])[:7]}" if v.get("commit_sha") else "") + f" · id {v.get('id')}" for v in vs]
    return "\n".join(out)


def knowledge(api: KeelApi, project: str | None = None, section: str | None = None) -> str:
    p = _project(api, project)
    pid = p["id"]
    if section:
        return (api.get(f"/projects/{pid}/wiki/page", id=f"kb:{section}") or {}).get("markdown") or ""
    mem = api.get(f"/projects/{pid}/memory") or {}
    out = ["sections:"] + [f"  {k.get('id')}: {k.get('status')} · {k.get('words')} words · {k.get('cites')} citations"
                           for k in mem.get("knowledge") or []]
    facts = mem.get("facts") or []
    if facts:
        out += ["facts:"] + [f"  [{f.get('kind')}] {f.get('title')}: {f.get('text')}" for f in facts[:40]]
    return "\n".join(out)


def search(api: KeelApi, query: str, project: str | None = None, kind: str = "text") -> str:
    p = _project(api, project)
    pid = p["id"]
    if not (query or "").strip():
        raise ApiError("query is empty")
    if kind == "symbol":
        res = api.get(f"/projects/{pid}/graph/search", q=query) or {}
        hits = res.get("results") or res.get("nodes") or []
        if not hits:
            return res.get("reason") or "no symbol found."
        return "\n".join(f"{h.get('kind', '')} {h.get('name')} · {h.get('file') or h.get('path')}:{h.get('line') or h.get('start_line') or ''}"
                         for h in hits[:50])
    res = api.get(f"/projects/{pid}/repo/search", q=query, max=200) or {}
    out = [f"{f['path']}:{m['line']}: {str(m.get('text', '')).strip()[:200]}"
           for f in res.get("results") or [] if not is_secret(f["path"]) for m in f.get("matches") or []]
    tail = " (more: narrow the query)" if res.get("truncated") else ""
    return "\n".join(out[:200]) + (f"\n{res.get('matches')} matches in {res.get('files')} files{tail}" if out else "no match.")


def read_file(api: KeelApi, path: str, project: str | None = None, start: int = 1, lines: int = 200) -> str:
    if is_secret(path):
        raise ApiError(f"{path} holds secrets; keel never reads it through MCP.")
    p = _project(api, project)
    text = api.text(f"/projects/{p['id']}/repo/raw", path=path)
    rows = text[:-1].split("\n") if text.endswith("\n") else text.split("\n")
    start = max(1, int(start or 1))
    n = max(1, min(int(lines or 200), READ_MAX_LINES))
    part = rows[start - 1:start - 1 + n]
    more = f"\n… {len(rows) - (start - 1 + len(part))} more line(s): read on with start={start + len(part)}" if start - 1 + len(part) < len(rows) else ""
    return "\n".join(f"{start + i:>5}  {line}" for i, line in enumerate(part)) + more


def actions(level: str) -> str:
    from .runtime import action_docs

    out = []
    for name in action_docs.dispatch_names():
        lv = action_docs.action_level(name)
        d = action_docs.describe(name)
        mark = " (only inside a flow)" if lv == "flow-only" else " (not at this level)" if _rank(level) < _rank(lv) else ""
        out.append(f"{name} [{lv}]{mark}: {d.get('summary') or ''}")
    return "\n".join(out)


def _rank(level: str) -> int:
    return {"read": 0, "write": 1, "admin": 2}.get(level, 9)


def run_action(api: KeelApi, action: str, level: str, args: dict | None = None, project: str | None = None) -> str:
    from .runtime import action_docs

    if action not in action_docs.dispatch_names():
        raise ApiError(f'no action "{action}". keel_actions lists them.')
    lv = action_docs.action_level(action)
    if lv == "flow-only":
        raise ApiError(f"{action} only runs inside a flow (it needs the flow's criteria and state). Start a flow instead.")
    if _rank(level) < _rank(lv):
        raise ApiError(f"{action} is a {lv} action; this MCP server runs at level {level}.")
    p = _project(api, project)
    r = api.post(f"/projects/{p['id']}/actions/{_q(action)}", {"args": args or {}}) or {}
    return f"{action}: {'ok' if r.get('ok') else 'failed'} · {r.get('note') or ''}" + (f"\n{r['detail']}" if r.get("detail") else "")


# ---------------------------------------------------------------- write

def answer(api: KeelApi, decision: str, project: str | None = None, thread_id: str | None = None, why: str | None = None,
           answers: dict[str, str] | None = None, choice: str | None = None, item_id: str | None = None) -> str:
    """Answer what waits in keel's Inbox: a gate, a clarify question, a choice, or a task item (item_id)."""
    if item_id:
        api.post(f"/inbox/tasks/{_q(item_id)}/act", {"decision": decision, "why": why})
        return f"task item {item_id}: {decision}."
    if not thread_id:
        thread, _ = _flow(api, _project(api, project)["id"])
        if not thread or not thread.get("waiting"):
            return "nothing waits on this project."
        thread_id = thread["thread_id"]
    payload: dict[str, Any] = {}
    if answers:
        payload["answers"] = answers
    if choice:
        payload["choice"] = choice
    st = api.post(f"/inbox/{_q(thread_id)}/act", {"decision": decision, "why": why, "payload": payload or None}) or {}
    return f"answered thread {thread_id} ({decision}). The flow is {st.get('status')} at {st.get('current') or '-'}."


def edit_gate(api: KeelApi, notes: str, project: str | None = None) -> str:
    """Send a waiting gate back with notes: the agent changes its work and the gate asks again."""
    if not (notes or "").strip():
        raise ApiError("notes are empty: say what to change.")
    from .mcp_server import approve_gate

    return approve_gate(api, "reject", project, notes)


def restore_doc(api: KeelApi, path: str, version: int | None = None, project: str | None = None) -> str:
    p = _project(api, project)
    vs = [v for v in api.get(f"/projects/{p['id']}/docs/history/versions", path=path) or [] if not v.get("deleted")]
    pick = next((v for v in vs if version is None or int(v.get("version")) == int(version)), None)
    if not pick:
        raise ApiError(f"no stored version {version or ''} of {path}. keel_specs with history=true lists them.")
    r = api.post(f"/projects/{p['id']}/docs/history/restore", {"version_id": pick["id"]}) or {}
    return f"{path} is back as it was in version {pick['version']} (now version {r.get('version')})."


# ---------------------------------------------------------------- admin

def stop_flow(api: KeelApi, project: str | None = None, thread_id: str | None = None) -> str:
    if not thread_id:
        thread, _ = _flow(api, _project(api, project)["id"])
        if not thread or thread.get("status") not in ("running", "waiting"):
            return "no running or waiting flow on this project."
        thread_id = thread["thread_id"]
    st = api.post(f"/threads/{_q(thread_id)}/stop", {}) or {}
    return f"flow {thread_id} stopped ({st.get('status')})."


def delete_run(api: KeelApi, thread_id: str, project: str | None = None) -> str:
    p = _project(api, project)
    api.delete(f"/projects/{p['id']}/flows/{_q(thread_id)}")
    return f"flow {thread_id} is gone from {p['id']}'s run history (its records stay for budgets)."


def add_project(api: KeelApi, path: str, name: str | None = None) -> str:
    seen = api.get("/folders") or {}
    roots = [r.get("path") for r in seen.get("roots") or [] if r.get("exists", True)]
    if not any(path == r or str(path).startswith(str(r).rstrip("/") + "/") for r in roots):
        raise ApiError(f"keel can't see {path}. Run `keel2 add {path}` in a terminal first, then add it here.")
    p = api.post("/projects", {"root": path, **({"name": name} if name else {})}) or {}
    return f"project {p.get('id')} added ({p.get('root')})."


def remove_project(api: KeelApi, project: str) -> str:
    p = _project(api, project)
    api.delete(f"/projects/{p['id']}")
    return f"project {p['id']} is off the list; keel keeps its history (add the folder again to see it)."


def workflows(api: KeelApi, project: str | None = None, workflow: str | None = None) -> str:
    p = _project(api, project)
    if workflow:
        y = api.text(f"/workflows/{_q(workflow)}/export")
        return y
    rows = api.get(f"/projects/{p['id']}/workflows") or []
    return "\n".join(f"{w.get('id')}  {w.get('name')} · {len(w.get('steps') or [])} steps · {w.get('source') or ''}" for w in rows)


def edit_workflow(api: KeelApi, workflow: str, yaml_text: str, project: str | None = None) -> str:
    p = _project(api, project)
    check = api.post(f"/projects/{p['id']}/workflows/check", {"yaml": yaml_text}) or {}
    if check.get("errors"):
        return "keel did not save it:\n" + "\n".join(f"  {e}" for e in check["errors"])
    api.put(f"/workflows/{_q(workflow)}", {"yaml": yaml_text})
    return f"workflow {workflow} saved."

