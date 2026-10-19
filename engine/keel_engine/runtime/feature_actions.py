"""Code actions of the feature flow (content/workflows/feature.yaml; keel v1 skills/feature and its references).

    preflight          the tree and the test command are ready; the flow gets its own branch (never the base branch)
    explore_areas      once the criteria are settled: one explorer item per area (api, web, data)
    spec_sync          the spec's criteria (added, edited, removed; the plan's ORDER applied) and the spec gate's text
    spec_freeze        approved: frontmatter status frozen, approved and frozen today; the spec is committed alone
    spec_restart       the spec gate's reject: the interview starts again (criteria handed over by another flow stay)
    amend_start        why the frozen spec needs an amendment: an agent's AMEND line, or the contract gate's note
    spec_amendment     the amendment gate's text: the dated block, why, and the criteria it touches (finished ones too)
    spec_amend_commit  approved: new criteria join, the ones it names (REOPEN) are open again, the spec is committed alone
    show_diff          what the next gate shows: keel's uncommitted change (the contract), else the branch diff
    security_scope     the security fan-out: the auditor always, the dependency triager when verify deps found something
    e2e_scope          the spec's [E2E] criteria (or a hunt's needs_e2e) and whether commands.e2e is set
    e2e_unrun          no e2e tool: the specs are written but not run; recorded for the final review and the PR body
    verify_e2e         runs commands.e2e (a failure runs once more: flaky), unless the specs are not to be run
    smoke_scope        the spec's [SMOKE] criteria or its Smoke checks section
    verify_smoke       runs smoke/*.sh and commands.smoke_e2e
    close_flow         the closing line: criteria done, ADRs written

The step ids these actions read are the feature workflow's: the plan's ORDER marker (any step), the dependency check's
output (data.security_deps_output) and the spec review (step spec_review_sync shows the reviewer's answer).
"""

from __future__ import annotations

import datetime
import re
from dataclasses import replace
from pathlib import Path

from .. import layout, rules
from ..tools import git, testcmd
from ..tools.agent_tools import command_env
from . import prompts, spec_check, stacks, verdict_actions
from . import flow_actions
from . import choices as choices_mod
from .flow_actions import _fail, _markers, _ok

DONE = ("done", "already-met")
AC_ID = re.compile(r"[A-Z][A-Z0-9]*-[\w.]+")
DEPS_STEP = "security_deps"          # the soft verify_deps step whose output the triager reads
LAYER_LINE = r"\b([A-Z][A-Z0-9]*-[\w.]+)\**\s*\[{layer}\]\s*(.+)"


def _today() -> str:
    return datetime.date.today().isoformat()


def _slug(text: str, n: int = 40) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")[:n].strip("-") or "feature"


def _read(root: str, rel: str | None) -> str:
    return spec_check.read_spec(root, rel)


def _gates(a) -> dict:
    g = dict(a.state.get("gates") or {"mode": "every-ac", "log": [], "skipped": {}})
    g["log"] = list(g.get("log") or [])
    g["skipped"] = dict(g.get("skipped") or {})
    return g


def spec_path(a) -> str | None:
    """The flow's spec: the one the state knows, else a changed .md with "spec" in its path, else the specs folder's
    file named after the title."""
    root = Path(a.root)
    known = a.state.get("spec")
    if known and (root / known).is_file():
        return known
    if git.is_repo(a.root):
        found = [f for f in git.dirty(a.root) if f.endswith(".md") and "spec" in f.lower() and (root / f).is_file()]
        if found:
            return max(found, key=lambda f: (root / f).stat().st_mtime)
    # every spec folder of the project's layout (keel_engine/layout.py), its own first: a mixed project has two
    for d in layout.resolve(a.root).spec_dirs:
        if (root / d).is_dir():
            mine = [p for p in (root / d).glob("*.md") if _slug(a.title, 30) in p.stem]
            if mine:
                return str(max(mine, key=lambda p: p.stat().st_mtime).relative_to(root))
    return None


def merge_acs(have: list[dict], parsed: list[dict], drop: bool) -> list[dict]:
    """The criteria after the spec changed: the spec's list in its order (title and layer from the spec, status kept),
    then the ones the spec does not list. With `drop`, an unfinished AC-<n> the spec no longer lists is gone (the user
    removed it); criteria with other ids (CHG-1.2, handed over by a change flow) and finished ones always stay."""
    if not parsed:
        return [dict(x) for x in have]
    by = {x["id"]: x for x in have}
    out = [{**by[p["id"]], "layer": p["layer"], "title": p["title"]} if p["id"] in by else dict(p, status="todo")
           for p in parsed]
    listed = {p["id"] for p in parsed}
    for x in have:
        if x["id"] in listed:
            continue
        if drop and x.get("status") not in DONE and re.fullmatch(r"AC-\d+", x["id"]):
            continue
        out.append(dict(x))
    return out


# The build order a spec states: a line "ORDER: AC-6, AC-2, ..." (plain, **bold**, in a list), usually in its Plan.
ORDER_LINE = re.compile(r"(?mi)^[ \t]*(?:[-*>][ \t]*)?(?:\*\*|__)?order(?:\*\*|__)?[ \t]*:[ \t]*(?:\*\*|__)?(.+)$")


def spec_order(text: str | None) -> str | None:
    """The spec's own ORDER line (the last one that names criteria; an amendment may restate it), else None."""
    found = None
    for m in ORDER_LINE.finditer(str(text or "")):
        if AC_ID.search(m.group(1).upper()):
            found = m.group(1).strip()
    return found


# "- **AC-1** depends on: AC-3, AC-7" / "AC-001 (depends on AC-002)" / "AC-1: after AC-3" / "AC-1 needs AC-3 first"
DEPENDS_LINE = re.compile(r"(?mi)^[ \t]*(?:[-*>][ \t]*)?(?:\*\*|__)?([A-Z][A-Z0-9]*-[\w.]+?)(?:\*\*|__)?\b[^\n]*?"
                          r"\b(?:depends[ _]on|after|needs)\b[ \t:]*([^\n]*)$")


def spec_depends(text: str | None) -> dict[str, list[str]]:
    """{criterion: the criteria it depends on} from the spec's lines (usually its Plan); "none" and unknown words drop."""
    out: dict[str, list[str]] = {}
    for m in DEPENDS_LINE.finditer(str(text or "")):
        ac = m.group(1).upper()
        deps = [d for d in dict.fromkeys(AC_ID.findall(m.group(2).upper())) if d != ac]
        if deps:
            out[ac] = list(dict.fromkeys(out.get(ac, []) + deps))
    return out


def with_depends(acs: list[dict], text: str | None) -> list[dict]:
    """The criteria with `depends_on` from the spec (kept as it was for a criterion the spec says nothing about)."""
    deps = spec_depends(text)
    return [dict(x, depends_on=deps[x["id"].upper()]) if x["id"].upper() in deps else dict(x) for x in acs]


def build_order(a, text: str | None) -> tuple[str | None, str]:
    """(the order, where it came from): the spec's ORDER line wins (the person reads and may edit it at the gate),
    else the plan agent's ORDER marker, else none (id order)."""
    said = spec_order(text)
    if said:
        return said, "spec"
    marker = ((a.state.get("markers") or {}).get("*") or {}).get("ORDER")
    return (marker, "plan") if marker else (None, "id")


