"""keel 0.18.57 project standards: the instructions and skills a repo keeps for coding agents.

Many repos carry their own rules for agents: AGENTS.md, CLAUDE.md, .github/copilot-instructions.md, an onboarding doc,
.cursor/rules/*, and skills in .claude/skills/*/SKILL.md or .opencode/skills/*/SKILL.md. init and knowledge-refresh
(action project_rules) find them and

  - write a short "Project rules" page into the knowledge folder (<knowledge>/project-rules.md): each doc with its
    title, each skill with what it is for and who loads it. Every agent's prompt names the docs (prompts.task_prompt).
  - record them in .keel/project-rules.json. The api reads it (SkillService: source "repo"): a skill a doc says to load
    "when writing tests" (or whose own description says it is for tests) is loaded by the agents that write tests
    (test-author, and the implementer, which writes tests in quick and address); one a doc names for other work by the
    implementer; any other is listed, on no agent. Skills › Found in the repo shows them, with an off switch.

keel's own files (.keel/, keel's block in CLAUDE.md) are not the project's rules: .keel is never read here.
"""

from __future__ import annotations

import datetime
import json
import re
from pathlib import Path

from .. import layout
from ..marketplace.kinds import split_front

# The docs, in the order they are listed: the common names first, then the folders of rule files.
DOCS = ("AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md", "docs/ONBOARDING.md", "ONBOARDING.md",
        "docs/onboarding.md", "CONTRIBUTING.md", "docs/CONTRIBUTING.md", "docs/AGENTS.md", ".cursorrules", ".windsurfrules")
DOC_DIRS = (".github/instructions", ".cursor/rules", ".windsurf/rules", ".clinerules")
DOC_EXT = (".md", ".mdc", ".txt")
SKILL_DIRS = (".claude/skills", ".opencode/skills", ".opencode/skill", ".github/skills", ".agents/skills", ".cursor/skills")
MAX_DOC = 256 * 1024        # a bigger file is listed, not read
MAX_FILES = 40              # rule files per folder

RECORD = ".keel/project-rules.json"
PAGE = "project-rules.md"

USES = {"tests": ["test-author", "implementer"], "implementation": ["implementer"]}
_TESTS = re.compile(r"\b(tests?|testing|tested|specs?|unit|integration|e2e|end-to-end|playwright|cypress|phpunit|pytest|"
                    r"jest|vitest|junit|test data|fixtures?)\b", re.I)
_CODE = re.compile(r"\b(load|use|read|follow|apply|see|invoke|consult)\b", re.I)
_IMPLEMENT = re.compile(r"\b(implement\w*|writing code|code changes?|new (endpoints?|features?|modules?|services?))\b", re.I)


def _read(p: Path) -> str:
    try:
        return p.read_text(errors="replace") if p.stat().st_size <= MAX_DOC else ""
    except OSError:
        return ""


def _title(text: str) -> str:
    fm, body = split_front(text)
    if fm.get("description"):
        return str(fm["description"]).strip()[:100]
    for line in body.splitlines()[:30]:
        m = re.match(r"^\s*#{1,3}\s+(.+?)\s*#*\s*$", line)
        if m:
            return m.group(1)[:100]
    first = next((x.strip() for x in body.splitlines() if x.strip()), "")
    return first[:100]


def _docs(root: Path) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []

    def add(rel: str) -> None:
        p = root / rel
        key = str(p.resolve()).lower() if p.exists() else rel.lower()
        if key in seen or not p.is_file():
            return
        seen.add(key)
        out.append({"path": rel, "title": _title(_read(p))})

    for rel in DOCS:
        add(rel)
    for d in DOC_DIRS:
        folder = root / d
        if folder.is_dir():
            for f in sorted(folder.iterdir())[:MAX_FILES]:
                if f.is_file() and f.suffix.lower() in DOC_EXT:
                    add(f"{d}/{f.name}")
    return out


def _skills(root: Path) -> list[dict]:
    out: dict[str, dict] = {}
    for d in SKILL_DIRS:
        folder = root / d
        if not folder.is_dir():
            continue
        for sub in sorted(folder.iterdir()):
            f = sub / "SKILL.md"
            if not f.is_file():
                continue
            fm, _body = split_front(_read(f))
            name = str(fm.get("name") or sub.name).strip()
            if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name) or name in out:
                continue
            out[name] = {"name": name, "path": f"{d}/{sub.name}/SKILL.md", "about": str(fm.get("description") or "").strip()[:300]}
    return [out[k] for k in sorted(out)]


def _mention(name: str, docs: list[dict], root: Path) -> tuple[str | None, str]:
    """What the docs say a skill is for: the first line that names it and says when (tests, or other work)."""
    word = re.compile(rf"(?<![\w-]){re.escape(name)}(?![\w-])", re.I)
    for d in docs:
        for line in _read(root / d["path"]).splitlines():
            if not word.search(line):
                continue
            rest = word.sub(" ", line)
            said = f"{d['path']}: \"{line.strip()[:160]}\""
            if _TESTS.search(rest):
                return "tests", said
            if _CODE.search(rest) or _IMPLEMENT.search(rest):
                return "implementation", said
    return None, ""


