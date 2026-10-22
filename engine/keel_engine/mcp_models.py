"""keel 0.18.9: the model and thinking effort of an agent, or of KeelBot, through keel's MCP tools: how a model reads
in the tools' answers (model_text), and keel_agent_model, which changes them (it asks the person first).

The effort choices come from keel's catalog (GET /providers/models): a model's own `efforts`, else its provider's;
[] means the model has no effort setting (keel ignores one). "default" is no effort: the engine's own default.
"""

from __future__ import annotations

from typing import Any

from .mcp_api import q
from .mcp_server import ApiError, KeelApi, _project

KEELBOT = ("keelbot", "helper")     # KeelBot's model is the helper agent's (the Agents page)


_q = q


def model_text(m: dict | None, effort_default: bool = True) -> str:
    """claude/sonnet (subscription) · effort high; "· effort default" when none is set."""
    if not m:
        return "the default model"
    out = f"{m.get('provider')}/{m.get('model')}" + (f" ({m['mode']})" if m.get("mode") else "")
    if m.get("effort"):
        return out + f" · effort {m['effort']}"
    return out + (" · effort default" if effort_default else "")


def efforts_of(catalog: dict, m: dict) -> list[str]:
    """The model's effort choices in keel's catalog: its own list, else its provider's ([] = no effort setting)."""
    prov = (catalog or {}).get(m.get("provider") or "") or {}
    items = ((prov.get("modes") or {}).get(m.get("mode") or "") or [])
    own = next((x for x in items if x.get("id") == m.get("model")), None)
    if own is not None and "efforts" in own:
        return list(own.get("efforts") or [])
    return list(prov.get("efforts") or [])


def _next_model(catalog: dict, now: dict, provider: str | None, mode: str | None, model: str | None,
                effort: str | None) -> dict:
    """The current model with the given parts changed. Another provider starts on its default mode and model; a new
    model keeps the effort when it has it; effort "default" clears it. Refuses an effort the model does not have."""
    nxt = {k: v for k, v in (now or {}).items() if k in ("provider", "mode", "model", "effort") and v}
    if provider and provider != nxt.get("provider"):
        prov = (catalog or {}).get(provider)
        if prov is None:
            raise ApiError(f'no provider "{provider}". keel knows: {", ".join(catalog or {}) or "none"}.')
        d = prov.get("default") or {}
        nxt = {"provider": provider, "mode": d.get("mode") or "api", "model": d.get("model") or ""}
    if mode:
        nxt["mode"] = mode
    if model:
        nxt["model"] = model
    if not nxt.get("provider") or not nxt.get("model"):
        raise ApiError("say which model: provider and model (keel's catalog lists them in the dashboard's model picker).")
    choices = efforts_of(catalog, nxt)
    want = (effort or "").strip().lower()
    if want in ("default", "none"):
        nxt.pop("effort", None)
    elif want:
        if not choices:
            raise ApiError(f"{nxt['provider']}/{nxt['model']} has no effort setting: keel ignores one. Leave effort out.")
        if want not in choices:
            raise ApiError(f'{nxt["provider"]}/{nxt["model"]} has no effort "{want}": pick {", ".join(choices)} or default.')
        nxt["effort"] = want
    elif nxt.get("effort") and nxt["effort"] not in choices:
        nxt.pop("effort")                          # the new model does not have the old effort: its default
    return nxt


def agent_model(api: KeelApi, agent: str, provider: str | None = None, mode: str | None = None, model: str | None = None,
                effort: str | None = None, chat: str | None = None, project: str | None = None) -> str:
    """Change an agent's (or KeelBot's) model and effort for the project; with `chat`, only that KeelBot chat's."""
    if not any((provider, mode, model, effort)):
        raise ApiError("say what to change: provider, mode, model or effort (\"default\" clears the effort).")
    p = _project(api, project)
    catalog: dict[str, Any] = api.get("/providers/models") or {}
    if chat:
        s = api.get(f"/projects/{p['id']}/helper/sessions/{_q(chat)}") or {}
        nxt = _next_model(catalog, s.get("model") or {}, provider, mode, model, effort)
        api.patch(f"/projects/{p['id']}/helper/sessions/{_q(chat)}", {"model": nxt})
        return f"KeelBot's chat {chat} now answers with {model_text(nxt)}."
    aid = "helper" if agent.strip().lower() in KEELBOT else agent.strip()
    rows = api.get(f"/projects/{p['id']}/agents") or []
    row = next((a for a in rows if a.get("id") == aid), None)
    if row is None:
        if aid == "helper":
            raise ApiError("KeelBot is not on in this project (Plugins › KeelBot).")
        raise ApiError(f'no agent "{agent}". keel_agent_definitions lists them.')
    nxt = _next_model(catalog, row.get("model") or {}, provider, mode, model, effort)
    saved = api.put(f"/projects/{p['id']}/agents/{_q(aid)}", {"model": nxt}) or {}
    who = "KeelBot" if aid == "helper" else f"the agent {aid}"
    return (f"{who} now uses {model_text(saved.get('model') or nxt)} on {p['id']}"
            + (" (new chats; keel_agent_model with chat changes an open one)." if aid == "helper" else " (from its next run)."))