def order_acs(acs: list[dict], order: str | None) -> list[dict]:
    """The plan's build order (ORDER: AC-2, AC-1, ...): the ids it names first, in that order, then the rest."""
    ids = [i.upper() for i in AC_ID.findall(str(order or "").upper())]
    first = [next(x for x in acs if x["id"].upper() == i) for i in dict.fromkeys(ids) if any(x["id"].upper() == i for x in acs)]
    return first + [x for x in acs if x not in first]


def _section(text: str, *names: str) -> str:
    sec = spec_check.sections(text)
    return next((v for k, v in sec.items() if any(k.startswith(n) for n in names)), "")


def _criteria_lines(acs: list[dict]) -> list[str]:
    return [f"- {x['id']} [{x.get('layer', 'API')}] {x.get('title', '')}" + (f" ({x['status']})" if x.get("status") in DONE else "")
            + (f" · after {', '.join(x['depends_on'])}" if x.get("depends_on") else "") for x in acs]


# ------------------------------------------------------------------ preflight

def preflight(a):
    """keel v1 `keel preflight`: the tree is a git repository with a test command, and the flow works on its own
    branch. On the base branch (base_branch, main or master) it creates feat/<slug> (settings.branch_pattern; the api
    usually made it already); on any other branch it stays, so the commits of a flow that handed over stay too.
    data.no_gates waives the optional gates (integration, e2e, smoke); the spec and criteria gates are never waived."""
    notes, update = [], {}
    gates = _gates(a)
    if a.data.get("no_gates"):
        for phase in ("integration", "e2e", "smoke"):
            gates["skipped"][phase] = "gates waived (no_gates option)"
        gates["log"].append("optional gates waived: no_gates option")
        update["gates"] = gates
        notes.append("integration, e2e and smoke gates waived")
    if not git.is_repo(a.root):
        return _ok("; ".join(["Not a git repository: no branch of its own", *notes]), update=update)
    if not a.fake and not testcmd.command_for(a.root, None, "API"):
        return _fail("Not ready: no test command found.",
                     "Add commands (api_test_ac, api_test_module) to .keel/config.yml, or run the init flow first.")
    cfg = rules.load_config(a.root)
    cur = git.branch(a.root) or ""
    bases = {b for b in (cfg.get("base_branch"), "main", "master") if b}
    if cur in bases and a.settings.get("own_branch", True) is not False:
        first = str(a.settings.get("branch_pattern") or "feat/{slug}").replace("{slug}", _slug(a.title)).replace("{flow}", "feature")
        name, n = first, 2
        while git.git(a.root, "rev-parse", "--verify", "--quiet", f"refs/heads/{name}").returncode == 0:
            name, n = f"{first}-{n}", n + 1
        r = git.git(a.root, "checkout", "-q", "-b", name)
        if r.returncode != 0:
            return _fail(f"Could not create the branch {name}.", (r.stderr or r.stdout)[-1500:])
        update["branch"] = name
        notes.append(f"own branch {name} (from {cur})")
    else:
        notes.append(f"on branch {cur}" + (" (handed over: its commits stay)" if a.state.get("parent") else ""))
    if a.preexisting:
        notes.append(f"{len(a.preexisting)} file(s) of yours were already changed; they stay out of keel's commits")
    if a.acs:
        done = sum(1 for x in a.acs if x.get("status") in DONE)
        notes.append(f"{len(a.acs)} criteria handed over ({done} done): no interview")
    return _ok("ready: " + "; ".join(notes), update=update)


# ------------------------------------------------------------------ the spec and the plan

def explore_areas(a):
    """One explorer per area once the criteria are settled (keel v1: criteria first, explorers second): api for [API]
    criteria (or when there is no [WEB] one), web for [WEB] ones, data always. Each item names its criteria."""
    open_ = [x for x in a.acs if x.get("status") not in DONE] or list(a.acs)
    lines = {layer: [f"{x['id']} [{x.get('layer', 'API')}] {x.get('title', '')}" for x in open_
                     if str(x.get("layer") or "API").upper() == layer] for layer in ("API", "WEB", "E2E", "SMOKE")}
    every = lines["API"] + lines["WEB"]
    # [E2E] and [SMOKE] criteria get no explorer of their own (their tests come after integration): the frontend's
    # explorer maps where they would live, else the server side's
    journeys = lines["E2E"] + lines["SMOKE"]
    items = []
    if lines["API"] or not lines["WEB"]:
        items.append({"id": "api", "title": "api: the server side", "area": "api",
                      "criteria": (lines["API"] or every) + ([] if lines["WEB"] else journeys)})
    if lines["WEB"]:
        items.append({"id": "web", "title": "web: the frontend", "area": "web", "criteria": lines["WEB"] + journeys})
    items.append({"id": "data", "title": "data: tables, migrations and data shape", "area": "data", "criteria": every or journeys})
    return _ok("explorers for " + ", ".join(i["id"] for i in items), update={"data": {**a.data, "explore_areas": items}})


NO_WEB_NOTE = "keel tagged these [API]: this project has no separate web tests"


def api_only(a, spec: str | None, text: str) -> tuple[str, list[str]]:
    """0.18.12 a project without a web layer (stacks.has_web_layer) tests its pages with backend tests, which the guard
    puts in the api lane; a [WEB] criterion there can never get its test past red. Its [WEB] criteria lines become [API]
    in the spec (written back, so the spec, state.acs and the guard agree) and the ids are returned."""
    web = [x["id"] for x in prompts.parse_acs(text) if x["layer"] == "WEB"]
    if not web or stacks.has_web_layer(a.root):
        return text, []
    for ac in web:
        text = rewrite_criterion(text, ac, "API")
    if spec:
        (Path(a.root) / spec).write_text(text)
    return text, web


