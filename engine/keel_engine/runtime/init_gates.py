"""keel init's two pauses with real content: the three questions (keel v1 skills/init step 2) and the setup plan.

The questions are asked once, with the defaults keel detected. Since 0.19.0 they are a clarify form (clarify_questions:
ids run, services, knowledge; the defaults are the recommended options) and the answers map to the config with
from_answers; an old client's typed answer still goes through the keyword parser (answers). The result is written to
.keel/config.yml (init:), where the librarians read the chosen sections.
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

from ..tools import testcmd

SECTIONS = ["architecture", "domain", "conventions", "data", "integrations"]
SECTION_HELP = {
    "architecture": "modules, layers and how a request flows through them",
    "domain": "the business words and rules",
    "conventions": "how code is written here (naming, errors, tests)",
    "data": "tables, migrations and how data is accessed",
    "integrations": "outside services, queues, files and their contracts",
}
COMPOSE = ("compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml",
           "deploy/docker-compose.yml", "deploy/compose.yml", "docker/docker-compose.yml")


def compose_file(root: str) -> str | None:
    return next((c for c in COMPOSE if (Path(root) / c).is_file()), None)


def existing_sections(root: str) -> list[str]:
    from .knowledge import section_file

    return [s for s in SECTIONS if section_file(root, s).is_file()]


def defaults(root: str, fast: bool = False) -> dict:
    """keel's answers when the user gives none. A fast init writes no knowledge base unless the user names sections."""
    return {"runs_on": "dev container" if (Path(root) / ".devcontainer").is_dir() else "this machine",
            "services": f"use {compose_file(root)}" if compose_file(root) else "none",
            "knowledge_sections": [] if fast else list(SECTIONS)}


RUNS_ON = {"this machine": "the app and its tools run on this computer",
           "dev container": "the app runs in the project's dev container (.devcontainer)",
           "decide later": "keel sets up nothing for this now"}


def clarify_questions(root: str, fast: bool = False) -> list[dict]:
    """0.19.0 the three questions as a clarify form (runtime/clarify.py's shape, fixed ids run / services / knowledge).
    The recommended options are keel's defaults: approving without answers takes them."""
    d = defaults(root, fast)
    have = existing_sections(root)
    comp = compose_file(root)
    if comp:
        services = {"id": "services", "question": f"{comp} exists. Use it for services (databases, queues)?",
                    "why": "keel's ladder starts the services it uses before the tests run.",
                    "options": [{"label": f"use {comp}", "description": "keel starts the services with it",
                                 "recommended": d["services"] == f"use {comp}"},
                                {"label": "I run them myself", "description": "you start the databases and queues yourself",
                                 "recommended": False}]}
    else:
        services = {"id": "services", "question": "No compose file found. How do services (databases, queues) run?",
                    "why": "keel's ladder starts the services it uses before the tests run.",
                    "options": [{"label": "none", "description": "the app needs no services", "recommended": d["services"] == "none"},
                                {"label": "I run them myself", "description": "you start the databases and queues yourself",
                                 "recommended": False},
                                {"label": "generate a compose file", "description": "keel writes one for the services it finds",
                                 "recommended": False}]}
    return [
        {"id": "run", "question": "Where does the app run while you develop?",
         "why": "keel runs the build, the tests and the services there.",
         "options": [{"label": k, "description": v, "recommended": d["runs_on"] == k} for k, v in RUNS_ON.items()]},
        services,
        {"id": "knowledge", "question": "Which knowledge sections should keel write?",
         "why": "More sections cost more tokens now and make the agents better later"
                + (" (a fast init writes none unless you tick some; conventions and data help agents most)." if fast else "."),
         "options": [{"label": sec, "description": SECTION_HELP[sec] + (" (exists)" if sec in have else ""),
                      "recommended": sec in d["knowledge_sections"]} for sec in SECTIONS],
         "multiple": True},
    ]


