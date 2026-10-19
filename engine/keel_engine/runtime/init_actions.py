"""init's extra code steps (content/workflows/init.yaml).

    git_check     not a git repository (or no commit yet): data.git_question, the git_repo gate asks init / retry /
                  go on without git / stop
    git_init      that gate's init: git init and the first commit (refused for files that look like secrets or
                  dependency folders)
    arch_detect   scores the architecture style (runtime/arch.py); low confidence -> one arch-surveyor item
    arch_set      writes architecture: {style, confidence, source} into .keel/config.yml (the surveyor's ARCH wins)
    ladder_soft   the run ladder as a lane that never fails the step: failing rungs become state.data.failed_rungs and
                  one setup-doctor item for all of them (the doctor is read-only: it diagnoses and proposes a fix)
    rung_report   the rung gate's text after the doctor: the failing rungs, the DIAGNOSIS, the proposed fix and the
                  commands apply_fix would run (data.rung_fix)
    rung_apply    applies the rung gate's answer: apply_fix (run the shown commands), retry, skip (setup.not_checked);
                  then the ladder runs again (stop ends the flow at the gate)
    init_summary  the hand-over's text (data.hand_over_detail): rungs, sections, what was not checked, what next

The ladder steps set the marker LADDER: green | failing (the latest value, "*"), which the init branches read.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

import yaml

from .. import rules
from . import arch
from .actions import ActionInput, ActionResult, ladder


def _marker(a: ActionInput, name: str, value: str, step: str) -> dict:
    mk = dict(a.state.get("markers") or {})
    mk[step] = {**(mk.get(step) or {}), name: value}
    mk["*"] = {**(mk.get("*") or {}), name: value}
    return mk


def _config_file(root: str) -> Path:
    return Path(root) / ".keel" / "config.yml"


def _edit_config(root: str, change) -> dict:
    """Read .keel/config.yml, apply change(dict), write it back (the header comment is kept)."""
    f = _config_file(root)
    text = f.read_text() if f.is_file() else ""
    head = "".join(line + "\n" for line in text.splitlines() if line.startswith("#")) if text else "# Written by keel v2 init. Edit freely.\n"
    cfg = (yaml.safe_load(text) or {}) if text else {"version": 4}
    change(cfg)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(head + yaml.safe_dump(cfg, sort_keys=False))
    return cfg


# ------------------------------------------------------------------ architecture

async def arch_detect(a: ActionInput) -> ActionResult:
    r = await asyncio.to_thread(arch.detect, a.root)
    survey = r["confidence"] == "low" and not a.settings.get("fast")
    items = [{"id": "architecture", "detection": {k: r.get(k) for k in ("style", "confidence", "hybrid_with", "evidence")},
              "modules": {d: {"style": m["style"], "confidence": m["confidence"], "scores": m["scores"]}
                          for d, m in (r.get("modules") or {}).items()},
              "question": "Detection is not sure. Which style does this codebase follow in practice? End with ARCH: <style> <confidence>."}] \
        if survey else []
    note = f"architecture: {r['style']} ({r['confidence']})" + (" · asking the arch-surveyor" if survey else "")
    return ActionResult(True, note, "\n".join(r.get("evidence") or []),
                        {"data": {**a.data, "arch": r, "arch_items": items}})


async def arch_set(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_arch_set, a)


def _arch_set(a: ActionInput) -> ActionResult:
    found = a.data.get("arch") or {}
    said = ((a.state.get("markers") or {}).get("arch_survey") or {}).get("ARCH") or ""
    words = said.lower().split()
    style, conf, source = found.get("style") or "unknown", found.get("confidence") or "low", "detected"
    if words and words[0] in [*arch.STYLES, "unknown"]:
        style, source = words[0], "surveyed"
        conf = words[1] if len(words) > 1 and words[1] in ("high", "medium", "low") else conf
    have = (rules.load_config(a.root) or {}).get("architecture") or {}
    if _config_file(a.root).is_file() and have.get("style") and have.get("source") not in ("detected", "surveyed"):
        return ActionResult(True, f"architecture: {have['style']} (set in .keel/config.yml; left as it is)")
    block = {"style": style, "confidence": conf, "source": source}
    if found.get("hybrid_with") and source == "detected":
        block["hybrid_with"] = found["hybrid_with"]

    def change(cfg):
        cfg["architecture"] = {**(cfg.get("architecture") or {}), **block}
    _edit_config(a.root, change)
    return ActionResult(True, f"architecture: {style} ({conf}, {source}) written to .keel/config.yml")


# ------------------------------------------------------------------ ladder repair

# The setup-doctor is read-only (content/agents/setup-doctor.md): it proposes, the person decides. The commands it
# wants keel to run come in one fenced block; the rung gate shows them and `apply_fix` runs them.
FIX_BLOCK = re.compile(r"```[ \t]*keel-fix[ \t]*\n(.*?)\n?[ \t]*```", re.S | re.I)
DOCTOR_ASK = ("These setup ladder rungs fail. First look for a cause they share (one wrong host, port, environment "
              "variable, folder or missing tool often breaks several rungs at once; inside keel's container 'localhost' "
              "is the container itself, the host is 'host.docker.internal'). You change nothing: run read-only "
              "diagnostics, then say per rung the cause, the evidence and the exact fix, and whether the fix changes the "
              "machine, repo files or nothing. Never propose editing application code. When keel can apply the fix "
              "with shell commands in the project folder, put them in one ```keel-fix block (one command per line); "
              "the person sees them and decides. End with DIAGNOSIS: fixable | needs-you | unknown.")


def _audit_detail(rungs: list[dict]) -> str:
    ran = [r for r in rungs if r.get("status") == "pass"]
    return (f"The ladder checked liveness only: {len(ran)} of {len(rungs)} steps passed, and none of them asked whether "
            "an endpoint behaves correctly. A bug hunt takes about 10-20 minutes and costs tokens.\n\n"
            "skip: hand over now; the backlog stays empty and nothing checked behaviour.\n"
            "hunt: start a bug hunt now (semi mode, whole project). It changes no code: hunters propose, provers "
            "reproduce against the running stack, and only what reproduces is reported.\n\n"
            "Only you can answer this: keel never decides it by itself, in any run mode.")


async def _ladder_state(a: ActionInput, step: str, extra: dict | None = None) -> ActionResult:
    """Run the ladder; failing rungs -> failed_rungs, one setup-doctor item and the rung question; LADDER green | failing."""
    r = await ladder(a)
    rungs = r.update.get("ladder") or []
    failed = [x for x in rungs if x.get("status") == "fail"]
    base = {**a.data, **(extra or {})}
    attempts = dict(base.get("rung_attempts") or {})
    for x in failed:
        attempts[str(x["n"])] = attempts.get(str(x["n"]), 0) + 1
    data = {**base, "rung_attempts": attempts, "rung_question": None, "rung_fix": [],
            "audit_now_detail": _audit_detail(rungs)}
    data["failed_rungs"] = [{"id": f"rung-{x['n']}", "n": x["n"], "name": x["name"], "cmd": x["cmd"], "detail": x.get("detail"),
                             "attempts": attempts.get(str(x["n"]), 0)} for x in failed]
    # 0.18.15 ONE setup-doctor for all failing rungs, always the same item id: failing rungs often share one cause (a
    # wrong host, port, env or tool), one agent finds it once instead of ten agents each exploring from zero, and the
    # next round resumes the same agent's session (agent memory keys on the item), so it keeps what it learned.
    data["doctor_items"] = [{
        "id": "failing-rungs", "whole": True, "name": f"{len(failed)} failing rung{'s' if len(failed) != 1 else ''}",
        "rungs": data["failed_rungs"], "ask": DOCTOR_ASK}] if failed else []
    if failed:
        x = failed[0]
        data["rung_question"] = {"n": x["n"], "name": x["name"], "cmd": x["cmd"], "detail": x.get("detail"),
                                 "rungs": [y["n"] for y in failed]}
    value = "failing" if failed else "green"
    note = r.note + (" · the setup doctor looks at it" if failed else "")
    return ActionResult(True, note, r.detail, {"ladder": rungs, "data": data, "markers": _marker(a, "LADDER", value, step)})


async def ladder_soft(a: ActionInput) -> ActionResult:
    return await _ladder_state(a, "ladder", {"rung_attempts": {}, "rung_fix_log": None})


async def ladder_retry(a: ActionInput) -> ActionResult:
    """Runs the ladder again (kept for flows written before 0.18.22; init now asks after each doctor round)."""
    if not a.data.get("failed_rungs"):
        return ActionResult(True, "the ladder is green", update={"markers": _marker(a, "LADDER", "green", "ladder_retry")})
    return await _ladder_state(a, "ladder_retry")


def fix_commands(text: str) -> list[str]:
    """The commands of the doctor's last keel-fix block (comments and blank lines left out)."""
    blocks = FIX_BLOCK.findall(text or "")
    if not blocks:
        return []
    out = []
    for line in blocks[-1].splitlines():
        line = line.strip()
        if line.startswith("$ "):
            line = line[2:].strip()
        if line and not line.startswith("#"):
            out.append(line)
    return out[:10]