def spec_sync(a):
    """The criteria as the spec now lists them, in the plan's order, and what the spec gate shows."""
    spec = spec_path(a)
    text, retagged = api_only(a, spec, _read(a.root, spec))
    retagged = list(dict.fromkeys([*(a.data.get("web_to_api") or []), *retagged]))      # the compiler's, then the spec's
    seeded = bool((a.data.get("seed") or {}).get("acs"))
    acs = merge_acs(a.acs, prompts.parse_acs(text), drop=not seeded)
    order, source = build_order(a, text)
    acs = with_depends(order_acs(acs, order), text)
    said = {"spec": "the spec's ORDER line", "plan": "the plan's ORDER", "id": "criteria ids (no ORDER given)"}[source]
    lines = [f"Spec: {spec or '(no spec file found)'}", "", f"Criteria, in build order (from {said}):", *_criteria_lines(acs)]
    retagged = [i for i in retagged if any(x["id"] == i and x.get("layer") == "API" for x in acs)]
    if retagged:
        lines += ["", f"{NO_WEB_NOTE} (its pages are tested by backend tests): {', '.join(retagged)}"]
    plan = _section(text, "plan")
    if plan:
        lines += ["", "Plan (files per criterion, contract delta, test layer):", plan[:2500]]
    lines += ["", spec_check.describe(spec_check.check(text, acs))]
    answer = a.data.get("spec_gate_answer") or {}
    if a.step.startswith("spec_review") and answer.get("choice") == "review" and (a.state.get("last_answer") or "").strip():
        lines += ["", "Spec review (you asked for it), word for word:", a.state["last_answer"].strip()[:6000]]
    lines += ["", "Choose one (approve with payload {\"choice\": \"<name>\"} and a note):",
              "- approve: freeze the spec (status frozen, approved and frozen today), commit it, go to the contract",
              "- edit: change the criteria your note names, then come back here",
              "- rewrite: rewrite the section your note names (goal, validation, auth, edge cases, out of scope)",
              "- review: an adversarial read first (vague, untestable or overlapping criteria), shown here",
              "- order: the criteria are right but the plan under them is not: the plan is written again",
              "- reject: the spec misses the intent: the interview starts again with what was missing"]
    contract = contract_needed(a, text)
    if contract == "no":
        lines.insert(1, "Contract: the plan says the contract delta is none, so the contract step and its gate are skipped.")
    upd = {"acs": acs, "show": "\n".join(lines),
           "data": {**a.data, "ac_order": {"ids": [x["id"] for x in acs], "from": source}, "contract": contract}}
    if spec:
        upd["spec"] = spec
    return _ok(f"spec {spec or 'not found'}: {len(acs)} criteria" + (f", order {', '.join(x['id'] for x in acs)} (from {said})"
                                                                       if order else ""), update=upd)


NO_CONTRACT = re.compile(r"(?im)^[^\n]*\bcontract(?:\s+delta|\s+change[s]?)?\b\W{0,6}[:\-\u2013\u2014]\W{0,4}"
                         r"(?:none|no change[s]?|n/?a|nothing)\b")


def contract_needed(a, text: str | None) -> str:
    """v0.17.5 "no" when the plan says there is no contract delta (its CONTRACT-DELTA: none line, or "Contract delta: none" in
    the spec's Plan); then the contract step and its gate are skipped. Anything else: "yes"."""
    said = str(((a.state.get("markers") or {}).get("plan") or {}).get("CONTRACT-DELTA") or "").strip().lower()
    if said:
        return "no" if said.startswith(("no", "none")) else "yes"
    return "no" if NO_CONTRACT.search(str(text or "")) else "yes"


def _frontmatter(text: str, values: dict) -> str:
    """Set these keys in the spec's front matter (added when the spec has none)."""
    m = re.match(r"\A---\n(.*?)\n---\n?", text, re.S)
    lines = m.group(1).splitlines() if m else []
    for k, v in values.items():
        row = f"{k}: {v}"
        at = next((n for n, line in enumerate(lines) if re.match(rf"^{re.escape(k)}\s*:", line)), None)
        if at is None:
            lines.append(row)
        else:
            lines[at] = row
    body = text[m.end():] if m else text
    return "---\n" + "\n".join(lines) + "\n---\n" + body.lstrip("\n")


def spec_freeze(a):
    """keel v1: on approval, status frozen and approved/frozen dated today, then `keel commit docs SPEC "spec and plan"`.
    Only the spec is committed (in a hidden layout, keel or external, it is recorded instead). From here the spec
    folders are refused in red, green and gate: a change is a dated amendment."""
    from .actions import commit

    spec = spec_path(a)
    if not spec:
        return _fail("There is no spec file to freeze.", f"Write the spec under {layout.resolve(a.root).specs}/ first.")
    f = Path(a.root) / spec
    day = _today()
    f.write_text(_frontmatter(f.read_text(errors="replace"), {"status": "frozen", "approved": day, "frozen": day}))
    r = commit(replace(a, phase="spec", title=f"spec and plan: {a.title}", paths=[spec]))
    if not r.ok:
        return r
    gates = _gates(a)
    gates["log"].append(f"spec frozen: {spec} ({len(a.acs)} criteria)")
    return _ok(f"spec frozen ({day}); {r.note}", update={**r.update, "spec": spec, "gates": gates,
                                                          "data": {**a.data, "spec_frozen": day}})


def spec_restart(a):
    """The spec gate's reject (keel v1: not a patch, a restart of the interview). Criteria handed over by another
    flow stay; the rest go, so the explorer may ask its questions again."""
    seeded = bool((a.data.get("seed") or {}).get("acs"))
    acs = list(a.acs) if seeded else [x for x in a.acs if x.get("status") in DONE]
    return _ok("the interview starts again" + (" (the handed-over criteria stay)" if seeded else ""),
               update={"acs": acs, "clarify": {}, "clarify_rounds": 0, "spec_revisions": 0})


# ------------------------------------------------------------------ amendments

def amend_start(a):
    """Why the frozen spec needs an amendment: the AMEND line of the agent that hit it (red, green), else the note of
    the contract gate ("this breaks a consumer"). The line is used once: it is cleared from the markers.

    v0.17.4 loop guard: the same criterion back with an AMEND after a round that changed nothing in the spec does not go
    to the explorer again; data.amend.route = "ask" sends it to the choice gate amend_loop (first / skip / edit / stop)."""
    mk = {k: dict(v) for k, v in (a.state.get("markers") or {}).items() if isinstance(v, dict)}
    said = [(k, v["AMEND"]) for k, v in mk.items() if k != "*" and v.get("AMEND")]
    ac = a.state.get("ac")
    if said:
        frm, text = said[-1]
        reason = f"{ac + ' · ' if ac else ''}{frm}: {text}"
    else:
        frm = "contract"
        why = ((a.data.get("contract_gate_answer") or {}).get("why") or "").strip()
        reason = f"contract gate: {why or 'the contract shows that the spec assumed something untrue'}"
    for v in mk.values():
        v.pop("AMEND", None)
    amend = {"from": frm, "ac": ac, "reason": reason[:2000], "at": _today(), "route": "amend"}
    rounds = [h for h in a.data.get("amend_history") or [] if ac and h.get("ac") == ac and "changed" in h]
    if rounds and rounds[-1]["changed"] is False:
        amend = {**amend, "route": "ask", "next": _next_for(a, ac, f"{reason} {rounds[-1].get('said', '')}")}
        without, note = _loop_choices(a, ac, amend["next"])
        data = {**a.data, "amend": amend, "amend_loop_without": without}
        return _ok(f"{ac} came back with an AMEND after an amendment that changed nothing: asking you, not looping"[:300],
                   update={"markers": mk, "data": data, "show": _loop_text(a, amend, rounds[-1], without, note)})
    return _ok(f"spec amendment needed: {reason}"[:300], update={"markers": mk, "data": {**a.data, "amend": amend}})


# ------------------------------------------------------------------ the amendment loop guard (v0.17.4)

# An explorer that says the AMEND is about the order the criteria are built in, not about the spec.
# An explorer that found nothing to amend: "not a spec defect", "covered by AC-3", "no amendment needed".
NOT_A_DEFECT = re.compile(r"not a spec (defect|problem|issue|bug)|no (amendment|spec change)|already covered|covered by "
                          r"[A-Z]+-\d|out of scope|nothing to amend|spec is (right|correct)", re.I)