def discover(root: str | Path) -> dict:
    """The docs ({path, title}) and skills ({name, path, about, use, why, agents}) this repo keeps for coding agents."""
    r = Path(root)
    docs = _docs(r)
    skills = []
    for s in _skills(r):
        use, why = _mention(s["name"], docs, r)
        if not use:
            about = s["about"]
            if _TESTS.search(about):
                use, why = "tests", "its description"
            elif _IMPLEMENT.search(about):
                use, why = "implementation", "its description"
        skills.append({**s, "use": use, "why": why, "agents": list(USES.get(use or "", []))})
    return {"docs": docs, "skills": skills}


def page(found: dict) -> str:
    """The knowledge page: each doc with its title, each skill with what it is for and who loads it."""
    lines = ["# Project rules", "",
             "This project keeps its own rules for coding agents. Read the ones that fit your task before you change "
             "code; keel's rules still decide what may change in each phase. keel finds them at init and at a knowledge "
             "refresh.", ""]
    if found["docs"]:
        lines += ["## Instructions", ""] + [f"- `{d['path']}`" + (f": {d['title']}" if d["title"] else "") for d in found["docs"]] + [""]
    if found["skills"]:
        lines += ["## Skills", ""]
        for s in found["skills"]:
            head = f"- `{s['name']}` (`{s['path']}`)" + (f": {s['about']}" if s["about"] else "")
            if s["use"]:
                what = "for tests" if s["use"] == "tests" else "for code changes"
                lines.append(f"{head} — {what} ({s['why']}); loaded by {', '.join(s['agents'])}")
            else:
                lines.append(f"{head} — on no agent: nothing says when to load it (attach it on the Skills page)")
        lines += ["", "Who loads a skill, or none of them: Skills › Found in the repo.", ""]
    return "\n".join(lines).rstrip() + "\n"


def record(root: str | Path) -> dict | None:
    """What the last discovery recorded (.keel/project-rules.json), None before one ran."""
    try:
        data = json.loads((Path(root) / RECORD).read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def page_path(root: str | Path) -> str:
    return f"{layout.resolve(root).knowledge}/{PAGE}"


def project_rules_action(a):
    """init and knowledge-refresh: find the project's rules, write the knowledge page and the api's record."""
    from .flow_actions import _ok

    root = Path(a.root)
    found = discover(root)
    rec = root / RECORD
    rec.parent.mkdir(parents=True, exist_ok=True)
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rec.write_text(json.dumps({"version": 1, "found_at": now, **found}, indent=2) + "\n")
    target = root / page_path(root)
    if found["docs"] or found["skills"]:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(page(found))
        attached = sum(1 for s in found["skills"] if s["agents"])
        note = f"project rules: {len(found['docs'])} doc(s), {len(found['skills'])} skill(s), {attached} attached"
    else:
        if target.is_file() and target.read_text(errors="replace").startswith("# Project rules"):
            target.unlink()
        note = "project rules: none found"
    return _ok(note, update={"data": {**a.data, "project_rules": found}})


async def project_rules(a):
    import asyncio

    return await asyncio.to_thread(project_rules_action, a)


def prompt_line(root: str | Path) -> str:
    """One line for every agent's prompt: the project's own rule docs, and where the pointers are."""
    rec = record(root)
    docs = [d.get("path") for d in (rec or {}).get("docs") or [] if isinstance(d, dict) and d.get("path")]
    if not docs:
        return ""
    where = page_path(root)
    ptr = f" (pointers: {where})" if (Path(root) / where).is_file() else ""
    more = f" and {len(docs) - 8} more" if len(docs) > 8 else ""
    return f"This project's own rules for coding agents: {', '.join(docs[:8])}{more}{ptr}. Follow them where keel's rules allow."


def hand_over_lines(found: dict | None, root: str | Path) -> list[str]:
    """init's hand-over: what was found, and which agents load each skill."""
    if not found or not (found.get("docs") or found.get("skills")):
        return ["Project rules: no instructions or skills for coding agents found in the repo (AGENTS.md, CLAUDE.md, "
                ".claude/skills, …)."]
    docs = [d["path"] for d in found.get("docs") or []]
    skills = found.get("skills") or []
    head = "Project rules: "
    head += (f"{len(docs)} doc(s) for coding agents ({', '.join(docs[:3])}{', …' if len(docs) > 3 else ''})" if docs
             else "no instruction docs")
    head += f" and {len(skills)} skill(s) in the repo" if skills else ", no skills in the repo"
    out = [head + f" (pointers: {page_path(root)})."]
    for s in skills:
        if s.get("agents"):
            what = "for tests" if s.get("use") == "tests" else "for code changes"
            out.append(f"- {s['name']}: {what}, attached to {', '.join(s['agents'])}")
        else:
            out.append(f"- {s['name']}: found, on no agent (nothing says when to load it)")
    if skills:
        out.append("Change who loads them, or turn them off, on the Skills page (Found in the repo).")
    return out
