"""The bug flow's own pieces (content/workflows/fix.yaml), keel v1 skills/fix:

    register     bug_intake: the bug's id BUG-<n> (one more than the highest in the history) is the flow's criterion,
                 its layer WEB when the report is about a page and the project has a web layer, else API
    layer        the reproducer may correct the layer with its LAYER: API | WEB line
    find_test    the reproducing test as file::name, from the runner's failures or the changed test files
    root_cause   the root cause from the Gate F plan (its "Root cause" section, else its first paragraph)
    bug_plan     plan_report: data.bug.root_cause and data.bug.plan, for the fix commit's body and the PR body
    bug_drop_red Gate R "reproduce differently": the rejected test(BUG-<n>) commit goes, so no wrong test stays
    bug_reset    the fix failed twice: keel's uncommitted changes go back and what was learned is kept (data.learned)
    section      the "## Bug" section of the final review and the PR body
"""

from __future__ import annotations

import re
from pathlib import Path

from .. import rules
from ..tools import git

BUG = re.compile(r"\bBUG-(\d+)\b")
# words of a report about what a person sees (a page, a button), not about an API's answer
WEB_WORDS = re.compile(r"\b(ui|page|pages|screen|button|buttons|form|browser|frontend|front-end|css|layout|click|clicks|"
                       r"clicked|modal|dialog|tooltip|menu|render|renders|rendered|displayed|shown on)\b", re.I)
TEST_BUCKETS = ("api-test", "web-test", "e2e")
MAX_RESETS = 2           # keel v1 resets once per two failed fixes; a third reset in one flow stops it


def _ok(note: str, detail: str = "", update: dict | None = None):
    from .actions import ActionResult

    return ActionResult(True, note, detail, update or {})


def _stop(note: str, detail: str = ""):
    from .actions import ActionResult

    return ActionResult(False, note, detail, stop=True)


# ------------------------------------------------------------------ the bug's id and layer

def next_id(root: str) -> str:
    """BUG-<n>: one more than the highest bug number in any branch's commit subjects (two fix branches never share one)."""
    if not git.is_repo(root):
        return "BUG-1"
    used = [int(n) for n in BUG.findall(git.git(root, "log", "--all", "--format=%s").stdout)]
    return f"BUG-{max(used or [0]) + 1}"


def of(acs: list[dict] | None) -> dict | None:
    """The flow's bug criterion (BUG-<n>), if it has one."""
    return next((dict(a) for a in acs or [] if BUG.fullmatch(str(a.get("id") or ""))), None)


def guess_layer(root: str, text: str) -> str:
    """WEB when the report is about a page and the project tests a web layer of its own, else API (a server-rendered
    page is tested by backend tests: prompts.NO_WEB)."""
    from . import stacks

    return "WEB" if WEB_WORDS.search(text or "") and stacks.has_web_layer(root) else "API"


def said_layer(state: dict) -> str | None:
    """The reproducer's LAYER: API | WEB line (its own choice of layer wins over keel's guess)."""
    said = str(((state.get("markers") or {}).get("repro") or {}).get("LAYER") or "").strip().upper()
    word = re.match(r"[A-Z]+", said)
    return word.group(0) if word and word.group(0) in ("API", "WEB") else None


def current(a) -> dict | None:
    """The bug criterion with the layer the reproducer named, if it named one."""
    bug = of(a.acs)
    said = said_layer(a.state) if bug else None
    return dict(bug, layer=said) if bug and said else bug


def register(a) -> dict:
    """bug_intake's state update: BUG-<n> as the flow's criterion (kept on a resume), and data.bug for the PR body."""
    bug = of(a.acs)
    seed = a.data.get("seed") or {}
    symptom = str(seed.get("request") or a.request or a.title or "").strip()
    if not bug:
        bug = {"id": next_id(a.root), "layer": guess_layer(a.root, f"{a.title}\n{symptom}"), "title": a.title,
               "status": "todo"}
    info = {**(a.data.get("bug") or {}), "id": bug["id"], "layer": bug.get("layer", "API"), "symptom": symptom[:1500]}
    if seed.get("hunt"):
        info["hunt"] = seed["hunt"]
    acs = [x for x in a.acs if x["id"] != bug["id"]] + [bug]
    return {"acs": acs, "ac": bug["id"], "data": {**a.data, "bug": info}}