def _doctor_text(text: str) -> str:
    """The doctor's report without its keel-fix block (shown on its own) and its DIAGNOSIS line, trimmed."""
    text = FIX_BLOCK.sub("", text or "")
    text = re.sub(r"(?im)^\s*DIAGNOSIS:.*$", "", text).strip()
    return text if len(text) <= 3000 else text[:3000].rsplit("\n", 1)[0] + "\n…"


async def rung_report(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_rung_report, a)


def _rung_report(a: ActionInput) -> ActionResult:
    """After the setup-doctor: the rung gate's text (the failing rungs, the DIAGNOSIS, the proposed fix, what it
    changes) and the commands apply_fix would run (data.rung_fix). Without commands the gate has no apply_fix."""
    q = a.data.get("rung_question") or {}
    if not q:
        return ActionResult(True, "no rung to decide")
    results = [x for x in a.data.get("doctor_results") or [] if isinstance(x, dict)]
    said = results[-1] if results else {}
    text = str(said.get("text") or "")
    diagnosis = str((said.get("markers") or {}).get("DIAGNOSIS") or "").strip().lower() or "unknown"
    cmds = fix_commands(text)
    lines = []
    for x in a.data.get("failed_rungs") or []:
        lines += [f"Rung {x['n']} ({x['name']}) failed" + (f" {x['attempts']} time(s)" if x.get("attempts", 0) > 1 else "") + ":",
                  f"$ {x['cmd']}", str(x.get("detail") or "").strip()[-1200:], ""]
    if a.data.get("rung_fix_log"):
        lines += ["What the last fix did:", str(a.data["rung_fix_log"])[-1500:], ""]
    lines.append(f"The setup doctor's DIAGNOSIS: {diagnosis}" + {
        "fixable": " (it found the cause and a fix)", "needs-you": " (the fix needs you: the machine or a decision)",
        "unknown": " (it did not find the cause)"}.get(diagnosis, ""))
    report = _doctor_text(text)
    if report:
        lines += ["", report]
    if cmds:
        lines += ["", "The proposed fix (apply_fix runs these in the project folder, one after the other):",
                  *[f"$ {c}" for c in cmds]]
    else:
        lines += ["", "The doctor proposed no command keel can run: fix it yourself, then choose retry."]
    lines += ["", ("apply_fix: keel runs the commands above, then the ladder again.\n" if cmds else "")
              + "retry: you fixed it (or it was a passing problem); the ladder runs again and the doctor looks again if it "
                "still fails.\n"
              + f"skip: keep rung {q['n']} but mark it as not checked (setup.not_checked); the ladder goes on with the next rungs.\n"
              + "stop: end init here; nothing after the ladder runs (no knowledge check, no commit)."]
    data = {**a.data, "rung_fix": cmds, "rung_gate_detail": "\n".join(lines).strip(),
            "rung_gate_without": [] if cmds else ["apply_fix"]}
    note = f"rung {q['n']}: DIAGNOSIS {diagnosis}" + (f", {len(cmds)} fix command(s) proposed" if cmds else ", no command proposed")
    return ActionResult(True, note, update={"data": data})


