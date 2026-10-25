"""keel Product's code actions (the workflows in product/content/workflows call them). Each one writes a versioned
document in the product repo (docs.py) and tells the api with a "product.*" event; the api keeps the initiative's state.

    product:save-doc        with: {doc: brief|impact|decision|outcome, from: <agent step>}   a new version of a document
    product:plan            with: {from: <agent step>}                                      the plan: check, save, event
    product:deck                                                                            the presentation (deck.py)
    product:record-decision with: {gate: <gate id>}                                         go / not now, and the option
    product:flows           with: {from: <parallel agent step>}                             the business flows, per repo
"""

from __future__ import annotations

import json

from keel_engine.runtime.actions import ActionResult

from . import deck as deck_mod
from . import docs
from . import flows as flows_mod
from . import plan as plan_mod

EVENT_TEXT_MAX = 60_000


def _ini(a) -> dict:
    return dict(a.data.get("initiative") or {})


def _answer(a, src: str | None) -> str:
    """The agent's whole answer (`keep: true` → data["<step>_text"]), else the flow's last answer."""
    if src and a.data.get(f"{src}_text"):
        return str(a.data[f"{src}_text"])
    return str((a.state or {}).get("last_answer") or "")


def save_doc(a) -> ActionResult:
    ini = _ini(a)
    kind = str(a.params.get("doc") or "")
    src = a.params.get("from")
    if not ini.get("id"):
        return ActionResult(False, "This flow has no initiative (data.initiative.id).")
    if kind == "impact" and src and a.data.get(f"{src}_results") is not None:
        repos = []
        parts = ["# Impact", ""]
        teams = {r.get("id"): r for r in a.data.get("repos") or []}
        for r in a.data.get(f"{src}_results") or []:
            text = docs.extract(r.get("text") or "")
            risk = str((r.get("markers") or {}).get("RISK") or "").strip().lower() or docs.risk_of(text) or "unknown"
            risk = next((w for w in ("low", "medium", "high") if risk.startswith(w)), risk)
            repo = teams.get(r.get("item")) or {}
            repos.append({"repo": r.get("item"), "title": r.get("title"), "team": repo.get("team"), "risk": risk, "text": text[:8000]})
            parts += [f"## {r.get('title') or r.get('item')}", f"Team: {repo.get('team_title') or repo.get('team') or '?'} · Risk: {risk}", "", text, ""]
        text = "\n".join(parts).strip()
        extra = {"repos": repos}
    else:
        if kind == "brief" and ((a.state or {}).get("clarify") or {}).get("questions"):
            return ActionResult(True, "nothing to save yet: questions first")
        raw = _answer(a, src)
        if kind == "brief" and docs.only_questions(raw):
            # The product manager asked instead of writing (questions keel's clarify loop did not take: another form,
            # or after its rounds). They are no brief: they go to the gate as questions, the answers back to the step.
            return _hold_for_questions(a, src, raw)
        text = docs.extract(raw)
        extra = {}
    if not text.strip():
        return ActionResult(True, f"nothing to save: the {kind} is empty")
    meta = docs.write(a.root, ini["id"], kind, text)
    if a.event:
        a.event("product.doc", {"initiative": ini["id"], "stage": a.data.get("stage"), **meta, "text": text[:EVENT_TEXT_MAX], **extra})
    return ActionResult(True, f"{kind} v{meta['version']} saved", detail=meta["path"])


ASK_ROUNDS = 3


def _hold_for_questions(a, src: str | None, raw: str) -> ActionResult:
    rounds = int((a.state or {}).get("clarify_rounds") or 0)
    if not src or rounds >= ASK_ROUNDS:
        return ActionResult(False, "The brief step asked questions instead of writing the brief: nothing saved",
                            detail="Send it back with the answers, or ask it to write the brief between BEGIN-DOC and END-DOC.\n\n"
                            + raw.strip()[:1500])
    asked = docs.questions(raw) or [{
        "id": "q1", "question": "The product manager asked these before it writes the brief. Answer them in your own words.",
        "why": raw.strip()[:1200], "options": []}]
    return ActionResult(True, f"nothing to save yet: {len(asked)} question(s) first",
                        update={"clarify": {"questions": asked, "step": src}})