ORDER_TALK = re.compile(r"\border\b|\bsequenc|\bdepend|\bbefore\b|\bfirst\b|not a spec (defect|problem|issue)", re.I)


def _unfinished(a) -> list[str]:
    return [x["id"] for x in a.acs if x.get("status") not in DONE and x.get("status") != "green"]


def _named(a, text: str, ac: str) -> list[str]:
    """Unfinished criteria a text names, in build order (AC-006/002/007 counts as AC-006, AC-002, AC-007)."""
    t = str(text or "").upper()
    ids = set(AC_ID.findall(t))
    m = re.findall(r"\b([A-Z][A-Z0-9]*)-(\d+)((?:/\d+)+)", t)          # AC-006/002/007
    for prefix, first, rest in m:
        ids |= {f"{prefix}-{n}" for n in [first, *rest.strip("/").split("/")]}
    return [i for i in _unfinished(a) if i.upper() in ids and i != ac]


def _earlier_in_order(a, ac: str) -> list[str]:
    """Unfinished criteria the spec's ORDER lists before `ac`."""
    order = [i.upper() for i in AC_ID.findall(str(spec_order(_read(a.root, spec_path(a))) or "").upper())]
    if ac.upper() not in order:
        return []
    before = order[:order.index(ac.upper())]
    return [i for i in _unfinished(a) if i.upper() in before and i != ac]


def _next_for(a, ac: str, text: str) -> str | None:
    """The criterion to build before `ac`: one the AMEND names, else one ORDER puts first, else the next unfinished."""
    for ids in (_named(a, text, ac), _earlier_in_order(a, ac)):
        if ids:
            return ids[0]
    rest = [i for i in _unfinished(a) if i != ac]
    return rest[0] if rest else None


def move_before(acs: list[dict], ids: list[str], ac: str) -> list[dict]:
    moved = [x for i in ids for x in acs if x["id"] == i]
    rest = [x for x in acs if x["id"] not in ids]
    at = next((n for n, x in enumerate(rest) if x["id"] == ac), len(rest))
    return [dict(x) for x in rest[:at] + moved + rest[at:]]


def _title(a, ac: str | None) -> str:
    x = next((x for x in a.acs if x["id"] == ac), None)
    return f"{ac} ({x.get('title', '')})" if x and x.get("title") else str(ac)


LOOP_CHOICES = ("first", "skip", "edit", "stop")      # the amend_loop gate's, in content/workflows/feature.yaml


def _loop_choices(a, ac: str | None, nxt: str | None) -> tuple[list[str], str]:
    """The amend_loop choices left out this time (no `first` without a criterion to build first) and the limit note:
    0.18.12 past settings.sendback_limit rounds for the same criterion (first and edit count) only skip or stop."""
    without = [] if nxt else ["first"]
    tries, limit = flow_actions.stuck_tries(a.state, ac), flow_actions.sendback_limit(a.settings)
    if tries < limit:
        return without, ""
    keep = flow_actions.past_limit(list(LOOP_CHOICES), bool([i for i in _unfinished(a) if i != ac]))
    return [c for c in LOOP_CHOICES if c not in keep], flow_actions.limit_note(tries, limit, str(ac))


def _loop_text(a, amend: dict, last: dict | None, without=(), note: str = "") -> str:
    ac, nxt = amend.get("ac"), amend.get("next")
    lines = [f"{ac} came back with an AMEND, and the last amendment for it changed nothing in the spec.",
             "keel stops here instead of asking the same question again.", "", f"Why: {amend.get('reason') or 'not recorded'}"]
    if last and last.get("said"):
        lines += ["", "The amendment said:", str(last["said"])[:1500]]
    if note:
        lines += ["", note]
    lines += ["", "Choose one (approve with payload {\"choice\": \"<name>\"} and a note):"]
    if nxt:
        lines.append(f"- first: build {_title(a, nxt)} first, then {ac}")
    lines += [f"- skip: move {ac} to the end of the list and go on with the next criterion",
              "- edit: write the amendment again with your note (say what the spec should change)",
              "- stop: stop the flow here (the commits so far stay)"]
    return flow_actions.offered("\n".join(lines), [c for c in LOOP_CHOICES if c not in without])


def _history(a, **entry) -> list[dict]:
    return (list(a.data.get("amend_history") or []) + [{**entry, "at": _today()}])[-50:]


def _spec_changed(a, spec: str | None) -> bool:
    """Did this amendment round write anything into the spec? (Unknown: yes, so the gate shows it as before.)"""
    if not spec or not git.is_repo(a.root):
        return True
    return bool(git.git(a.root, "status", "--porcelain", "--", spec).stdout.strip())


def _no_change(a, spec: str | None, amend: dict):
    """The amendment round changed nothing. An order question with an unfinished criterion to build first: keel
    reorders and goes on (route "reorder"). Otherwise the choice gate (route "ask"). Never an approve-only gate."""
    ac = amend["ac"]
    said = str(a.state.get("last_answer") or "").strip()
    reopen = str(((a.state.get("markers") or {}).get("*") or {}).get("REOPEN") or "")
    text = f"{amend.get('reason', '')} {said} {reopen}"
    hist = _history(a, ac=ac, changed=False, said=said[:800])
    gates = _gates(a)
    first = _earlier_in_order(a, ac) + [i for i in _named(a, text, ac) if i not in _earlier_in_order(a, ac)]
    auto_done = any(h.get("ac") == ac and h.get("reordered") for h in a.data.get("amend_history") or [])
    if first and ORDER_TALK.search(f"{said} {reopen}") and not auto_done:
        acs = move_before(a.acs, first, ac)
        hist[-1]["reordered"] = first
        note = (f"keel moved {', '.join(first)} before {ac}: the amendment says it is an order question, not a spec "
                f"change. Next: {first[0]}.")
        gates["log"].append(note[:300])
        data = {**a.data, "amend": {**amend, "route": "reorder"}, "amend_history": hist,
                "ac_order": {"ids": [x["id"] for x in acs], "from": "keel"}}
        return _ok(note, update={"acs": acs, "ac": first[0], "gates": gates, "data": data, "show": None})
    amend = {**amend, "route": "ask", "next": _next_for(a, ac, text)}
    without, note = _loop_choices(a, ac, amend["next"])
    data = {**a.data, "amend": amend, "amend_history": hist, "amend_loop_without": without}
    return _ok(f"the amendment for {ac} changed nothing in the spec: asking you", update={
        "data": data, "show": _loop_text(a, amend, hist[-1], without, note)})