# A fix keel never runs, even when the person chose apply_fix: the guard's destructive commands (rules.DESTRUCTIVE, every
# phase), and on top of them for a setup fix any rm -f, git reset / clean / checkout / push (the doctor is told so too).
SETUP_ONLY = re.compile(r"\brm\s+-[a-z]*f|\bgit\s+(reset|clean|checkout|push)\b", re.I)


def _destructive(cmd: str) -> bool:
    return bool(rules.destructive(cmd) or SETUP_ONLY.search(cmd))


def _apply_fix(a: ActionInput, cmds: list[str]) -> str:
    """Runs the shown fix commands (the guard's setup-phase rules refuse what this phase may not do). Stops at the first
    failure. Returns what happened, for the note and the next rung gate."""
    from ..tools import testcmd
    from ..tools.agent_tools import command_env

    cfg = rules.load_config(a.root)
    out = []
    for cmd in cmds:
        if _destructive(cmd):
            out.append(f"$ {cmd}\nrefused: keel does not run a command that deletes data or history; run it yourself "
                       "if you are sure, then choose retry")
            break
        v = rules.check_bash(a.phase or "setup", cmd, cfg, exists=lambda rel: (Path(a.root) / rel).exists())
        if not v.ok:
            out.append(f"$ {cmd}\nrefused: {v.reason}")
            break
        if a.fake:
            out.append(f"$ {cmd}\n(simulated)")
            continue
        code, text = testcmd.run(a.root, cmd, 900, command_env())
        out.append(f"$ {cmd}\nexit {code}" + (f"\n{text.strip()[-600:]}" if text.strip() else ""))
        if code:
            break
    return "\n".join(out)