def plan(a) -> ActionResult:
    ini = _ini(a)
    raw = _answer(a, a.params.get("from"))
    found = plan_mod.parse(raw)
    if not found:
        return ActionResult(False, "The story writer gave no plan (a ```json block with epics).",
                            detail="Send it back and ask for the plan JSON at the end of its answer.")
    result = plan_mod.check(found)
    meta = docs.write(a.root, ini["id"], "plan", json.dumps(result["plan"], indent=2), ext="json")
    docs.write(a.root, ini["id"], "plan", plan_mod.markdown(result), ext="md", version=meta["version"],
               message=f"{ini['id']}: plan v{meta['version']} (readable)")
    if a.event:
        a.event("product.plan", {"initiative": ini["id"], "version": meta["version"], "path": meta["path"], "sha": meta["sha"],
                                 **{k: result[k] for k in ("plan", "problems", "ok", "critical_path", "critical_days", "teams",
                                                           "total_days", "counts")}})
    if not result["ok"]:
        return ActionResult(False, f"The plan has {len(result['problems'])} problem(s)", detail="\n".join(result["problems"][:20]))
    c = result["counts"]
    return ActionResult(True, f"plan v{meta['version']}: {c['epics']} epics, {c['stories']} stories, {c['tasks']} tasks")


def deck(a) -> ActionResult:
    ini = _ini(a)
    d = dict(a.data.get("docs") or {})
    memo = docs.extract(_answer(a, a.params.get("memo") or "memo")) or d.get("decision") or ""
    recommend = docs.option_letter(str(((a.state or {}).get("markers") or {}).get("memo", {}).get("RECOMMEND") or d.get("recommend") or ""),
                                   memo)
    versions = dict(a.data.get("versions") or {})
    html = deck_mod.render(ini, brief=d.get("brief") or "", impact_repos=d.get("impact_repos") or [], impact=d.get("impact") or "",
                           memo=memo, recommend=recommend, plan=d.get("plan"), versions=versions)
    meta = docs.write(a.root, ini["id"], "deck", html, ext="html")
    if a.event:
        a.event("product.doc", {"initiative": ini["id"], "stage": a.data.get("stage"), **meta, "text": ""})
    return ActionResult(True, f"presentation v{meta['version']} built", detail=meta["path"])


def record_decision(a) -> ActionResult:
    ini = _ini(a)
    gate = str(a.params.get("gate") or "decide")
    answer = dict(a.data.get(f"{gate}_answer") or {})
    payload = dict(answer.get("payload") or {})
    recommend = docs.option_letter(str(((a.state or {}).get("markers") or {}).get("memo", {}).get("RECOMMEND") or ""),
                                   docs.extract(_answer(a, "memo")))
    choice = str(answer.get("choice") or "")
    option = str(payload.get("option") or (recommend if choice == "go" else "")).strip()
    if a.event:
        a.event("product.decision", {"initiative": ini["id"], "choice": choice, "option": option, "why": answer.get("why") or "",
                                     "revisit": payload.get("revisit"), "recommended": recommend})
    return ActionResult(True, f"decision: {choice}{' · option ' + option if option else ''}")


def flows(a) -> ActionResult:
    """Each repo's flows (one analyst per repo): checked against the repo, kept in the product repo, told to the api."""
    src = a.params.get("from") or "analyse"
    repos = {r.get("id"): r for r in a.data.get("repos") or []}
    found, empty, dropped = 0, [], 0
    for r in a.data.get(f"{src}_results") or []:
        project = str(r.get("item") or "")
        repo = repos.get(project) or {}
        parsed = flows_mod.parse(r.get("text") or "")
        if parsed is None or not repo.get("root"):
            empty.append(project)
            continue
        clean, lost = flows_mod.check(parsed, repo["root"])
        dropped += lost
        found += len(clean)
        try:
            meta = flows_mod.write(a.root, project, clean)
        except docs.DocError as e:
            return ActionResult(False, str(e))
        if a.event:
            a.event("product.flows", {"project": project, "team": repo.get("team"), "flows": clean, "dropped": lost, **meta})
    if found == 0 and empty:
        return ActionResult(False, "No analyst gave its flows (a ```json block with flows).", detail=", ".join(empty))
    note = f"; no flows from {', '.join(empty)}" if empty else ""
    return ActionResult(True, f"{found} flows kept{note}" + (f"; {dropped} cites dropped (no such file:line)" if dropped else ""))


ACTIONS = {
    "product:save-doc": save_doc,
    "product:plan": plan,
    "product:deck": deck,
    "product:record-decision": record_decision,
    "product:flows": flows,
}