# ------------------------------------------------------------------ the reproducing test

def _names(bug_id: str) -> set[str]:
    key = re.sub(r"[^a-z0-9]+", "_", bug_id.lower()).strip("_")
    return {bug_id.lower(), key, key.replace("_", "")}


def named(text: str, bug_id: str) -> bool:
    """Does a test name (or a line) carry the bug id, in any of the forms a test name can hold (BUG-3, bug_3, BUG3)?"""
    low = str(text or "").lower()
    return any(re.search(rf"(?<![a-z0-9]){re.escape(n)}(?![0-9])", low) for n in _names(bug_id))


_TEST_NAME = [re.compile(p) for p in (
    r"\bdef\s+(test\w*)", r"\bfun\s+`([^`]+)`", r"\bfun\s+(\w+)", r"\b(?:void|func)\s+(\w+)\s*\(",
    r"\b(?:it|test|describe)\s*\(\s*[\"'`](.+?)[\"'`]", r"\bclass\s+(\w+)")]


def changed_tests(root: str) -> list[str]:
    """The test files changed in the working tree (what the reproducer wrote, before keel commits it)."""
    if not git.is_repo(root):
        return []
    cfg = rules.load_config(root)
    return sorted(f for f in git.dirty(root) if rules.classify(cfg, f) in TEST_BUCKETS)