# answers given before 0.18.22 (fix / exclude / accept) still apply
OLD_CHOICES = {"fix": "retry", "accept": "skip"}


async def rung_apply(a: ActionInput) -> ActionResult:
    ans = a.data.get("rung_gate_answer") or {}
    q = a.data.get("rung_question") or {}
    if not ans or not q:
        return ActionResult(True, "nothing to apply")
    n = int(q["n"])
    said = str(ans.get("choice") or "retry")
    choice = OLD_CHOICES.get(said, said)
    extra: dict = {"rung_gate_answer": None, "rung_fix_log": None}
    if choice == "apply_fix":
        cmds = [str(c) for c in a.data.get("rung_fix") or []]
        extra["rung_fix_log"] = await asyncio.to_thread(_apply_fix, a, cmds) if cmds else "no fix command to run"
    elif choice in ("skip", "exclude"):
        key = "ladder_exclude" if choice == "exclude" else "not_checked"
        rungs = {n, *[int(x) for x in q.get("rungs") or [] if str(x).isdigit()]}

        def change(cfg):
            setup = cfg.setdefault("setup", {})
            setup[key] = sorted({*[int(x) for x in setup.get(key) or [] if str(x).isdigit()], *rungs})
        await asyncio.to_thread(_edit_config, a.root, change)
    a.data = {**a.data, "rung_gate_answer": None}
    r = await _ladder_state(a, "rung_apply", extra)
    r.note = f"rung {n}: {said}" + (f" ({ans.get('why')})" if ans.get("why") else "") + " · " + r.note
    if extra.get("rung_fix_log"):
        r.detail = f"{extra['rung_fix_log']}\n\n{r.detail}".strip()
    return r


# ------------------------------------------------------------------ git repo

# keel v1 BACKLOG: a `git init` with no first commit left verdicts keyed to no commit, and a commit in such a repo would
# sweep the whole untracked project into it. So the first commit is only ever the person's choice, and it refuses
# files that look like secrets or dependency folders (they belong in .gitignore first).
NOT_FIRST = re.compile(r"(^|/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*)$|(^|/)(node_modules|\.venv|venv|vendor|target|"
                       r"build|dist)/", re.I)