def amend_reorder(a):
    """The choice gate's first / skip: build the named criterion first, or move this one to the end."""
    amend = a.data.get("amend") or {}
    ac = amend.get("ac") or a.state.get("ac")
    choice = ((a.data.get("amend_loop_answer") or {}).get("choice")) or "first"
    gates = _gates(a)
    if choice == "skip" or not amend.get("next"):
        acs = [x for x in a.acs if x["id"] != ac] + [x for x in a.acs if x["id"] == ac]
        nxt = next((i for i in [x["id"] for x in acs] if i in _unfinished(a) and i != ac), ac)
        note = f"you moved {ac} to the end; next: {nxt}" if nxt != ac else f"{ac} is the only criterion left: it runs again"
    else:
        nxt = amend["next"]
        acs = move_before(a.acs, [nxt], ac)
        note = f"you chose to build {nxt} before {ac}"
    gates["log"].append(note[:300])
    data = {**a.data, "amend": {**amend, "route": "moved"}, "amend_history": _history(a, ac=ac, choice=choice),
            "ac_order": {"ids": [x["id"] for x in acs], "from": "person"}}
    # `first` comes back to the same criterion: one more round toward the send-back limit (skip does not count)
    tries = {} if choice == "skip" else flow_actions.stuck_counted(a.state, ac, flow_actions.stuck_tries(a.state, ac) + 1)
    return _ok(note, update={"acs": acs, "ac": nxt, "gates": gates, "data": data, "show": None, **tries})


def stuck(a):
    """The red / green agent said BLOCKED (or GREEN-RESULT: stalled): no retry of the same thing. When the reason names
    unfinished criteria, those are built first (the order changes, the gate log says so); otherwise the person chooses:
    retry with a note, skip the criterion, edit the spec, stop."""
    from .actions import ActionResult

    ac = a.state.get("ac") or (a.ac or {}).get("id")
    src = "green" if a.phase == "green" else "red"
    why = str(((a.state.get("markers") or {}).get(src) or {}).get("BLOCKED") or "").strip()
    first = _named(a, why, ac)
    if first:
        acs = move_before(a.acs, first, ac)
        gates = _gates(a)
        note = f"{ac} is blocked until {', '.join(first)} is built: keel moved {', '.join(first)} before {ac}"
        gates["log"].append(note[:300])
        data = {**a.data, "ac_order": {"ids": [x["id"] for x in acs], "from": "keel"}}
        return _ok(note, update={"acs": acs, "ac": first[0], "gates": gates, "data": data, "feedback": None})
    # 0.18.12 the agent says trying again will not help, so a plain approve is not a retry: it skips the criterion when
    # another one can go first, else it amends the spec (the e2e approved the default retry four times, same refusal)
    others = [i for i in _unfinished(a) if i != ac]
    choices = (["skip", "edit"] if others else ["edit"]) + ["retry", "stop"]
    says = {"skip": f"- skip: move {ac} to the end of the list and go on with the next criterion",
            "edit": f"- edit: amend the spec for {ac} first (your note says what is wrong)",
            "retry": f"- retry: the {src} agent again, with your note (say what to change: the command, the setup, the approach)",
            "stop": "- stop: stop the flow here (the commits so far stay)"}
    lines = [f"The {src} agent cannot go on with {ac}:", why or "(no reason given)", "",
             "Trying the same thing again will not help.",
             f'Choose one (approve with payload {{"choice": "<name>"}} and a note; a plain approve is {choices[0]}):',
             *[says[c] for c in choices]]
    return ActionResult(False, f"{ac} is blocked: {why[:200]}", why, ask=choices_mod.for_question({
        "type": "blocked", "kind": "fix", "title": f"{ac} is blocked", "detail": "\n".join(lines), "choices": choices},
        context="blocked"))


def amend_with_note(a):
    """The choice gate's edit: the amendment is written again, with the person's note added to the reason."""
    amend = dict(a.data.get("amend") or {})
    why = str((a.data.get("amend_loop_answer") or {}).get("why") or "").strip()
    if why:
        amend["reason"] = (f"{amend.get('reason', '')}\nThe person says: {why}")[:3000]
    amend["route"] = "amend"
    ac = amend.get("ac") or a.state.get("ac")
    return _ok("the amendment is written again with your note", update={
        "data": {**a.data, "amend": amend}, **flow_actions.stuck_counted(a.state, ac, flow_actions.stuck_tries(a.state, ac) + 1)})


def amend_stop(a):
    """The amendment loop gate's stop: the flow stops here with the person's note; the commits so far stay."""
    from .actions import ActionResult

    ac = (a.data.get("amend") or {}).get("ac") or a.state.get("ac")
    why = str((a.data.get("amend_loop_answer") or {}).get("why") or "").strip()
    return ActionResult(False, f"Stopped at {ac}'s amendment loop" + (f": {why}" if why else "."), stop=True)


AMENDMENTS = re.compile(r"(?mi)^##\s+amendments\s*$")


def _amendment_blocks(text: str) -> list[str]:
    """The dated blocks under "## Amendments", oldest first."""
    m = AMENDMENTS.search(text or "")
    if not m:
        return []
    rest = text[m.end():]
    end = re.search(r"(?m)^##\s", rest)
    sec = rest[:end.start()] if end else rest
    blocks = re.split(r"(?m)^(?=###\s)", sec)
    return [b.strip() for b in blocks if b.strip().startswith("###")]


def _last_amendment(text: str) -> str:
    blocks = _amendment_blocks(text)
    return blocks[-1] if blocks else ""


# ------------------------------------------------------------------ an approved amendment changes the criteria (0.18.12)
# The e2e on spring-petclinic: the amendment "re-tag AC-001 to AC-004 as [API]" was approved, but the criteria lines and
# state.acs still said [WEB], so the guard refused the same test again and red asked the same AMEND, round after round.
# Now the approved block is applied: its "Now:" part either restates a criterion in full ("- **AC-2** [API] <wording>")
# or retags the criteria it names ("Now: tagged [API]"). The block stays as the record of what changed and why.

NOW_PART = re.compile(r"(?ims)^[ \t>*+-]*\**now\**[ \t]*:\**(.*?)(?=^[ \t>*+-]*\**(?:was|why|reopen|contract)\**[ \t]*:|\Z)")
FULL_LINE = re.compile(r"^[ \t>*+-]*\**(AC-\d+)\**[ \t]*\[(API|WEB)\][ \t]*(.*)$", re.I)
LAYER_TAG = re.compile(r"\[(API|WEB)\]", re.I)
# "(wording unchanged)", "same as approved": a restated line that keeps the old words
SAME_WORDS = re.compile(r"^\W*(\(?\s*(wording|text|behaviou?r)?\s*(unchanged|the same|same|as (before|approved))\s*\)?)?\W*$", re.I)
AC_RANGE = re.compile(r"\b(AC)-(\d+)\s*(?:\.\.\.?|–|—|-|\bto\b|\bthrough\b)\s*AC-(\d+)\b", re.I)


def _ids_in(text: str) -> list[str]:
    """Criteria ids a text names, ranges too: "AC-001 to AC-004" and "AC-001..AC-004" are four criteria."""
    out = []
    for m in AC_RANGE.finditer(text or ""):
        lo, hi, width = int(m.group(2)), int(m.group(3)), len(m.group(2))
        if lo <= hi and hi - lo < 50:
            out += [f"AC-{n:0{width}d}" for n in range(lo, hi + 1)]
    out += [i.upper() for i in re.findall(r"\bAC-\d+\b", text or "", re.I)]
    return list(dict.fromkeys(out))


