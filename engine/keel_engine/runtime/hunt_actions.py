"""The code steps of the hunt and hunt-next workflows (content/workflows/hunt.yaml, hunt-next.yaml).

    hunt_start     opens a run in the backlog: mode auto|semi, scope, fast, the proposed lenses (settings or seed), the
                   stack's health; the lens gate asks the mode and the lenses as questions
    hunt_confirm   the mode and the lens set the user confirmed at the gate -> one sweep item per lens and lane, each
                   with the base URLs and the environment caution (shared unless hunt.disposable)
    hunt_map       one explorer's map of the repository (no knowledge base yet) -> every sweep item
    hunt_deps      the security lens runs the dependency audit first (always, not only when a manifest changed)
    hunt_ingest    each hunter's JSON list -> candidates (lane enforced, severity dropped, duplicates merged);
                   writes candidates.md (UNVERIFIED) and the prover items (symptom only)
    hunt_stack     before the provers: the stack's health (commands.services first when it is down); down -> a gate
    hunt_verdicts  each prover's verdict -> the backlog; a refused verdict sends that candidate back to the provers
    hunt_group     the investigator's groups (findings that share one cause)
    hunt_report    report.md + recipes; refuses while any candidate has no verdict
    hunt_commit    commits docs/hunts/<run>/ as docs(HUNT-<run>)
    hunt_close     closes a finding or group (fixed | accepted | wontfix + a note) from a gate's answer
    hunt_preview   hunt-next: what take would hand over (the top group, its severity, a stale verdict) for the gate
    hunt_take      hunt-next: the top open group (or the one picked) -> fix (defect) or feature (unspecified), with the recipe

Steps branch on the marker LEFT (verdicts: none | some) and FLOW (take: fix | feature | none), set as the latest
value of that marker ("*").
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from .. import layout, rules
from ..rules import checks
from ..tools import git, testcmd
from ..tools.agent_tools import command_env
from . import hunt
from . import verdict_actions as va
from .actions import ActionInput, ActionResult, commit_args

MODES = ("auto", "semi")


def _data(a: ActionInput, **changes) -> dict:
    return {**a.data, **changes}


def _marker(a: ActionInput, name: str, value: str, step: str) -> dict:
    mk = dict(a.state.get("markers") or {})
    mk[step] = {**(mk.get(step) or {}), name: value}
    mk["*"] = {**(mk.get("*") or {}), name: value}
    return mk


def _hunt(a: ActionInput) -> dict:
    return dict(a.data.get("hunt") or {})


def _options(a: ActionInput) -> dict:
    """The hunt's start options: the thread's settings, the flow options (the API's `options`, kept in data), else the
    seed a parent flow passed (init's audit-now)."""
    seed = a.data.get("seed") if isinstance(a.data.get("seed"), dict) else {}
    out = {}
    for k in ("mode", "scope", "lenses", "fast", "run"):
        for src in (a.settings, a.data, seed):
            v = src.get(f"hunt_{k}", src.get(k))
            if v not in (None, "", []):
                break
        out[k] = v if v not in (None, "", []) else None
    return out


def _lens_list(v) -> list[str]:
    if isinstance(v, str):
        v = v.split(",")
    return [str(x).strip() for x in v or [] if str(x).strip()]


def _health(a: ActionInput, cfg: dict, key: str) -> str:
    cmd = (cfg.get("commands") or {}).get(key)
    if not cmd:
        return "unknown"
    if a.fake:
        return "unknown (simulated)"
    code, _ = testcmd.run(a.root, cmd, 15, command_env())
    return "ok" if code == 0 else "down"


def _stack_line(stack: dict) -> str:
    return " · ".join(f"{k} {v}" for k, v in (stack or {}).items()) or "unknown"


def _down(stack: dict) -> list[str]:
    return [k for k, v in (stack or {}).items() if v == "down"]


def _env_fields(root: str) -> dict:
    """What every hunter and prover item carries about the running system (keel v1 hunt: base URLs for a lens that
    acts, and "name what the environment is, and whose it is"). Leaving the caution out is how a sweep costs someone
    their data: the guards stop writes to the repository, nothing stops an agent from reaching a database."""
    kcfg, cfg = rules.load_config(root), hunt.settings(root)
    e2e = kcfg.get("e2e") if isinstance(kcfg.get("e2e"), dict) else {}
    urls = {k: str(e2e[f"{k}_url"]) for k in ("api", "web") if e2e.get(f"{k}_url")}
    told = str(cfg.get("environment") or "").strip() or \
        "Not described (hunt.environment in .keel/config.yml): find the database and broker from the project's config."
    if cfg.get("disposable") is True:
        caution = ("The project marks this environment disposable (hunt.disposable: true): you may reset it, but say in "
                   "your answer what you changed.")
    else:
        caution = ("CAUTION: treat every database, broker and service you reach as shared with other people and working "
                   "copies. Insert your own probe rows freely; do NOT truncate tables, drop anything, or delete or change "
                   "rows you did not create, and do not restart shared services. If you need a disposable database, "
                   "create one and apply the migrations to it yourself.")
    return {"base_urls": urls, "environment": f"{told}\n{caution}"}


def _mode_question(mode: str, hunters: int) -> dict:
    """0.19.x ask the mode first (keel v1 hunt "Ask this first"), with what each costs; the current mode is recommended
    and listed first. The answer (payload.answers.mode, or payload.mode) is the mode hunt_confirm runs with."""
    about = {
        "semi": ("You decide twice more: after the sweep (the candidates page) and before the report. Nothing is "
                 "proved until you say so, so no prover tokens go to candidates you would drop."),
        "auto": (f"Runs on to the report without stopping again: {hunters} hunter(s), then one prover per candidate. "
                 "Safe to let run (a hunt changes no code); the worst case is time and tokens, and the report says which "
                 "gates no person saw."),
    }
    order = [mode, *[m for m in MODES if m != mode]]
    return {"id": "mode", "question": "How closely do you want to watch this hunt?",
            "why": "Settle it before the sweep: auto spends the prover tokens without asking.",
            "options": [{"label": m, "description": about[m], "recommended": m == mode} for m in order]}


def _lens_detail(cfg: dict, run: dict, proposed: list[str]) -> str:
    pairs = hunt.sweep_pairs(cfg, proposed)
    stack = run.get("stack") or {}
    lines = [f"Hunt {run['run']} ({run['mode']}{', fast' if run['fast'] else ''}), scope {run['scope']['mode']}"
             + (f": {', '.join(run['scope']['paths'])}" if run["scope"].get("paths") else "") + ".", "",
             "A hunt changes no code. Hunters propose candidates, a prover tries to reproduce each one against the running "
             "stack, and only what reproduces gets a severity. The report and a backlog are what it leaves.", "",
             f"Stack now: {_stack_line(stack)}."
             + (f" The provers need it running: start the {' and '.join(_down(stack))} before the prove step "
                "(keel checks again there)." if _down(stack) else ""), "",
             f"Mode: {run['mode']} (answer the mode question to change it). semi stops after the sweep and before the "
             f"report; auto runs on: {len(pairs)} hunter(s), then one prover per candidate.", "",
             "Proposed lenses (one hunter per lens and lane):"]
    lines += [f"- {lens} [{', '.join(hunt.lanes_for(cfg, lens))}]: {hunt.LENS_HELP.get(lens, '')}" for lens in proposed]
    off = [x for x in cfg["lenses"] if x not in proposed]
    if off:
        lines.append(f"Not looked through: {', '.join(off)}.")
    lines += ["", f"{len(pairs)} hunter(s). Confirm to sweep with these. To change the set, answer with the lenses you want "
              "(payload.lenses, or tick them: payload.answers.lenses), or name them in your note; \"drop x, y\" removes lenses."]
    if run["mode"] == "semi":
        lines.append("Semi mode: the flow also stops after the sweep (candidates page) and after the provers.")
    return "\n".join(lines)


def _lens_question(cfg: dict, proposed: list[str]) -> dict:
    """0.19.0 the lens set as a question a form can show: every configured lens, the proposed ones ticked. The answer
    (payload.answers.lenses) is the set hunt_confirm sweeps with, like payload.lenses."""
    names = list(dict.fromkeys([*proposed, *cfg["lenses"]]))
    return {"id": "lenses", "question": "Which lenses should the hunters look through?",
            "why": "One hunter runs per lens and lane: more lenses find more, and cost more tokens.",
            "options": [{"label": x, "description": f"[{', '.join(hunt.lanes_for(cfg, x))}] {hunt.LENS_HELP.get(x, '')}".strip(),
                         "recommended": x in proposed} for x in names],
            "multiple": True}


def _triage_questions(open_: list[dict], grps: dict) -> list[dict]:
    """0.19.0 the triage's close as two questions: which finding (or group) and how it closes. A form sends
    payload.answers {finding, as} with choice close and a note; the old payload {id, as} still works."""
    opts, seen = [], set()
    for c in open_:
        key = c.get("group") or c["id"]
        if key in seen:
            continue
        seen.add(key)
        what = grps[key]["cause"] if key in grps else c["title"]
        opts.append({"label": key, "description": f"{c.get('severity')} · {c['kind']} · {what}"[:300], "recommended": not opts})
    if not opts:
        return []
    about = {"fixed": "the code is fixed (name the commit in the note)", "accepted": "the risk is known and accepted",
             "wontfix": "it will not be fixed (say why)"}
    return [{"id": "finding", "question": "Which finding (or group)?",
             "why": "close: the one to close. take: the one hunt-next hands over (default the top one).", "options": opts},
            {"id": "as", "question": "How does it close?", "why": "Only for close; the note says why.",
             "options": [{"label": d, "description": about.get(d, ""), "recommended": False}
                         for d in hunt.DISPOSITIONS]}]


# ------------------------------------------------------------------ start + lenses

async def hunt_start(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_start, a)


def _start(a: ActionInput) -> ActionResult:
    if _hunt(a).get("run") and hunt.get_run(a.key, _hunt(a)["run"]):
        return ActionResult(True, f"hunt {_hunt(a)['run']} is open")
    cfg = hunt.settings(a.root)
    kcfg = rules.load_config(a.root)
    opt = _options(a)
    mode = str(opt.get("mode") or "semi").lower()
    if mode not in MODES:
        return ActionResult(False, f"A hunt runs in auto or semi mode, not {mode}.", "settings.mode: auto | semi")
    fast = bool(opt.get("fast"))
    configured = list(cfg["lenses"])
    proposed = [x for x in cfg["fast_lenses"] if x in configured] if fast else configured
    if opt.get("lenses"):
        proposed = _lens_list(opt["lenses"])
        unknown = [x for x in proposed if not hunt.brief(a.root, x)]
        if unknown:
            return ActionResult(False, f"No brief for lens(es): {', '.join(unknown)}.",
                                f"Known lenses: {', '.join(configured)}. A project's own lens needs .keel/lenses/<name>.md.")
    scope_raw = str(opt.get("scope") or ("diff" if fast else cfg["default_scope"])).strip()
    scope = {"mode": scope_raw if scope_raw in ("all", "diff") else "paths",
             "paths": [] if scope_raw in ("all", "diff") else [p.strip() for p in scope_raw.split(",") if p.strip()],
             "base": va.base_ref(a.root, kcfg, a.base) if git.is_repo(a.root) else None}
    stack = {"api": _health(a, kcfg, "api_health_check"), "web": _health(a, kcfg, "web_health_check")}
    run = hunt.new_run(a.key, a.root, thread_id=a.thread_id, mode=mode, fast=fast, scope=scope, configured=configured,
                       proposed=proposed, stack=stack)
    info = {"run": run["run"], "mode": mode, "fast": fast, "scope": scope["mode"],
            "prove_concurrency": max(1, int(cfg["prove_concurrency"] or 4)), "report_dir": cfg["report_dir"],
            "map": "yes" if _wants_map(a.root, cfg) else "no"}
    hunters = len(hunt.sweep_pairs(cfg, proposed))
    data = _data(a, hunt=info, proposed_lenses=proposed, confirm_lenses_detail=_lens_detail(cfg, run, proposed),
                 confirm_lenses_questions=[_mode_question(mode, hunters), _lens_question(cfg, proposed)])
    return ActionResult(True, f"hunt {run['run']} started ({mode}{', fast' if fast else ''}), scope {scope['mode']}: "
                              f"{len(proposed)} lens(es) proposed", update={"data": data})


def _wants_map(root: str, cfg: dict) -> bool:
    """One explorer maps the repository before the sweep (hunt.map: auto = only when there is no knowledge base)."""
    how = str(cfg.get("map") or "auto").lower()
    if how in ("always", "yes", "true"):
        return True
    if how in ("never", "no", "false"):
        return False
    lay = layout.resolve(root)
    return not any((Path(root) / d).is_dir() and any((Path(root) / d).glob("*.md")) for d in lay.knowledge_dirs)


def _scope_text(a: ActionInput, run: dict) -> str:
    scope = run["scope"] or {}
    if scope.get("mode") == "paths":
        return "only these paths: " + ", ".join(scope.get("paths") or [])
    if scope.get("mode") == "diff":
        files = va.branch_files(a.root, scope.get("base")) if git.is_repo(a.root) else []
        if files:
            return f"the files changed since {scope.get('base') or 'the start'}: " + ", ".join(files[:60]) + \
                   (f" (+{len(files) - 60} more)" if len(files) > 60 else "")
        return "the branch diff (it is empty: look at the most recently changed code instead)"
    return "the whole project"


async def hunt_confirm(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_confirm, a)


def _confirm(a: ActionInput) -> ActionResult:
    info = _hunt(a)
    run = hunt.get_run(a.key, info.get("run"))
    if not run:
        return ActionResult(False, "No hunt run is open for this flow.")
    cfg = hunt.settings(a.root)
    proposed = list(a.data.get("proposed_lenses") or (run["lenses"] or {}).get("proposed") or [])
    answer = a.data.get("confirm_lenses_answer") or {}
    payload, why = answer.get("payload") or {}, str(answer.get("why") or "").lower()
    ticked = (payload.get("answers") or {}).get("lenses") if isinstance(payload.get("answers"), dict) else None
    chosen = _lens_list(payload.get("lenses")) if payload.get("lenses") else _lens_list(ticked) if ticked else None
    if chosen is None and why:
        named = [x for x in {*cfg["lenses"], *cfg["lens_lanes"]} if x in why]
        if named and any(w in why for w in ("drop", "without", "skip", "remove", "no ")):
            chosen = [x for x in proposed if x not in named]
        elif named:
            chosen = sorted(named, key=lambda x: (proposed + cfg["lenses"] + sorted(cfg["lens_lanes"])).index(x))
    confirmed = chosen if chosen is not None else proposed
    dropped = [x for x in confirmed if not hunt.brief(a.root, x)]
    confirmed = [x for x in confirmed if x not in dropped] or proposed
    # the run mode answered the gate (answer.auto): the lens set was not reviewed, and the report says so
    by = "model" if answer.get("auto") else "user"
    lenses = {**(run["lenses"] or {}), "confirmed": confirmed, "confirmed_by": by, "confirmed_at": hunt.db.now()}
    said = payload.get("answers") if isinstance(payload.get("answers"), dict) else {}
    mode = str(_one(said.get("mode")) or payload.get("mode") or run["mode"]).strip().split(" ")[0].lower()
    mode = mode if mode in MODES else run["mode"]
    changes: dict = {"lenses": lenses}
    if mode != run["mode"]:
        at = hunt.db.now()
        changes.update(mode=mode, gates={g: ({"decision": "approve", "by": "model", "at": at} if mode == "auto" else None)
                                         for g in hunt.GATES})
        info["mode"] = mode
    hunt.update_run(a.key, run["run"], **changes)
    cap = int(cfg["max_candidates_per_lens"])
    cap = max(1, -(-cap // 2)) if run["fast"] else cap
    scope = _scope_text(a, run)
    env = _env_fields(a.root)
    items = []
    for pair in hunt.sweep_pairs(cfg, confirmed):
        lens, lane = pair.split(":", 1)
        items.append({"id": pair, "lens": lens, "lane": lane, "run": run["run"], "scope": scope, "cap": cap,
                      "brief": hunt.brief(a.root, lens) or "", **env,
                      "rules": (f"Cite only files in the {lane} lane; a batch citing the other lane is thrown away whole. "
                                if lane != "both" else "This lens reads both sides on purpose. ")
                               + f"At most {cap} candidates. Never a severity. Write nothing into the project; scripts go "
                               "in your scratch folder. End with one ```json list and the line FINDINGS: <n>."})
    note = f"lenses confirmed by the {by}: {', '.join(confirmed)}; {len(items)} hunter(s); mode {mode}"
    if dropped:
        note += f"; no brief for {', '.join(dropped)}, left out"
    return ActionResult(True, note, update={"data": _data(a, hunt=info, sweep_items=items, confirm_lenses_answer=None)})


async def hunt_map(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_map, a)


def _map(a: ActionInput) -> ActionResult:
    """The explorer's map (the agent step before this one) goes into every sweep item: one map shared by every hunter
    instead of each one reading the tree again (keel v1 hunt: "six hunters sharing one map")."""
    text = str(a.state.get("last_answer") or "").strip()
    if not text:
        return ActionResult(True, "the explorer wrote no map; the hunters map what they need themselves")
    text = text[:6000]
    items = [{**x, "map": text} for x in a.data.get("sweep_items") or []]
    return ActionResult(True, f"repository map ({len(text)} characters) given to {len(items)} hunter(s)",
                        update={"data": _data(a, sweep_items=items, hunt_map=text)})


async def hunt_deps(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_deps, a)


def _deps(a: ActionInput) -> ActionResult:
    """The security lens starts from the dependency audit's output (the dependency-triager needs scanner output, not
    prose). Run every time: a whole-project hunt rarely has a changed manifest."""
    items = [dict(x) for x in a.data.get("sweep_items") or []]
    if not any(x.get("lens") == "security" for x in items):
        return ActionResult(True, "no security lens: the dependency audit is not needed")
    cfg = rules.load_config(a.root)
    cmds = cfg.get("commands") or {}
    audits = [(lane, str(cmds.get(f"deps_{lane}") or "").strip(), va._dir_of(cfg, d)) for lane, d in (("api", "backend"), ("web", "frontend"))]
    audits = [x for x in audits if x[1]]
    if not audits:
        scan = {"api": "not available: no audit command (commands.deps_api / deps_web in .keel/config.yml)"}
        va.record_verdict(a.key, "deps", None, {"reason": scan["api"], "by": "hunt"}, root=a.root if git.is_repo(a.root) else None)
        note = "dependency audit not available: no commands.deps_api / deps_web"
    elif a.fake:
        scan = {lane: "simulated: no audit ran" for lane, _c, _d in audits}
        note = "dependency audit simulated"
    else:
        scan, ran, failed = {}, [], []
        for lane, cmd, d in audits:
            cwd, _ = va._cwd(a.root, d)
            code, out = va._run(a.root, cmd, cwd, 600)
            ran.append({"lane": lane, "command": cmd, "code": code})
            scan[lane] = f"$ {cmd} (exit {code})\n{va._tail(out, 2500)}"
            if code != 0:
                failed.append(lane)
        va.record_verdict(a.key, "deps", not failed, {"audits": ran, "by": "hunt", "summary": "audit passed" if not failed
                                                      else f"{failed[0]} audit failed"}, root=a.root)
        note = f"dependency audit: {len(ran)} ran" + (f", {', '.join(failed)} reported problems" if failed else ", clean")
    for x in items:
        if x.get("lens") == "security":
            x["dependency_scan"] = scan.get(x.get("lane")) or "; ".join(f"{k}: {v}" for k, v in scan.items())
    return ActionResult(True, note, update={"data": _data(a, sweep_items=items)})


# ------------------------------------------------------------------ sweep -> candidates

async def hunt_ingest(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_ingest, a)


def _ingest(a: ActionInput) -> ActionResult:
    info = _hunt(a)
    run = hunt.get_run(a.key, info.get("run"))
    if not run:
        return ActionResult(False, "No hunt run is open for this flow.")
    by_pair: dict[str, list[dict]] = {}
    for c in a.data.get("candidates") or []:
        if c.get("from_item"):
            by_pair.setdefault(c["from_item"], []).append({k: v for k, v in c.items() if k not in ("id", "from_item")})
    said = {r["item"]: (r.get("markers") or {}).get("FINDINGS") for r in a.data.get("sweep_results") or []}
    lines, added, merged, refused, dropped = [], 0, 0, 0, 0
    for item in a.data.get("sweep_items") or []:
        pair = item["id"]
        got = by_pair.get(pair, [])
        n_said = str(said.get(pair) or "").split()[0] if said.get(pair) else ""
        if not got and n_said.isdigit() and int(n_said) > 0:
            swept = dict(hunt.get_run(a.key, run["run"])["swept"] or {})
            swept[pair] = {"at": hunt.db.now(), "count": 0, "refused": f"said FINDINGS: {n_said} but gave no JSON list"}
            hunt.update_run(a.key, run["run"], swept=swept)
            lines.append(f"{pair}: refused, said {n_said} finding(s) but gave no JSON list")
            refused += 1
            continue
        r = hunt.ingest(a.key, a.root, run["run"], pair, got)
        if r["refused"]:
            refused += 1
            lines.append(f"{pair}: refused whole: {r['refused']}")
            continue
        added += len(r["added"])
        merged += len(r["merged"])
        dropped += r["dropped_severity"]
        lines.append(f"{pair}: {len(r['added'])} new" + (f", merged into {', '.join(r['merged'])}" if r["merged"] else ""))
    page = hunt.write_candidates_page(a.key, a.root, run["run"])
    cfg = hunt.settings(a.root)
    waiting = [c for c in hunt.candidates(a.key, run["run"]) if c["status"] == "candidate"]
    env = _env_fields(a.root)
    items = [{**hunt.prove_item(c, run["run"], cfg["report_dir"]), **env} for c in waiting]
    note = f"{added} candidate(s), {merged} merged as corroboration" + (f", {refused} batch(es) refused" if refused else "")
    if dropped:
        note += f"; dropped a hunter's severity on {dropped}: only a prover's verdict sets one"
    detail = "\n".join([f"Hunt {run['run']}: the sweep proposed {len(waiting)} candidate(s). Nothing is verified yet.",
                        f"Read {page} to decide whether to spend the provers on them.", "", *lines, "",
                        "prove: one prover per candidate, with the symptom only. stop: end here; the backlog keeps them."])
    return ActionResult(True, note + f"; {page}", "\n".join(lines),
                        {"data": _data(a, prove_items=items, prove_round=0, sweep_gate_detail=detail)})


# ------------------------------------------------------------------ the stack, before the provers

async def hunt_stack(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_stack, a)


def _stack(a: ActionInput) -> ActionResult:
    """keel v1 hunt "keel stack up" before the provers: with the stack down every candidate comes back unproven after
    the rounds, the tokens are spent and the report looks wrongly thin. A health check that fails starts
    commands.services once and checks again; still down -> data.hunt.stack_down, and the stack gate asks."""
    info = _hunt(a)
    kcfg = rules.load_config(a.root)
    stack = {"api": _health(a, kcfg, "api_health_check"), "web": _health(a, kcfg, "web_health_check")}
    started = ""
    up = str((kcfg.get("commands") or {}).get("services") or "").strip()
    if _down(stack) and up and not a.fake:
        code, out = testcmd.run(a.root, up, 600, command_env())
        started = f"started the services ($ {up}, exit {code})"
        stack = {"api": _health(a, kcfg, "api_health_check"), "web": _health(a, kcfg, "web_health_check")}
    down = _down(stack)
    info["stack_down"] = ", ".join(down) or None
    note = f"stack before the provers: {_stack_line(stack)}" + (f"; {started}" if started else "")
    detail = None
    if down:
        cmds = kcfg.get("commands") or {}
        detail = "\n".join([
            f"The {' and '.join(down)} does not answer its health check ({', '.join(str(cmds.get(f'{x}_health_check')) for x in down)}).",
            f"Stack now: {_stack_line(stack)}." + (f" keel {started}." if started else
                                                  " No commands.services in .keel/config.yml to start it with."),
            "", "Every prover works against the running stack. With it down each candidate comes back unproven after "
            f"{hunt.settings(a.root).get('prove_rounds') or 3} rounds: the tokens are spent and the report looks thinner than it is.",
            "", "recheck: start it yourself, then keel checks again. prove: prove anyway (for findings that need no "
            "running stack). stop: end here; the backlog keeps the candidates."])
    return ActionResult(True, note, update={"data": _data(a, hunt=info, stack_gate_detail=detail)})


# ------------------------------------------------------------------ prove -> verdicts

async def hunt_verdicts(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_verdicts, a)


def _verdict_of(a: ActionInput, cid: str) -> dict | None:
    got = [v for v in a.data.get("verdicts") or [] if v.get("from_item") == cid or str(v.get("id") or "").upper() == cid]
    if got:
        return got[-1]
    # No JSON: an unproven or false verdict may still be read from the PROOF marker, with the answer as the evidence.
    for r in a.data.get("prove_results") or []:
        if r.get("item") == cid:
            word = ((r.get("markers") or {}).get("PROOF") or "").split()[0:1]
            if word and word[0].lower() in ("unproven", "false", "proven"):
                return {"verdict": word[0].lower(), "evidence": (r.get("text") or "").strip()[:3000]}
    return None


def _verdicts(a: ActionInput) -> ActionResult:
    info = _hunt(a)
    run = hunt.get_run(a.key, info.get("run"))
    if not run:
        return ActionResult(False, "No hunt run is open for this flow.")
    cfg = hunt.settings(a.root)
    rounds = int(a.data.get("prove_round") or 0) + 1
    force = rounds >= int(cfg.get("prove_rounds") or 3)
    refusals = []
    for item in a.data.get("prove_items") or []:
        v = _verdict_of(a, item["id"])
        why = hunt.record_verdict(a.key, a.root, run["run"], item["id"], v, force=force) if v else \
            f"{item['id']}: no verdict came back (end with a ```json list holding one verdict, and PROOF: <verdict>)"
        if why and force and not v:
            hunt.record_verdict(a.key, a.root, run["run"], item["id"], {
                "verdict": "unproven", "evidence": f"No verdict after {rounds} rounds of proving; recorded as unproven."})
            why = None
        if why:
            refusals.append(why)
    cands = hunt.candidates(a.key, run["run"])
    left = [c for c in cands if c["status"] == "candidate"]
    c = hunt.counts(cands)
    if left:
        env = _env_fields(a.root)
        items = [{**hunt.prove_item(x, run["run"], cfg["report_dir"]), **env} for x in left]
        feedback = ("Your verdict was refused; prove again and fix this:\n" + "\n".join(f"- {r}" for r in refusals))[:3000]
        return ActionResult(True, f"round {rounds}: {len(left)} candidate(s) still have no verdict; back to the provers",
                            "\n".join(refusals), {"data": _data(a, prove_items=items, prove_round=rounds, verdicts=[]),
                                                  "markers": _marker(a, "LEFT", "some", "verdicts"), "feedback": feedback})
    proven = [x for x in cands if x["status"] == "proven"]
    group_items = []
    if len(proven) >= 2:
        group_items = [{"id": "proven", "run": run["run"],
                        "instructions": ("These findings are proven. Find the ones that share ONE cause (the same defect "
                                         "showing up as different symptoms) by reading the code they cite. Answer with one "
                                         "```json list of groups: [{\"members\": [\"F-001\", \"F-004\"], \"lead\": \"F-001\", "
                                         "\"cause\": \"one sentence\"}]. A finding with a cause of its own needs no group; "
                                         "an empty list [] is a real answer. Change no file."),
                        "findings": [{"id": x["id"], "lens": x["lens"], "severity": x["severity"], "where": x["where"][:3],
                                      "symptom": x["symptom"][:240], "claim": (x.get("claim") or "")[:200]} for x in proven]}]
    detail = (f"Hunt {run['run']}: every candidate has a verdict: {c['proven']} proven, {c['unproven']} unproven, "
              f"{c['false']} false.\n\nreport: group shared causes and render the report. stop: end here.")
    return ActionResult(True, f"verdicts: {c['proven']} proven, {c['unproven']} unproven, {c['false']} false",
                        "\n".join(refusals), {"data": _data(a, prove_items=[], prove_round=rounds, verdicts=[],
                                                            group_items=group_items, verdicts_gate_detail=detail),
                                              "markers": _marker(a, "LEFT", "none", "verdicts")})


# ------------------------------------------------------------------ group + report + commit

async def hunt_group(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_group, a)


def _group(a: ActionInput) -> ActionResult:
    info = _hunt(a)
    run = hunt.get_run(a.key, info.get("run"))
    if not run:
        return ActionResult(False, "No hunt run is open for this flow.")
    made, skipped = [], []
    for g in a.data.get("groups") or []:
        members = g.get("members") or g.get("ids") or g.get("findings") or []
        gid, why = hunt.add_group(a.key, run["run"], members if isinstance(members, list) else [], str(g.get("cause") or ""),
                                  g.get("lead"))
        (made if gid else skipped).append(gid or f"{', '.join(map(str, members))}: {why}")
    note = f"{len(made)} group(s)" + (f": {', '.join(made)}" if made else "") + (f"; {len(skipped)} left out" if skipped else "")
    return ActionResult(True, note, "\n".join(skipped), {"data": _data(a, groups=[])})


def _triage_detail(a: ActionInput, run_id: str, extra: str = "") -> str:
    cands = hunt.candidates(a.key, run_id)
    open_ = sorted(hunt.open_findings(cands), key=lambda c: (-hunt.rank(c.get("severity")), c["id"]))
    run = hunt.get_run(a.key, run_id)
    lines = ([extra, ""] if extra else []) + [f"Hunt {run_id}: report {run.get('report') or 'not rendered'}.",
                                              f"{len(open_)} proven finding(s) open."]
    grps = {g["id"]: g for g in hunt.groups(a.key, run_id)}
    seen = set()
    for c in open_:
        key = c.get("group") or c["id"]
        if key in seen:
            continue
        seen.add(key)
        what = grps[key]["cause"] if key in grps else c["title"]
        lines.append(f"- {key} · {c.get('severity')} · {c['kind']} · {what}")
    lines += ["", "take: start hunt-next for the top group (a fix flow for a defect, a feature flow for unspecified).",
              "close: payload {id: F-001 or G-01, as: fixed | accepted | wontfix} (or the answers finding and as) and a "
              "note saying why.",
              "stop: end here; the backlog stays for hunt-next."]
    return "\n".join(lines)


def _triage_now(a: ActionInput, run_id: str) -> list[dict]:
    cands = hunt.candidates(a.key, run_id)
    open_ = sorted(hunt.open_findings(cands), key=lambda c: (-hunt.rank(c.get("severity")), c["id"]))
    return _triage_questions(open_, {g["id"]: g for g in hunt.groups(a.key, run_id)})


async def hunt_report(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_report, a)


def _report(a: ActionInput) -> ActionResult:
    info = _hunt(a)
    run = hunt.get_run(a.key, info.get("run"))
    if not run:
        return ActionResult(False, "No hunt run is open for this flow.")
    rel, note = hunt.write_report(a.key, a.root, run["run"])
    if not rel:
        return ActionResult(False, "The report refuses to render.", note)
    return ActionResult(True, note, update={"data": _data(a, triage_detail=_triage_detail(a, run["run"]),
                                                          triage_questions=_triage_now(a, run["run"]))})


async def hunt_commit(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_commit, a)


def _commit(a: ActionInput) -> ActionResult:
    """docs(HUNT-<run>): only the run's report folder is staged; whatever else is in the tree stays untouched."""
    run = hunt.get_run(a.key, _hunt(a).get("run"))
    if not run or not run.get("report"):
        return ActionResult(False, "No report to commit yet.")
    if not git.is_repo(a.root):
        return ActionResult(True, "Not a git repository; the report is not committed.")
    folder = str(Path(run["report"]).parent)
    git.git(a.root, "add", "--", folder)
    staged = [f for f in git.git(a.root, "diff", "--cached", "--name-only", "--", folder).stdout.splitlines() if f.strip()]
    if not staged:
        return ActionResult(True, "The report is already committed.")
    found = checks.secrets_in_diff(git.git(a.root, "diff", "--cached", "-U0", "--", folder).stdout)
    if found:
        git.git(a.root, "reset", "-q", "--", folder)
        return ActionResult(False, "The hunt report holds what looks like a secret; not committed.",
                            "\n".join(f"  {f['file']}: {f['why']}" for f in found))
    c = hunt.counts(hunt.candidates(a.key, run["run"]))
    cfg = rules.load_config(a.root)
    msg = f"docs(HUNT-{run['run']}): bug hunt: {c['proven']} proven, {c['unproven']} suspected"
    ident, trailer = commit_args(a.root, a.settings, cfg)
    r = git.git(a.root, *ident, "commit", "-q", "-m", msg, *trailer, "--", folder)
    if r.returncode != 0:
        git.git(a.root, "reset", "-q", "--", folder)
        return ActionResult(False, "git commit failed.", (r.stderr or r.stdout)[-2000:])
    sha = git.head(a.root)
    return ActionResult(True, f"{msg} {(sha or '')[:7]}".strip(), "\n".join(staged), {"git_head": sha})


# ------------------------------------------------------------------ close + take

def _one(v):
    """A single-pick answer: a label, or the first of a list."""
    return (v[0] if v else None) if isinstance(v, list) else v


async def hunt_close(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_close, a)


def _close(a: ActionInput) -> ActionResult:
    """From the answer of the hunt's triage (choice close, payload {id, as}, or the answers finding and as). The note is
    the answer's text (or payload.note) and is required."""
    for key in ("triage_answer",):
        ans = a.data.get(key) or {}
        choice = ans.get("choice")
        if choice in hunt.DISPOSITIONS or choice == "close":
            break
    else:
        return ActionResult(True, "nothing to close")
    payload = ans.get("payload") or {}
    said = payload.get("answers") if isinstance(payload.get("answers"), dict) else {}
    picked = str(_one(said.get("finding")) or "").split(" ")[0] or None        # the option label starts with its id
    as_ = choice if choice in hunt.DISPOSITIONS else payload.get("as") or _one(said.get("as"))
    nxt = (a.data.get("next") or {}).get("hunt") or {}
    target = payload.get("id") or picked or nxt.get("group") or nxt.get("lead")
    seed = a.data.get("seed") if isinstance(a.data.get("seed"), dict) else {}
    run_id = payload.get("run") or nxt.get("run") or _hunt(a).get("run") or seed.get("run")
    note = str(ans.get("why") or payload.get("note") or "").strip()
    ok, msg = hunt.close(a.key, run_id, str(target or ""), as_, note, git.head(a.root) if git.is_repo(a.root) else None)
    if not ok:
        return ActionResult(False, msg, msg)
    upd = {key: None}
    run = hunt.get_run(a.key, run_id)
    if key == "triage_answer" and run:
        upd["triage_detail"] = _triage_detail(a, run["run"], msg)
        upd["triage_questions"] = _triage_now(a, run["run"])
    return ActionResult(True, msg, update={"data": _data(a, **upd)})


def _next_run(a: ActionInput) -> str | None:
    seed = a.data.get("seed") if isinstance(a.data.get("seed"), dict) else {}
    return a.settings.get("hunt_run") or a.settings.get("run") or seed.get("run")


def _picked(a: ActionInput) -> str | None:
    """The finding or group to take: the preview gate's answer (payload.id, or the finding question), else the one the
    hunt's triage named (seed.pick), else None (the top one)."""
    ans = a.data.get("next_gate_answer") or {}
    payload = ans.get("payload") or {}
    said = payload.get("answers") if isinstance(payload.get("answers"), dict) else {}
    seed = a.data.get("seed") if isinstance(a.data.get("seed"), dict) else {}
    got = payload.get("id") or _one(said.get("finding")) or _one(seed.get("pick"))
    return str(got).strip().split(" ")[0] if got else None


def _next_question(open_: list[dict], grps: dict) -> dict | None:
    opts, seen = [], set()
    for c in open_:
        key = c.get("group") or c["id"]
        if key in seen:
            continue
        seen.add(key)
        what = c["symptom"] if key not in grps else f"{c['symptom']} (+ the other symptoms of {key})"
        opts.append({"label": key, "description": f"{c.get('severity')} · {c['kind']} · {' '.join(str(what).split())}"[:300],
                     "recommended": not opts})
    if not opts:
        return None
    return {"id": "finding", "question": "Which finding (or group) should go to a fix or feature flow?",
            "why": "The top one is the worst severity; pick another to take it first.", "options": opts}


async def hunt_preview(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_preview, a)


def _preview(a: ActionInput) -> ActionResult:
    """hunt-next's preview (keel v1 hunt-next shows the top group, then --take): what take would hand over, its severity
    and a stale verdict, for the next gate. Nothing is marked. Not asked when there is nothing to take, when take will
    refuse (it says why itself) or when the hunt's triage already chose (seed.preview no)."""
    seed = a.data.get("seed") if isinstance(a.data.get("seed"), dict) else {}
    r = hunt.peek(a.key, a.root, _next_run(a), _one(seed.get("pick")))
    if not r["ok"] or not r.get("flow") or str(seed.get("preview", "")).lower() in ("no", "false"):
        return ActionResult(True, "no preview: " + (r.get("note") or r.get("why") or "the hunt's triage chose already"),
                            update={"data": _data(a, next_preview={"ask": "no"})})
    s = r["seed"]
    run = r["run"]
    grps = {g["id"]: g for g in hunt.groups(a.key, run)}
    open_ = sorted(hunt.open_findings(hunt.candidates(a.key, run)), key=lambda c: (-hunt.rank(c.get("severity")), c["id"]))
    key = r["group"] or r["lead"]
    lines = [f"Next from hunt {run}: {key} · {r['severity']} · {r['flow']} flow · {len(r['members'])} finding(s)", "",
             "Symptoms (each one becomes a regression criterion):", *[f"- {x}" for x in s["symptoms"]]]
    if r["group"]:
        lines += ["", f"The investigator's suspected cause (a theory; the reproducer never sees it): {grps[r['group']]['cause']}"]
    if s.get("recipe"):
        lines += ["", f"Recipe: {s['recipe'].splitlines()[0]}"]
    if r.get("stale"):
        lines += ["", "STALE: " + hunt._stale_note(r["stale"])]
    others = [c.get("group") or c["id"] for c in open_ if (c.get("group") or c["id"]) != key]
    if others:
        lines += ["", f"Also open: {', '.join(dict.fromkeys(others))}."]
    lines += ["", "take: hand this one over. pick: take the one you choose in the question instead. stop: end here; "
              "nothing is handed over."]
    q = _next_question(open_, grps)
    return ActionResult(True, f"next: {key} ({r['severity']}) -> {r['flow']}" + (" · stale" if r.get("stale") else ""),
                        update={"data": _data(a, next_preview={"ask": "yes", "key": key},
                                              next_gate_detail="\n".join(lines), next_gate_questions=[q] if q else [])})


async def hunt_take(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_take, a)


def _take(a: ActionInput) -> ActionResult:
    r = hunt.take(a.key, a.root, _next_run(a), _picked(a))
    if not r["ok"]:
        return ActionResult(False, "hunt-next refuses: " + r["why"], r["why"])
    if not r.get("flow"):
        return ActionResult(True, r["note"], update={"markers": _marker(a, "FLOW", "none", "take")})
    s = r["seed"]
    return ActionResult(True, r["note"], json.dumps(s, indent=2)[:3000],
                        {"data": _data(a, next=s, stale=r.get("stale"), next_gate_answer=None),
                         "markers": _marker(a, "FLOW", r["flow"], "take")})


ACTIONS = {
    "hunt_start": hunt_start, "hunt_confirm": hunt_confirm, "hunt_deps": hunt_deps, "hunt_ingest": hunt_ingest,
    "hunt_verdicts": hunt_verdicts, "hunt_group": hunt_group, "hunt_report": hunt_report, "hunt_commit": hunt_commit,
    "hunt_close": hunt_close, "hunt_take": hunt_take, "hunt_map": hunt_map, "hunt_stack": hunt_stack,
    "hunt_preview": hunt_preview,
}