NOT_FIRST_OK = re.compile(r"(^|/)\.env\.(example|sample|template|dist)$", re.I)


def _untracked(root: str) -> list[str]:
    from ..tools import git

    out = git.git(root, "ls-files", "--others", "--exclude-standard").stdout if git.is_repo(root) else ""
    return [f for f in out.splitlines() if f and f != ".keel" and not f.startswith(".keel/")]


async def git_check(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_git_check, a)


def _git_check(a: ActionInput) -> ActionResult:
    """keel v1's blocking git question: not a git repository, or one without a commit yet. Without a commit nothing can
    be committed and no verdict can name the code it checked; data.git_question makes the git_repo gate ask."""
    from ..tools import git

    repo = git.is_repo(a.root)
    if repo and git.head(a.root):
        return ActionResult(True, "a git repository", update={"data": {**a.data, "git_question": None, "git_ready": True}})
    top = sorted({p.name for p in Path(a.root).iterdir() if p.name not in (".git", ".keel")}) if Path(a.root).is_dir() else []
    what = ("This folder is not a git repository." if not repo else
            "This git repository has no commit yet (its project files are untracked).")
    detail = (f"{what} keel commits each step (the setup commit at the end of init) and stamps every verdict with a "
              "commit, so without one nothing is committed and no verdict says which code it checked.\n\n"
              f"In this folder ({len(top)} entries): {', '.join(top[:20])}{' …' if len(top) > 20 else ''}"
              + ("" if (Path(a.root) / ".gitignore").is_file() else "\nThere is no .gitignore: add one first if build "
                 "output or dependencies sit here.") + "\n\n"
              + ("init: " + ("run git init and " if not repo else "") + "commit the project as it is now as the first "
                 "commit (chore: initial commit). keel refuses when a file looks like a secret or a dependency folder.\n")
              + "retry: you made the repository and its first commit yourself; keel looks again.\n"
              "go_on: go on without commits; nothing is committed, and the hand-over says so.\n"
              "stop: end init here, for example to clone or open the right folder first.")
    return ActionResult(True, what, update={"data": {**a.data, "git_question": True, "git_ready": None,
                                                    "git_repo_detail": detail}})


async def git_init(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_git_init, a)


def _git_init(a: ActionInput) -> ActionResult:
    """When the git_repo gate's answer was init: git init (if needed) and the project's first commit, refused when a
    file looks like a secret or a dependency folder (the gate asks again and says which)."""
    from .. import rules as rules_mod
    from ..tools import git
    from .actions import commit_args

    if (a.data.get("git_repo_answer") or {}).get("choice") != "init":
        return ActionResult(True, "nothing to do")
    data = {**a.data, "git_repo_answer": None}
    if not git.is_repo(a.root):
        r = git.git(a.root, "init", "-q")
        if r.returncode:
            return ActionResult(False, "git init failed", (r.stderr or r.stdout or "").strip()[-1000:])
    files = _untracked(a.root)
    bad = [f for f in files if NOT_FIRST.search(f) and not NOT_FIRST_OK.search(f)]
    if bad or not files:
        why = (f"keel did not make the first commit: {len(bad)} file(s) look like secrets or dependencies: "
               + ", ".join(bad[:10]) + (" …" if len(bad) > 10 else "") + ". Add them to .gitignore (or remove them), "
               "then choose init again." if bad else "keel did not make the first commit: there is no file to commit.")
        detail = f"{why}\n\n{a.data.get('git_repo_detail') or ''}".strip()
        return ActionResult(True, why[:300], update={"data": {**data, "git_question": True, "git_ready": None,
                                                              "git_repo_detail": detail}})
    git.git(a.root, "add", "-A", "--", ".", ":!.keel")
    ident, trailer = commit_args(a.root, a.settings, rules_mod.load_config(a.root))
    r = git.git(a.root, *ident, "commit", "-q", "-m", "chore: initial commit", *trailer)
    if r.returncode:
        git.git(a.root, "reset", "-q")
        return ActionResult(False, "the first commit failed", (r.stderr or r.stdout or "").strip()[-1000:])
    return ActionResult(True, f"git: first commit of {len(files)} file(s)",
                        update={"data": {**data, "git_question": None, "git_ready": True}})