def amended_criteria(block: str) -> dict[str, dict]:
    """{criterion: {"layer": ..., "title": ...}} that one amendment block changes (only what its Now: part says)."""
    m = NOW_PART.search(block or "")
    if not m:
        return {}
    heading = (block.splitlines() or [""])[0]
    lines = m.group(1).splitlines()
    out: dict[str, dict] = {}
    rest = []
    n = 0
    while n < len(lines):
        full = FULL_LINE.match(lines[n])
        if not full:
            rest.append(lines[n])
            n += 1
            continue
        words = [full.group(3).strip()]
        n += 1
        while n < len(lines) and lines[n].startswith((" ", "\t")) and lines[n].strip() and not FULL_LINE.match(lines[n]):
            words.append(lines[n].strip())
            n += 1
        title = " ".join(words).strip().strip("*").strip()
        change = {"layer": full.group(2).upper()}
        if not (SAME_WORDS.match(title) or LAYER_TAG.search(title) or prompts.PLACEHOLDER.search(title) or len(title) < 3):
            change["title"] = title
        out[full.group(1).upper()] = change
    # a retag: one layer tag in the rest of Now:, for the criteria it names (else the ones the heading names)
    said = " ".join(rest)
    tags = {t.upper() for t in LAYER_TAG.findall(said)}
    if len(tags) == 1:
        layer = tags.pop()
        for i in _ids_in(LAYER_TAG.sub(" ", said)) or _ids_in(heading):
            out.setdefault(i, {"layer": layer})
    return out


def _criterion_at(lines: list[str], ac: str) -> tuple[int, re.Match] | None:
    """The line where criterion `ac` is written (outside code blocks), as prompts.parse_acs reads it."""
    fence = False
    for n, line in enumerate(lines):
        if line.lstrip().startswith("```"):
            fence = not fence
            continue
        m = None if fence else prompts.AC_LINE.search(line)
        if m and m.group(1).upper() == ac.upper():
            return n, m
    return None


def rewrite_criterion(text: str, ac: str, layer: str | None = None, title: str | None = None) -> str:
    """The spec with criterion `ac`'s line changed: its layer tag, and its wording (the wrapped lines under it go)."""
    lines = text.split("\n")
    at = _criterion_at(lines, ac)
    if not at:
        return text
    n, m = at
    line = lines[n]
    tag = f"[{(layer or m.group(2)).upper()}]"
    if title is None:
        lines[n] = line[:m.start(2) - 1] + tag + line[m.end(2) + 1:]
        return "\n".join(lines)
    lines[n] = line[:m.start(2) - 1] + tag + " " + title
    end = n + 1
    while end < len(lines) and lines[end].startswith((" ", "\t")) and lines[end].strip() \
            and not re.match(r"\s*([-*+]|\d+\.)\s", lines[end]):
        end += 1
    return "\n".join(lines[:n + 1] + lines[end:])


def apply_amendments(text: str) -> tuple[str, list[str]]:
    """The spec with every amendment block applied to the criteria above "## Amendments", oldest first (so applying
    them again changes nothing), and what changed ("AC-2 [WEB] → [API]")."""
    m = AMENDMENTS.search(text or "")
    if not m:
        return text, []
    head, tail = text[:m.start()], text[m.start():]
    was = {x["id"]: x for x in prompts.parse_acs(head)}
    for block in _amendment_blocks(text):
        for ac, change in amended_criteria(block).items():
            if ac in was:
                head = rewrite_criterion(head, ac, change.get("layer"), change.get("title"))
    changed = []
    for x in prompts.parse_acs(head):
        old = was.get(x["id"])
        if old and old["layer"] != x["layer"]:
            changed.append(f"{x['id']} [{old['layer']}] → [{x['layer']}]")
        if old and old["title"] != x["title"]:
            changed.append(f"{x['id']} reworded")
    return head + tail, changed


def _reopen(a) -> list[str]:
    said = str((a.state.get("markers") or {}).get("*", {}).get("REOPEN") or "")
    return [] if re.fullmatch(r"\s*(none|no|-)?\s*\.?", said, re.I) else [i.upper() for i in AC_ID.findall(said.upper())]


def spec_amendment(a):
    """The amendment gate's text (keel v1: write the dated block, then stop before committing it).

    v0.17.4: a round that wrote nothing into the spec does not reach the approve gate (it would show an old block and
    commit nothing): `_no_change` reorders or asks (data.amend.route = reorder | ask; "gate" otherwise)."""
    spec = spec_path(a)
    pending = a.data.get("amend") or {}
    block = _last_amendment(_read(a.root, spec))
    if pending.get("ac") and not _spec_changed(a, spec):
        said = f"{a.state.get('last_answer') or ''} {((a.state.get('markers') or {}).get('*') or {}).get('REOPEN') or ''}"
        # the explorer found no spec change to make, or the spec only holds an older block: no gate that commits nothing.
        # An explorer that wrote nothing and says nothing about it is sent back below to write the block (as before).
        if block or NOT_A_DEFECT.search(said) or ORDER_TALK.search(said):
            return _no_change(a, spec, pending)
    if not block:
        return _fail("The amendment is not in the spec.",
                     f"Add it to {spec or 'the spec'} under ## Amendments as a dated block: ### <date> — <criteria>, then "
                     "Was:, Now:, Why:. Never edit the frozen criteria in place.")
    amend = a.data.get("amend") or {}
    reopen = _reopen(a)
    done = [x for x in a.acs if x.get("status") in DONE or x.get("status") == "green"]
    lines = ["The frozen spec needs an amendment.", f"Why: {amend.get('reason') or 'not recorded'}", "",
             f"The block in {spec}:", block[:4000], ""]
    applies = apply_amendments(_read(a.root, spec))[1]
    if applies:
        lines += ["On approval keel changes the criteria lines too: " + ", ".join(applies), ""]
    if done:
        lines.append("Criteria already finished under the old wording: " + ", ".join(x["id"] for x in done))
        lines.append("Reopened by this amendment: " + (", ".join(reopen) if reopen else
                     "none (the block should say why they may ship under the old wording)"))
    contract = str(((a.state.get("markers") or {}).get("*") or {}).get("CONTRACT") or "").lower().startswith("yes")
    if contract or amend.get("from") == "contract":
        lines.append("The API shape moves: the contract is done again before the loop goes on.")
    lines += ["", "Choose one (approve with payload {\"choice\": \"<name>\"} and a note):",
              "- approve: commit the amendment, then back to the criteria (the contract first when the API shape moved)",
              "- context: tell keel what it was missing; the block is written again and comes back here",
              "- change: the block is close but wrong; say how",
              "- rebuild: the spec itself is wrong; a new feature flow starts on this branch with what was learned "
              "(the commits stay)"]
    return _ok("amendment ready for the gate", update={"show": "\n".join(lines), "data": {**a.data, "amend": {**amend, "route": "gate"}}})


