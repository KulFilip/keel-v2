"""keel 0.18.6: skills through keel's MCP tools (and keel TUI's /skills, /skill and /create skill): the project's skills
and which agents use each (keel_skills), one skill's text (keel_skill), a new one written here (keel_skill_create) or
from a link (keel_skill_import), attached to agents or taken off them (keel_skill_attach), and one from the marketplace
(keel_skill_market_install). Every save asks the person first. A skill only adds words to an agent's prompt: keel's
rules and the phase still decide what the agent may change or run.
"""

from __future__ import annotations

from typing import Any

from .formats import FORMATS
from .marketplace.kinds import PACK_NAME, split_front
from .mcp_api import q
from .mcp_server import ApiError, KeelApi, _project


_q = q


def _k(n: Any) -> str:
    try:
        n = int(n or 0)
    except (TypeError, ValueError):
        return "?"
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)


def _line(s: dict) -> str:
    agents = ", ".join(s.get("agents") or []) or "no agent"
    return (f"- {s.get('id')}  {s.get('kind')} · {s.get('source')} · {_k(s.get('tokens'))} tokens · {agents}"
            + (f" · when {s['when']}" if s.get("when") else "") + ("" if s.get("enabled", True) else " · off")
            + (f"\n    {s['about']}" if s.get("about") else ""))


def skills(api: KeelApi, project: str | None = None) -> str:
    p = _project(api, project)
    rows = api.get(f"/projects/{_q(p['id'])}/skills") or []
    if not rows:
        return f"{p['id']} has no skill."
    return (f"{len(rows)} skills on {p['id']} (id · kind · from · size · the agents that load it):\n"
            + "\n".join(_line(s) for s in rows))


def skill(api: KeelApi, sid: str, project: str | None = None) -> str:
    p = _project(api, project)
    s = api.get(f"/skills/{_q(sid)}", project=p["id"]) or {}
    head = [f"{s.get('id')}  {s.get('kind')} · {s.get('stack')} · {s.get('source')} · version {s.get('version')}"
            f" · {_k(s.get('tokens'))} tokens" + ("" if s.get("enabled", True) else " · off"),
            f"agents: {', '.join(s.get('agents') or []) or 'none'} · when: {s.get('when') or 'on demand'}"]
    if s.get("refs"):
        head.append("references (read only when the agent asks): "
                    + ", ".join(f"{r.get('path')} ({_k(r.get('tokens'))})" for r in s["refs"]))
    return "\n".join(head) + "\n\n" + (s.get("body") or "").strip()


def check_text(text: str) -> tuple[str, list[str]]:
    """A SKILL.md's name and what keel refuses in it (no front matter, no name, a name that is not an id, no text)."""
    fm, body = split_front(text or "")
    errors: list[str] = []
    name = str(fm.get("name") or "").strip()
    if not fm:
        errors.append("it has no front matter: start with ---, name: <id>, description: <one sentence>, ---")
    elif not name:
        errors.append("its front matter has no name")
    elif not PACK_NAME.match(name):
        errors.append(f"its name {name!r} is not an id: lower-case words with dashes, like changelog-entries")
    if fm and not str(fm.get("description") or "").strip():
        errors.append("its front matter has no description (one sentence: what it teaches, when it is needed)")
    if not body.strip():
        errors.append("it has no text after its front matter")
    return name, errors


def _agents(api: KeelApi, pid: str) -> dict[str, dict]:
    return {a["id"]: a for a in api.get(f"/projects/{_q(pid)}/agents") or [] if isinstance(a, dict) and a.get("id")}


def _attach(api: KeelApi, pid: str, sid: str, agents: list[str], detach: bool = False) -> tuple[list[str], list[str]]:
    """Put the skill on these agents (or take it off): the skill's own list, and the agents whose own skill list is set
    in the project (an override), which wins over the skill's list. Returns (the agents now, the changed ones)."""
    known = _agents(api, pid)
    bad = [a for a in agents if a not in known]
    if bad:
        raise ApiError(f"no agent {', '.join(bad)} on {pid}. The agents: {', '.join(known) or 'none'}.")
    now = list((api.get(f"/skills/{_q(sid)}", project=pid) or {}).get("agents") or [])
    after = [a for a in now if a not in agents] if detach else now + [a for a in agents if a not in now]
    api.put(f"/projects/{_q(pid)}/skills/{_q(sid)}", {"agents": after})
    for a in agents:
        mine = known[a]
        if "skills" not in (mine.get("overridden") or []):
            continue
        have = list(mine.get("skills") or [])
        want = [x for x in have if x != sid] if detach else have + ([sid] if sid not in have else [])
        if want != have:
            api.put(f"/projects/{_q(pid)}/agents/{_q(a)}", {"skills": want})
    return after, [a for a in agents if (a in now) == detach]