def from_answers(root: str, given: dict | None, fast: bool = False) -> dict:
    """The init config from the clarify form's answers ({id: label | [labels] | own words}). A question not answered
    keeps keel's default; own words are read like a typed answer (the keyword parser)."""
    a = defaults(root, fast)
    given = given if isinstance(given, dict) else {}
    said: list[str] = []
    run = given.get("run")
    if isinstance(run, list):
        run = run[0] if run else None
    if isinstance(run, str) and run.strip():
        t = run.strip().lower()
        if t in RUNS_ON:
            a["runs_on"] = t
        else:
            a["runs_on"] = answers(root, t, fast)["runs_on"]
            said.append(run.strip())
    srv = given.get("services")
    if isinstance(srv, list):
        srv = srv[0] if srv else None
    if isinstance(srv, str) and srv.strip():
        t = srv.strip().lower()
        comp = compose_file(root)
        if "myself" in t or "my own" in t:
            a["services"] = "I run them myself"
        elif "generate" in t:
            a["services"] = "generate a compose file"
        elif t == "none" or t.startswith("no "):
            a["services"] = "none"
        elif t.startswith("use") and comp:
            a["services"] = f"use {comp}"
        else:
            said.append(srv.strip())
    if "knowledge" in given:
        k = given["knowledge"]
        if isinstance(k, list):
            a["knowledge_sections"] = [sec for sec in SECTIONS if sec in {str(x).strip().lower() for x in k}]
        elif isinstance(k, str) and k.strip():
            a["knowledge_sections"] = [] if re.search(r"\b(no|none)\b", k.lower()) else \
                answers(root, k, fast)["knowledge_sections"]
            said.append(k.strip())
    if said:
        a["said"] = "; ".join(said)[:500]
    return a


def questions(root: str, fast: bool = False) -> str:
    d = defaults(root, fast)
    have = existing_sections(root)
    lines = ["Three questions before keel sets this project up. Approve to use the defaults (in brackets), or answer "
             "in your own words with “Use my answers”, for example: “1 dev container · 2 I run them myself · "
             "3 conventions, data”.", "",
             f"1. Where does the app run while you develop?  this machine / dev container / decide later   [{d['runs_on']}]"]
    comp = compose_file(root)
    if comp:
        lines.append(f"2. {comp} exists. Use it for services (databases, queues)?  use it / I run them myself   [use it]")
    else:
        lines.append("2. No compose file found. Services?  none / I run them myself / generate one   [none]")
    lines.append("3. Which knowledge sections should keel write?  (more sections = more tokens now, better agents later)   "
                 + ("[none: this is a fast init; name the ones you want, conventions and data help agents most]" if fast
                    else "[all five]"))
    for s in SECTIONS:
        lines.append(f"   - {s}: {SECTION_HELP[s]}" + ("  (exists)" if s in have else ""))
    return "\n".join(lines)


def answers(root: str, text: str | None, fast: bool = False) -> dict:
    """The defaults, changed by what the user wrote (free text: words are matched, not a strict format)."""
    a = defaults(root, fast)
    t = (text or "").lower()
    if not t.strip():
        return a
    if "dev container" in t or "devcontainer" in t:
        a["runs_on"] = "dev container"
    elif "later" in t:
        a["runs_on"] = "decide later"
    elif "machine" in t or "local" in t:
        a["runs_on"] = "this machine"
    if "myself" in t or "my own" in t:
        a["services"] = "I run them myself"
    elif "generate" in t:
        a["services"] = "generate a compose file"
    named = [s for s in SECTIONS if re.search(rf"\b{s}\b", t)]
    if re.search(r"\b(no|none) (knowledge|sections)\b|sections?:?\s*none", t):
        a["knowledge_sections"] = []
    elif named:
        a["knowledge_sections"] = named
    a["said"] = text.strip()[:500]
    return a


def plan(root: str, init: dict) -> str:
    cmds = testcmd.config_commands(root)
    cfg_exists = (Path(root) / ".keel" / "config.yml").is_file()
    secs = init.get("knowledge_sections") or []
    from .. import layout

    lay = layout.resolve(root)
    lines = ["keel will do this, in this order. Approve to start; send back to change it.", "",
             f"1. Write .keel/config.yml" + (" — it exists, so it is left as it is" if cfg_exists else ":"),]
    if not cfg_exists:
        block = {"version": 4, "layout": lay.name, **({"commands": cmds} if cmds else {}),
                 "init": {k: v for k, v in init.items() if k != "said"}}
        lines += ["   " + l for l in yaml.safe_dump(block, sort_keys=False).splitlines()]
    lines += [f"2. Run the setup ladder (install, build, tests, services up) and write {lay.runbook} with every "
              "command that passed.",
              f"   test command: {cmds.get('api_test_module') or 'none found — the ladder will say so'}",
              f"   one criterion: {cmds.get('api_test_ac') or '-'}",
              f"   services: {init.get('services')}",
              (f"3. Write the knowledge sections {', '.join(secs)} under {lay.knowledge}/ (one librarian each, every claim "
               "with a file:line citation), at the same time as the ladder." if secs else
               "3. No knowledge sections (you chose none)."),
              f"4. Check that every citation in {lay.knowledge}/ points at a real line.",
              ("5. Commit it all as chore(setup): keel init. Nothing is pushed." if not lay.hidden else
               f"5. Record it (layout {lay.name}: keel's files stay out of git, so there is no commit). Nothing is pushed.")]
    return "\n".join(lines)