def spec_amend_commit(a):
    """The approved amendment, committed alone (docs: amend: ...): criteria the block adds join the list, the ones the
    amendment reopens (REOPEN) are open again. Marker CONTRACT: yes when the contract must change first."""
    from .actions import commit

    spec = spec_path(a)
    text = _read(a.root, spec)
    # the approved block changes the criteria lines it names (layer, wording): the guard and the agents read the new ones
    text, applied = apply_amendments(text)
    if applied and spec:
        (Path(a.root) / spec).write_text(text)
    text, retagged = api_only(a, spec, text)
    applied += [f"{ac} [WEB] → [API] (no separate web tests)" for ac in retagged]
    # the build order stays as it is (the plan's, or as the person or keel moved it); new criteria go after the rest
    acs = with_depends(order_acs(merge_acs(a.acs, prompts.parse_acs(text), drop=False), " ".join(x["id"] for x in a.acs)), text)
    reopen = [i for i in _reopen(a) if any(x["id"].upper() == i for x in acs)]
    acs = [dict(x, status="todo") if x["id"].upper() in reopen else x for x in acs]
    amend = a.data.get("amend") or {}
    reason = str(amend.get("reason") or "spec amended")
    r = commit(replace(a, phase="spec", title=f"amend: {reason.split(': ', 1)[-1]}", paths=[spec] if spec else []))
    if not r.ok:
        return r
    gates = _gates(a)
    gates["log"].append(f"spec amended: {reason}"[:300] + (f" · reopened {', '.join(reopen)}" if reopen else ""))
    if applied:
        gates["log"].append(("criteria changed by the amendment: " + ", ".join(applied))[:300])
    said = str(((a.state.get("markers") or {}).get("*") or {}).get("CONTRACT") or "").lower()
    contract = amend.get("from") == "contract" or said.startswith("yes")
    data = {**a.data, "amendments": list(a.data.get("amendments") or []) + [{**amend, "reopen": reopen, "commit": r.update.get("git_head")}],
            "amend_history": _history(a, ac=amend.get("ac"), changed=bool(r.update.get("git_head")))}
    if contract:
        data["contract"] = "yes"          # v0.17.5 the contract steps run again even when the plan said none
    new = [x["id"] for x in acs if x["id"] not in {y["id"] for y in a.acs}]
    note = f"amendment committed: {r.note}" + (f"; new criteria {', '.join(new)}" if new else "") + \
           (f"; reopened {', '.join(reopen)}" if reopen else "") + (f"; applied {', '.join(applied)}" if applied else "") + \
           ("; the contract is next" if contract else "")
    return _ok(note, update={**r.update, "acs": acs, "gates": gates, "data": data,
                             "markers": _markers(a, {"CONTRACT": "yes" if contract else "no"})})


# ------------------------------------------------------------------ gates' views

def show_diff(a):
    """What the next gate shows: keel's uncommitted change (the contract delta: new, changed, removed), else the
    branch diff since the flow started (the integration gate)."""
    if not git.is_repo(a.root):
        return _ok("Not a git repository: no diff to show.", update={"show": "Not a git repository: no diff to show."})
    mine = {f for f, fp in a.preexisting.items() if git.fingerprint(a.root, f) == fp}
    dirty = {f: xy for f, xy in git.dirty(a.root).items() if f not in mine}
    if not dirty and a.phase == "contract":
        # v0.17.5 the contract agent wrote nothing: there is no delta to approve, so its gate is not asked
        return _ok("no contract change", update={"show": "The contract agent changed nothing.",
                                                  "data": {**a.data, "contract": "no"}})
    if dirty:
        tracked = [f for f, xy in dirty.items() if "?" not in xy]
        out = [f"Uncommitted change ({len(dirty)} file(s)), not committed until you approve:", ""]
        if tracked:
            out.append(git.git(a.root, "diff", "HEAD", "--", *tracked).stdout)
        for f in sorted(x for x, xy in dirty.items() if "?" in xy):
            p = Path(a.root) / f
            body = p.read_text(errors="replace") if p.is_file() else ""
            out += [f"new file {f}:", "\n".join("+" + line for line in body.splitlines()[:200]), ""]
        text = "\n".join(out)
    else:
        base = a.base or "HEAD"
        stat = git.git(a.root, "diff", "--stat", f"{base}..HEAD").stdout.strip()
        text = f"Branch diff since the flow started ({base[:7]}..HEAD):\n{stat or 'no change'}\n\n" + \
               git.git(a.root, "diff", f"{base}..HEAD").stdout
    text = text.strip()
    if len(text) > 12000:
        text = text[:12000] + "\n… (cut; see the repository for the rest)"
    return _ok(f"diff ready ({len(dirty)} uncommitted file(s))" if dirty else "branch diff ready", update={"show": text})


# ------------------------------------------------------------------ security

def security_scope(a):
    """keel v1 phase 5.5: two pipelines in parallel. The security auditor reads the branch diff against the spec;
    the dependency triager runs only when verify deps reported something (its output is the triager's input)."""
    cfg = rules.load_config(a.root)
    base = verdict_actions.base_ref(a.root, cfg, a.base) if git.is_repo(a.root) else None
    items = [{"id": "audit", "title": "security audit of the branch diff", "agent": "security-auditor",
              "scope": f"git diff {base}...HEAD" if base else "the branch diff", "spec": spec_path(a) or "(no spec file)"}]
    res = ((a.state.get("markers") or {}).get(DEPS_STEP) or {}).get("RESULT")
    out = str(a.data.get(f"{DEPS_STEP}_output") or "")
    if res == "fail" and out:
        items.append({"id": "deps", "title": "dependency triage", "agent": "dependency-triager", "advisories": out[:6000]})
    return _ok("security: " + " and ".join(i["title"] for i in items), update={"data": {**a.data, "security_items": items}})


# ------------------------------------------------------------------ e2e and smoke

def _tagged(text: str, layer: str) -> list[str]:
    text = re.sub(r"```.*?(```|\Z)", "", text or "", flags=re.S)
    return [f"{m.group(1)} [{layer}] {m.group(2).strip().strip('*').strip()}"
            for m in re.finditer(LAYER_LINE.format(layer=layer), text)]


def _layer_ids(a, text: str, layer: str) -> list[str]:
    """The ids of the flow's criteria in this layer ([E2E], [SMOKE]), then any other id the spec tags so."""
    ids = [x["id"] for x in a.acs if str(x.get("layer") or "").upper() == layer]
    return list(dict.fromkeys(ids + [m.group(1) for m in re.finditer(LAYER_LINE.format(layer=layer),
                                                                      re.sub(r"```.*?(```|\Z)", "", text or "", flags=re.S))]))


def _covered(a, ids: list[str]) -> list[dict]:
    """The flow's criteria with these ids done: their e2e or smoke tests ran and passed."""
    return [dict(x, status="done") if x["id"] in ids and x.get("status") not in DONE else x for x in a.acs]