# ------------------------------------------------------------------ hand over

NEXT_FLOWS = [("change", "a small change to existing behaviour"), ("feature", "a new feature, spec first"),
              ("fix", "a bug: a failing test first, then the fix"),
              ("knowledge-refresh", "write the knowledge sections again after the code changed")]


async def init_summary(a: ActionInput) -> ActionResult:
    return await asyncio.to_thread(_init_summary, a)


def _init_summary(a: ActionInput) -> ActionResult:
    """The hand-over's text (data.hand_over_detail): the rungs passed / not checked, the knowledge sections written or
    kept, what was not checked, the fast-init warning, and the flows to start next."""
    from .. import layout
    from ..tools import git
    from . import init_gates

    rungs = a.state.get("ladder") or []
    by = lambda st: [r for r in rungs if r.get("status") == st]  # noqa: E731
    passed, skipped, failed = by("pass"), by("skipped"), by("fail")
    unchecked = [r for r in skipped if "not checked" in str(r.get("detail") or "") or "excluded" in str(r.get("detail") or "")]
    init = a.init or {}
    written = [s for s in (init.get("write_sections") if "write_sections" in init else init.get("knowledge_sections")) or []]
    kept = [s for s in init_gates.existing_sections(a.root) if s not in written]
    lay = layout.resolve(a.root)
    lines = [f"Setup ladder: {len(passed)} of {len(rungs)} rungs passed, {len(skipped)} skipped"
             + (f", {len(failed)} still failing" if failed else "") + f". The commands that passed are in {lay.runbook_file()}."]
    for r in unchecked:
        lines.append(f"  not checked: rung {r['n']} {r['name']} ({r.get('detail')})")
    for r in failed:
        lines.append(f"  failing: rung {r['n']} {r['name']} ($ {r.get('cmd')})")
    lines.append("Knowledge: " + (f"wrote {', '.join(written)}" if written else "wrote no section")
                 + (f"; kept {', '.join(kept)} as they were" if kept else "") + f" (in {lay.knowledge}/).")
    lines.append(f"Layout: {lay.name} — " + ("keel's files are committed with the code (docs/)." if lay.name == "repo"
                                             else "keel's files stay in .keel/, out of git."))
    lines += ["", "Not checked:", "- behaviour: the ladder checks that things start, not that endpoints do the right thing "
              "(a bug hunt checks behaviour)."]
    lines += [f"- rung {r['n']} {r['name']}" for r in unchecked + [r for r in skipped if r not in unchecked and r["n"] in ladder_optional()]]
    if not git.is_repo(a.root) or not git.head(a.root):
        lines.append("- git: this folder is not a git repository with a commit, so nothing was committed and verdicts "
                     "carry no commit.")
    if a.settings.get("fast"):
        lines += ["", "This was a fast init: rungs that passed before were re-used, so the services may not be running. "
                  "Start the stack (the services rung's command) before a bug hunt, or provers report every finding "
                  "as unproven."]
    lines += ["", "What next (start a flow):", *[f"- {name}: {about}" for name, about in NEXT_FLOWS],
              "", "Approve to finish init."]
    return ActionResult(True, "hand-over summary ready", update={"data": {**a.data, "hand_over_detail": "\n".join(lines)}})


def ladder_optional() -> set[int]:
    from . import ladder as run_ladder

    return set(run_ladder.OPTIONAL)


ACTIONS = {"arch_detect": arch_detect, "arch_set": arch_set, "ladder_soft": ladder_soft, "ladder_retry": ladder_retry,
           "rung_apply": rung_apply, "rung_report": rung_report, "git_check": git_check,
           "git_init": git_init, "init_summary": init_summary}