def find_test(root: str, bug_id: str, output: str, files: list[str]) -> dict:
    """{file, name}: the failing test the runner names after the bug (pytest's FAILED file::name), else the first line in
    a changed test file that carries the bug id."""
    from .verdict_actions import failed_tests

    for name in failed_tests(output):
        if named(name, bug_id):
            file, sep, test = name.partition("::")
            if not sep:
                return {"file": files[0] if files else "", "name": name}
            # a runner started in a part's folder (web/) names the file from there
            whole = next((f for f in files if f == file or f.endswith("/" + file)), file)
            return {"file": whole, "name": test}
    loose = None
    for rel in files:
        try:
            lines = (Path(root) / rel).read_text(errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            if not named(line, bug_id):
                continue
            hit = next((m.group(1) for p in _TEST_NAME if (m := p.search(line))), None)
            if hit:
                return {"file": rel, "name": hit}
            loose = loose or {"file": rel, "name": line.strip()[:100]}
    return loose or {"file": files[0] if files else "", "name": ""}


def shown_test(test: dict | None) -> str:
    if not test or not (test.get("file") or test.get("name")):
        return "not found"
    return "::".join(x for x in (test.get("file"), test.get("name")) if x)


# ------------------------------------------------------------------ the plan's root cause

_CAUSE = re.compile(r"^[\s#>*_-]*root cause[\s*_]*[:.\-–—]?[\s*_]*(.*)$", re.I)
_MARKER = re.compile(r"^\s*[A-Z][A-Z0-9-]+:\s*\S+\s*$")


def _clean(text: str) -> str:
    return " ".join(text.replace("**", "").split()).strip(" -:")


def root_cause(plan: str) -> str:
    """The root cause from the Gate F plan: its "Root cause" heading or line, with the lines under it up to the next
    blank line or heading; else the plan's first paragraph. Marker lines (ROOT-CAUSE: confirmed, E2E: no) are not it."""
    lines = str(plan or "").splitlines()
    for n, line in enumerate(lines):
        m = _CAUSE.match(line)
        if not m:
            continue
        got = [m.group(1)] if m.group(1).strip() else []
        for nxt in lines[n + 1:]:
            if not nxt.strip():
                if got:
                    break
                continue
            if nxt.lstrip().startswith("#") or _MARKER.match(nxt) or re.match(r"^\s*(\*\*)?[A-Z][\w ]{2,30}(\*\*)?:", nxt):
                break
            got.append(nxt)
        text = _clean(" ".join(got))
        if text:
            return text[:800]
    para: list[str] = []
    for line in lines:
        if not line.strip():
            if para:
                break
            continue
        if line.lstrip().startswith("#") or _MARKER.match(line):
            continue
        para.append(line)
    return _clean(" ".join(para))[:800]


def bug_plan(a):
    """plan_report, after report: the plan's root cause in data.bug (the fix commit's body, the PR body's bug section)."""
    plan = str(a.state.get("last_answer") or "").strip() or str(a.data.get("report") or "")
    cause = root_cause(plan)
    info = {**(a.data.get("bug") or {}), "root_cause": cause, "plan": plan[:4000]}
    return _ok(f"root cause: {cause[:160]}" if cause else "the plan names no root cause", update={"data": {**a.data, "bug": info}})


def commit_body(a) -> str:
    """The fix commit's body: the root cause (keel v1 fix.md: in six months that body is the only explanation)."""
    bug = a.data.get("bug") or {}
    cause = str(bug.get("root_cause") or "").strip() or root_cause(str(a.data.get("report") or ""))
    return f"Root cause: {cause}" if cause else ""


# ------------------------------------------------------------------ Gate R: reproduce differently

def bug_drop_red(a):
    """Gate R "reproduce differently" (keel v1: amend the red commit): the rejected test(BUG-<n>) commit is undone and
    its files put back, so the reproducer's next test replaces it instead of stacking a second one next to it."""
    bug = of(a.acs)
    if not bug or not git.is_repo(a.root):
        return _ok("no bug test to drop")
    subject = git.git(a.root, "log", "-1", "--format=%s").stdout.strip()
    if not subject.startswith(f"test({bug['id']})"):
        return _ok(f"no test({bug['id']}) commit on top to drop; the reproducer tries again")
    if git.git(a.root, "rev-parse", "--verify", "-q", "HEAD~1").returncode != 0:
        return _ok("the red commit is the first commit; it stays")
    files = [f for f in git.git(a.root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").stdout.splitlines() if f.strip()]
    git.git(a.root, "reset", "-q", "--soft", "HEAD~1")
    if files:
        git.git(a.root, "reset", "-q", "--", *files)
    for rel in files:
        if git.tracked_in_head(a.root, rel):
            git.git(a.root, "checkout", "HEAD", "--", rel)
        else:
            (Path(a.root) / rel).unlink(missing_ok=True)
    info = dict(a.data.get("bug") or {})
    info["rejected"] = list(info.get("rejected") or []) + ([info["test"]] if info.get("test") else [])
    info["test"] = None
    said = str(a.state.get("feedback") or "").strip()
    feedback = (f"{said}\n\n" if said else "") + (f"Your last test was rejected at Gate R: keel removed it with its commit "
                                                   f"({', '.join(files) or 'no files'}). Write a new test for the symptom.")
    acs = [dict(x, status="todo") if x["id"] == bug["id"] else dict(x) for x in a.acs]
    return _ok(f"dropped the rejected {subject[:80]}", "\n".join(files),
               {"acs": acs, "data": {**a.data, "bug": info}, "feedback": feedback})


# ------------------------------------------------------------------ the fix failed twice: reset

def bug_reset(a):
    """keel v1 fix.md "second failure: reset": keel's uncommitted changes go back (the reproducing test stays
    committed), and what was learned (the plan's cause that did not hold, the failure, the hypotheses ruled out) is
    kept in data.learned for the investigators that start again. A third reset stops the flow."""
    from .flow_actions import reset

    info = dict(a.data.get("bug") or {})
    n = int(info.get("resets") or 0) + 1
    r = reset(a)
    if n > MAX_RESETS:
        return _stop(f"The fix failed after {MAX_RESETS} resets; keel stops here (the reproducing test stays committed).",
                     str(a.data.get("learned") or ""))
    ruled = [str(x.get("title") or x.get("item")) for x in a.data.get("investigate_results") or []
             if isinstance(x, dict) and (x.get("markers") or {}).get("ROOT-CAUSE") != "confirmed"]
    lines = [f"Reset {n}: two fixes failed, so the cause or the plan was wrong."]
    if info.get("root_cause"):
        lines.append(f"- the plan's root cause did not hold: {info['root_cause']}")
    failure = str(a.state.get("last_failure") or "").strip()
    if failure:
        lines.append(f"- the last fix failed with: {failure}")
    if ruled:
        lines.append("- ruled out by the investigators: " + "; ".join(ruled))
    learned = (str(a.data.get("learned") or "").strip() + "\n\n" + "\n".join(lines)).strip()
    info["resets"] = n
    feedback = ("Two fixes failed, so keel reset the fix (the reproducing test stays committed). What was learned so "
                f"far:\n{learned}\nLook for a different cause.")
    return _ok(f"{r.note}; reset {n} of {MAX_RESETS}: what was learned is kept", r.detail,
               {"data": {**a.data, "bug": info, "learned": learned}, "feedback": feedback})


# ------------------------------------------------------------------ the final review and the PR body

def section(state: dict) -> list[str]:
    """keel v1 fix.md "Then": the bug the branch fixes, for the final review and the PR body: the symptom, the root cause
    (Gate F), the reproducing test, the regression e2e and the hunt findings it closes. [] for a flow with no bug."""
    data = state.get("data") or {}
    info = data.get("bug") or {}
    hunt = info.get("hunt") or (data.get("seed") or {}).get("hunt") or {}
    if not info and not hunt:
        return []
    out = ["## Bug", ""]
    if info.get("id"):
        out.append(f"- **{info['id']}** [{info.get('layer', 'API')}]")
    symptom = " ".join(str(info.get("symptom") or "").split())
    out.append(f"- Symptom: {symptom[:600] or 'not recorded'}")
    out.append(f"- Root cause: {info.get('root_cause') or 'not recorded (no Gate F plan)'}")
    test = info.get("test") or {}
    out.append(f"- Reproducing test: `{shown_test(test)}`" if test else "- Reproducing test: not recorded")
    mk = state.get("markers") or {}
    ran = (mk.get("e2e") or {}).get("E2E-RESULT")
    needed = any((mk.get(s) or {}).get("E2E") == "yes" for s in ("intake", "plan"))
    out.append(f"- Regression e2e: {'yes (' + ran + ')' if ran else 'yes' if needed else 'no'}")
    if info.get("resets"):
        out.append(f"- Resets: {info['resets']} (two failed fixes each)")
    findings = [str(f) for f in hunt.get("findings") or []]
    if findings:
        where = ", ".join(x for x in (hunt.get("group"), f"hunt {hunt['run']}" if hunt.get("run") else None) if x)
        out.append(f"- Closes {', '.join(findings)}" + (f" ({where})" if where else ""))
    return out + [""]


# ------------------------------------------------------------------ a fix of a hunt finding: its own branch

def branch_name(pattern: str | None, title: str, flow: str) -> str:
    """The branch pattern (settings.branch_pattern, default feat/{slug}) for a flow: {flow} is the workflow id, and a fix
    goes on fix/ where the pattern says feat/ (the api's FlowService.branchName does the same)."""
    slug = re.sub(r"[^a-z0-9]+", "-", str(title).lower()).strip("-")[:40].strip("-") or "x"
    name = str(pattern or "").strip() or "feat/{slug}"
    if flow == "fix" and name.startswith("feat/"):
        name = "fix/" + name[len("feat/"):]
    return name.replace("{slug}", slug).replace("{user}", "keel").replace("{flow}", flow)


def own_worktree(root: str, workflow_id: str, seed: dict, settings: dict | None, title: str) -> dict | None:
    """keel v1 hunt: each finding is drained into its own fix/ branch. A fix that hunt-next started (its seed names the
    hunt) gets a worktree of its own on a new branch from the base branch, instead of stacking on the hunt's branch:
    {root, worktree: {name, branch, base}}, or None (another flow, not a git repository, or git refused)."""
    from ..tools import worktrees
    from .verdict_actions import base_ref

    if workflow_id != "fix" or not (seed or {}).get("hunt"):
        return None
    main = root.split(f"/{worktrees.DIR}/", 1)[0]          # the parent may itself work in a worktree
    if not git.is_repo(main):
        return None
    start = base_ref(main, rules.load_config(main))
    first = branch_name((settings or {}).get("branch_pattern"), title, "fix")
    name, n = first, 2
    while git.git(main, "rev-parse", "--verify", "--quiet", f"refs/heads/{name}").returncode == 0:
        name, n = f"{first}-{n}", n + 1
    slug = re.sub(r"[^a-z0-9]+", "-", str(title).lower()).strip("-")[:30].strip("-") or "fix"
    import uuid

    wt = f"flow-{slug}-{uuid.uuid4().hex[:6]}"
    try:
        made = worktrees.add(main, wt, name, start)
    except worktrees.WorktreeError:
        return None
    return {"root": made["path"], "worktree": {"name": wt, "branch": made["branch"], "base": start or made["base"]}}