def e2e_scope(a):
    """keel v1 phase 7: the [E2E] criteria (a hunt's needs_e2e adds the journey that broke). Before delegating, is
    commands.e2e set? Without it the gate asks (keel v1 e2e-tool-missing): either way the specs are written."""
    cfg = rules.load_config(a.root)
    text = _read(a.root, spec_path(a))
    crit = _tagged(text, "E2E")
    ids = _layer_ids(a, text, "E2E")
    if not crit and a.data.get("needs_e2e"):
        crit = [f"the journey that broke: {a.title}"]
    cmd = str((cfg.get("commands") or {}).get("e2e") or "").strip()
    note = (f"Run them with: {cmd}" if cmd else
            "No e2e command is configured: write the specs, do not run them, and say so in your answer.")
    data = {**a.data, "e2e": {"criteria": crit, "ids": ids, "command": cmd or None, "run": bool(cmd), "note": note},
            "e2e_tool_detail": "No e2e command is configured (commands.e2e in .keel/config.yml), so the E2E specs cannot "
                               "run here.\n\nCriteria:\n" + "\n".join(f"- {c}" for c in crit) +
                               "\n\nChoose one (approve with payload {\"choice\": \"<name>\"}):\n"
                               "- write: the specs are written and committed but not run; the final review and the PR "
                               "body say so (an unrun test must not read as a passing one)\n"
                               "- check: you set commands.e2e now; keel looks again"}
    mk = _markers(a, {"E2E": "yes" if crit else "no", "TOOL": "yes" if cmd else "no"})
    return _ok(f"e2e: {len(crit)} criteria" + ("" if crit else ", nothing to write") + (f"; runs `{cmd}`" if cmd else "; no e2e command"),
               update={"data": data, "markers": mk})


def e2e_unrun(a):
    e2e = {**(a.data.get("e2e") or {}), "run": False,
           "note": "No e2e command is configured: write the specs, do not run them, and say so in your answer."}
    skipped = [x for x in a.data.get("ship_skipped") or [] if x.get("step") != "e2e-run"] + [
        {"step": "e2e-run", "band": "optional", "reason": "no e2e command (commands.e2e): the @e2e specs are written, not run"}]
    gates = _gates(a)
    gates["log"].append("e2e: specs written without running them (no e2e command)")
    return _ok("e2e specs will be written, not run", update={"data": {**a.data, "e2e": e2e, "ship_skipped": skipped}, "gates": gates})


def verify_e2e(a):
    """keel v1 `keel verify e2e`: the E2E command, a failure runs once more (fail then pass = flaky, a warning)."""
    e2e = a.data.get("e2e") or {}
    ids = list(e2e.get("ids") or [])
    said = str(((a.state.get("markers") or {}).get("*") or {}).get("E2E-RESULT") or "")
    # the commit after this one says which criteria it covers (actions.commit: a "Covers:" line)
    covers = {"data": {**a.data, "e2e": {**e2e, "covers": ids}}}
    if not e2e.get("run") or not e2e.get("command"):
        # written, not run: the criteria stay open (an unrun test must not read as a passing one)
        return _ok("E2E specs written; not run (no e2e command).", update=covers)
    if a.fake:
        return _ok("E2E: passed (simulated).", update={**covers, "acs": _covered(a, ids)})
    r = verdict_actions.run_suite(a.root, e2e["command"], "e2e", 1)
    if not r["ok"]:
        return _fail("The E2E specs fail.", f"$ {e2e['command']}\n{verdict_actions._tail(r['out'])}" +
                     (f"\nThe e2e author said E2E-RESULT: {said}." if said else ""))
    return _ok("E2E: passed." + verdict_actions._flaky_note(r["flaky"]),
               update={**covers, "acs": _covered(a, ids), **verdict_actions.flaky_update(a, r["flaky"])})


def smoke_scope(a):
    """keel v1 phase 6: the [SMOKE] criteria or a filled Smoke checks section; nothing there, no smoke phase."""
    text = _read(a.root, spec_path(a))
    checks = _tagged(text, "SMOKE")
    section = _section(text, "smoke")
    if not checks and section and not re.fullmatch(r"(?is)\s*(none|n/?a|-|tbd)?\.?\s*", section):
        checks = [line.strip("-* ").strip() for line in section.splitlines() if line.strip()][:10]
    ids = _layer_ids(a, text, "SMOKE")
    return _ok(f"smoke: {len(checks)} check(s)", update={"data": {**a.data, "smoke": {"checks": checks, "ids": ids}},
                                                          "markers": _markers(a, {"SMOKE": "yes" if checks else "no"})})


def verify_smoke(a):
    """keel v1 `keel smoke`: every smoke/*.sh (BASE_URL and API_URL from e2e.web_url / e2e.api_url), then
    commands.smoke_e2e; the first failure stops. Passed: the [SMOKE] criteria are done."""
    smoke = a.data.get("smoke") or {}
    ids = list(smoke.get("ids") or [])
    passed = {"data": {**a.data, "smoke": {**smoke, "covers": ids}}, "acs": _covered(a, ids)}
    if a.fake:
        return _ok("Smoke: passed (simulated).", update=passed)
    cfg = rules.load_config(a.root)
    env = command_env()
    urls = cfg.get("e2e") if isinstance(cfg.get("e2e"), dict) else {}
    env.update({k: str(v) for k, v in (("BASE_URL", urls.get("web_url")), ("API_URL", urls.get("api_url"))) if v})
    cmds = [f"bash {p.relative_to(a.root)}" for p in sorted((Path(a.root) / "smoke").glob("*.sh"))]
    extra = str((cfg.get("commands") or {}).get("smoke_e2e") or "").strip()
    if extra:
        cmds.append(extra)
    if not cmds:
        return _fail("No smoke check to run.", "Write smoke/<name>.sh (and one @smoke test for commands.smoke_e2e).")
    for cmd in cmds:
        code, out = testcmd.run(a.root, cmd, 300, env)
        if code != 0:
            return _fail(f"Smoke check failed: {cmd}", f"$ {cmd}\n{verdict_actions._tail(out)}")
    return _ok(f"Smoke: {len(cmds)} check(s) passed." + ("" if extra else " (commands.smoke_e2e is not set: no @smoke test ran)"),
               update=passed)


# ------------------------------------------------------------------ close

def close_flow(a):
    """keel v1 phase 9: what shipped in one line (criteria done, the ADRs this flow added)."""
    done = sum(1 for x in a.acs if x.get("status") in DONE)
    adrs = []
    if git.is_repo(a.root) and a.base:
        adrs = [f for f in git.git(a.root, "diff", "--name-only", f"{a.base}..HEAD", "--", *layout.resolve(a.root).adr_dirs).stdout.splitlines()
                if f.strip()]
    note = f"{done}/{len(a.acs)} criteria done; " + (f"ADR: {', '.join(adrs)}" if adrs else "no ADR (no decision had a real alternative)")
    if done < len(a.acs):
        note += "; some criteria are not done: look at the board and the gate log"
    return _ok(note)


ACTIONS = {"preflight": preflight, "explore_areas": explore_areas, "spec_sync": spec_sync, "spec_freeze": spec_freeze,
           "spec_restart": spec_restart, "amend_start": amend_start, "spec_amendment": spec_amendment,
           "spec_amend_commit": spec_amend_commit, "amend_reorder": amend_reorder, "amend_with_note": amend_with_note, "stuck": stuck,
           "amend_stop": amend_stop, "show_diff": show_diff, "security_scope": security_scope,
           "e2e_scope": e2e_scope, "e2e_unrun": e2e_unrun, "verify_e2e": verify_e2e, "smoke_scope": smoke_scope,
           "verify_smoke": verify_smoke, "close_flow": close_flow}