def attach(api: KeelApi, sid: str, agents: list[str], detach: bool = False, project: str | None = None) -> str:
    if not agents:
        raise ApiError("name the agents: keel_agent_definitions lists them.")
    p = _project(api, project)
    after, changed = _attach(api, p["id"], sid, agents, detach)
    verb = "took" if detach else "put"
    where = "off" if detach else "on"
    if not changed:
        return f"{sid} was {'on none of' if detach else 'already on'} {', '.join(agents)}: nothing changed."
    return (f"{verb} {sid} {where} {', '.join(changed)} on {p['id']}; it is loaded by "
            f"{', '.join(after) or 'no agent'} now, from the next run.")


def _saved(api: KeelApi, pid: str, s: dict, agents: list[str] | None, how: str) -> str:
    sid = s.get("id")
    out = f"saved the skill {sid} on {pid} ({how}, {_k(s.get('tokens'))} tokens)"
    if agents:
        after, _ = _attach(api, pid, sid, agents)
        return out + f"; loaded by {', '.join(after)} from the next run."
    return out + f". Attach it to agents: keel_skill_attach(skill={sid!r}, agents=[...])."


def create(api: KeelApi, text: str, agents: list[str] | None = None, project: str | None = None) -> str:
    name, errors = check_text(text)
    if errors:
        return "keel did not save it:\n" + "\n".join(f"  {e}" for e in errors) + "\n\n" + FORMATS["skill"].split("Example:")[0].strip()
    p = _project(api, project)
    s = api.post(f"/projects/{_q(p['id'])}/skills/import", {"body": text}) or {}
    return _saved(api, p["id"], s, agents, "written here")


def import_url(api: KeelApi, url: str, agents: list[str] | None = None, project: str | None = None) -> str:
    if not url.startswith(("https://", "http://")):
        raise ApiError("give a link to a SKILL.md (https://…, its raw file).")
    p = _project(api, project)
    s = api.post(f"/projects/{_q(p['id'])}/skills/import", {"url": url}) or {}
    return _saved(api, p["id"], s, agents, f"from {url}")


def market_install(api: KeelApi, name: str, version: str | None = None, agents: list[str] | None = None,
                   replace: bool = False, project: str | None = None) -> str:
    if not PACK_NAME.match(name or ""):
        raise ApiError(f"'{name}' is not a skill name (a-z, 0-9 and '-').")
    p = _project(api, project)
    body: dict[str, Any] = {"name": name, **({"version": version} if version else {}),
                            **({"agents": agents} if agents else {}), **({"replace": True} if replace else {})}
    r = api.post(f"/projects/{_q(p['id'])}/skills/market/install", body) or {}
    s, m = r.get("skill") or {}, r.get("market") or {}
    out = (f"installed the skill {s.get('id') or name} {m.get('version') or ''} from the catalog {m.get('catalog') or '?'}"
           f" on {p['id']} ({_k(s.get('tokens'))} tokens)")
    who = s.get("agents") or []
    return out + (f"; loaded by {', '.join(who)} from the next run." if who else
                  f". Attach it to agents: keel_skill_attach(skill={s.get('id') or name!r}, agents=[...]).")


def market_lines(api: KeelApi, q: str = "") -> list[str]:
    """The marketplace's skills that match q, for keel_marketplace_search (nothing when the api has no skill catalog)."""
    try:
        body = api.get("/marketplace/skills", q=q or None) or {}
    except ApiError:
        return []
    out: list[str] = []
    for h in body.get("skills") or []:
        have = ("installed " + str((h.get("installed") or {}).get("version"))
                + (f", update {h['update']}" if h.get("update") else "")) if h.get("installed") else "not installed"
        fits = f"version {h['version']}" if h.get("version") else f"does not fit: {h.get('why_not') or '?'}"
        out.append(f"skill {h.get('name')}  {h.get('title')} · {h.get('publisher_title') or h.get('publisher')} · {have} · {fits}")
        if h.get("summary"):
            out.append(f"  {h['summary']}")
    words = [w for w in (q or "").lower().split() if w]
    for b in body.get("builtin") or []:
        text = f"{b.get('name')} {b.get('summary') or ''} {b.get('kind') or ''}".lower()
        if all(w in text for w in words):
            out.append(f"skill {b.get('name')}  built into keel ({b.get('source')}) · in every project · "
                       f"{_k(b.get('tokens'))} tokens · agents {', '.join(b.get('agents') or []) or 'none'}")
    if out:
        out.append("A skill from the catalogs: keel_skill_market_install; keel's own: keel_skill_attach.")
    return out
