"""KeelBot's view of keel itself: the project's workflows, the flows that run now, and the buttons it may give.

The api sends `keel` with every turn (the plugin's api, Helper.kt keelContext): the workflows the project can run and
its recent flows. KeelBot uses them to say which workflow fits a piece of work, to answer questions about a running
flow, and to write a new workflow. It never starts or saves anything itself: it ends its answer with an action block,
and the panel turns that into a button the person presses (the plugin's web, Actions.tsx):

    ```keel-start                      ```keel-workflow
    {"workflow": "feature", ...}       id: ...            (a whole workflow: keel checks it, then offers Save)
    ```                                ```

    ```keel-flow {"do": "approve" | "reject" | "stop" | "mode", ...}```   decide a gate, stop flows, a run mode
    ```keel-flow {"do": "answer", "flow", "answers" | "choice" + "why"}``` propose the answer to a flow's question

    keel_block(keel, question)   the prompt block: workflows, flows, how to give buttons, what each part that is on
                                 says (its `keelbot` words, keel_engine/extensions.py), and (only when the question is
                                 about writing a workflow) the format, the phases, actions and agents to use
    pr_body_sections(thread_id)  its commits in the PR body and the final review (the part's hook, __init__.py)
"""

from __future__ import annotations

import re
from pathlib import Path

from keel_engine import addons, extensions, formats

# One line per keel template (docs/GUIDE.md "Flows in detail"): what it is for.
ABOUT = {
    "feature": "a new feature with a spec: spec (questions) → plan → contract → per criterion a failing test, the code "
               "and a review (you approve each) → security, full review, e2e, smoke → ship",
    "change": "a small change without a spec: trivial (one commit) or 1–3 criteria with tests; too big → hands over to "
              "feature",
    "quick": "the smallest code change (a typo, a small bug, a config value): one agent makes it and a test → keel runs "
             "the tests → you look at the diff once → one commit; a few steps, no spec, no ship",
    "small": "a small feature, test-first, without ship: a short plan with 1–3 criteria you approve → per criterion a "
             "failing test and the code → one review → your one look",
    "implement": "the usual order, not test-first: the code → its tests → keel runs them; pass → one commit and done, "
                 "fail → a fix and the tests again; no gate",
    "fix": "a bug you can describe: reproduce it as a failing test → find the cause → fix → regression test → ship",
    "diagnose": "a bug you cannot reproduce yet: 3–4 guesses, one investigator each → hands over to fix or feature",
    "review": "read-only review of the branch, one reviewer per lens (code, security, performance, ...); a report",
    "lint": "run the project's formatters and linters, fix the findings without changing behaviour, one commit",
    "cover": "test coverage of the changed lines: per gap write a test, delete dead code, or accept it with a reason",
    "ship": "get a branch ready: checks, coverage, dependencies, reviews, final review, the PR body (never pushes)",
    "hunt": "read-only bug hunt: hunters per lens, provers reproduce each candidate, a report",
    "hunt-next": "take the top bug of the last hunt into a fix flow",
    "init": "set a project up for keel: architecture, setup checks, knowledge pages",
    "knowledge-refresh": "refresh the project's knowledge pages (docs/knowledge/ or .keel/knowledge/)",
    "plugin": "build a keel plugin in plugins/<name>/: its spec → keel-plugin new → per criterion a failing test and the "
              "code → keel-plugin lint → the plugin's tests → review",
}

MAX_FLOWS = 8
WRITE_WORDS = re.compile(r"\b(new|make|create|write|generate|build|own|change|edit|save|automat\w*|custom)\b", re.I)
ABOUT_WORKFLOW = re.compile(r"\bwork ?flows?\b", re.I)
ABOUT_RULE = re.compile(r"\brules?\b|\brule ?packs?\b|\bguard\b|\bforbid|\bblock\b", re.I)
ABOUT_AGENT = re.compile(r"\bagents?\b|\bsub-?agents?\b", re.I)
ABOUT_SKILL = re.compile(r"\bskills?\b|\bskill\.md\b", re.I)
ABOUT_STACK = re.compile(r"\bstacks?\b|\bhow (this|the) project (builds|tests)\b", re.I)

ACTIONS = """Buttons (actions). You never start or save anything yourself: you give the person a button, and nothing \
happens until they press it. Put each one as its own fenced block at the end of your answer:
- Start a flow:
```keel-start
{"workflow": "<an id from the list>", "title": "<one short line>", "request": "<what to build or fix, in the person's \
words, with the details you agreed>"}
```
- A new workflow (keel checks it and shows Save): the whole workflow YAML in a fenced block with the info string \
keel-workflow.
- A new rule pack (keel checks it, shows what it would have refused lately, then Save): its YAML in a keel-rule block.
- A new agent (Save adds it to the project; workflows use it with `agent: <id>`): its JSON in a keel-agent block.
- A new skill (know-how an agent reads before it works; Save adds it to the project): its whole SKILL.md in a \
keel-skill block; its front matter may name the agents that should load it, as `agents: [<id>, <id>]`.
- A new stack (how this project builds and tests: its lane, the files that detect it, test layers, the project's own \
commands and tools; keel checks it, then Save writes .keel/stacks/<name>.yml): its whole YAML in a keel-stack block.
- A question for the person, when you need their choice before you can go on (keel 0.18.9): one keel-questions block \
with up to 4 questions, each 2 to 4 options, the recommended one first with "recommended": true, and "multiple": true \
when several options can be true together. The person picks (or writes their own answer) and the answers come back as \
your next message. Whenever the person must choose between options, ask with this block: never write the choice as a \
question in your text ("A or B?"), and do not go on as if they had chosen:
```keel-questions
[{"id": "<short word>", "question": "<the question>", "why": "<what the answer changes>", \
"options": [{"label": "<option>", "description": "<what it costs>", "recommended": true}, {"label": "<option>"}]}]
```
- Decide a gate, stop flows, or change a flow's run mode (the flow ids are in the flows list above; the person sees \
the button and presses it, so offer it whenever they ask for one of these, never say you cannot):
```keel-flow
{"do": "approve", "flow": "<flow id>"}
```
```keel-flow
{"do": "reject", "flow": "<flow id>", "why": "<the reason the agent gets>"}
```
```keel-flow
{"do": "stop", "flows": ["<flow id>", "<flow id>"]}
```
```keel-flow
{"do": "mode", "flow": "<flow id>", "mode": "manual | important | auto | readonly"}
```
- Propose the answer to the question a flow waits at (keel 0.18.13; the person sees your answer on a card and presses \
Send, nothing is sent before): for a flow that asks questions, your answers by question id (a label, a list of labels \
for a question that takes several, or your own words); for a gate with named choices, the choice's name, and a "why" \
when that choice needs a reason (a send back always does). Use the ids and names the flows list above shows:
```keel-flow
{"do": "answer", "flow": "<flow id>", "answers": {"<question id>": "<label>", "<question id>": ["<label>", "<label>"]}}
```
```keel-flow
{"do": "answer", "flow": "<flow id>", "choice": "<choice name>", "why": "<the reason, when the choice needs one>"}
```
Run modes: manual stops at every gate; important approves a criterion's gate when its checks and review pass; auto \
approves every gate keel can decide (it still stops for money, new dependencies, secrets and failures); readonly lets \
agents read but not change anything. Only flows that run or wait can be stopped. A gate that asks questions or offers \
named choices is answered (the answer button above, the dashboard or /answer), not approved.
When the person asks how to build, change or fix something, say which workflow fits best and why (one or two \
sentences, and when another one fits better), then give the start button with a good title and request."""

FORMAT = formats.WORKFLOW

USEFUL_ACTIONS = ["run:", "commit", "verify_green", "verify_red", "verify_lint", "lint_run", "lint_report",
                  "verify_coverage", "coverage_report", "verify_deps", "audit", "show_diff", "push_check", "report",
                  "review_scope", "review_lenses", "start_flow"]


def _workflow_line(w: dict) -> str:
    wid = str(w.get("id") or "")
    base = str(w.get("based_on") or "").removeprefix("keel/")
    about = ABOUT.get(wid) if w.get("source") == "keel" else None
    steps = [str(s.get("name") or s.get("id")) for s in (w.get("steps") or [])]
    agents = sorted({str(s["agent"]) for s in (w.get("steps") or []) if s.get("agent")})
    if not about:
        own = ["yours"] + ([f"based on {base}"] if base else [])
        if w.get("folder"):
            own.append(f"folder {w['folder']}")
        shown = " → ".join(steps[:10]) + (" → …" if len(steps) > 10 else "")
        about = f"{', '.join(own)}; {len(steps)} steps: {shown}" + (f"; agents: {', '.join(agents)}" if agents else
                                                                       "; no agents")
    last = w.get("last_run") or {}
    run = f" (last run: {last.get('status')}, \"{last.get('title')}\")" if last.get("title") else ""
    return f"- `{wid}` {w.get('name') or wid}: {about}{run}"


def _flow_line(f: dict) -> str:
    bits = [f"\"{f.get('title')}\" ({f.get('workflow') or '?'}, id {f.get('thread_id')}): {f.get('status')}"]
    w = f.get("waiting") or {}
    if f.get("status") == "waiting" and w.get("title"):
        bits.append(f"waits for the person at \"{w['title']}\"" + _asks(w))
    if f.get("step"):
        bits.append(f"step {f['step']}")
    if f.get("phase") and f["phase"] != "none":
        bits.append(f"phase {f['phase']}")
    if f.get("acs_total"):
        bits.append(f"criteria {f.get('acs_done', 0)}/{f['acs_total']} done")
    if f.get("branch"):
        bits.append(f"branch {f['branch']}" + (" (own worktree)" if f.get("where") == "worktree" else ""))
    if f.get("tokens"):
        bits.append(f"{round(int(f['tokens']) / 1000)}k tokens")
    if f.get("error"):
        bits.append(f"error: {str(f['error'])[:200]}")
    if f.get("updated_at"):
        bits.append(f"last change {f['updated_at']}")
    return "- " + "; ".join(bits)


def _asks(w: dict) -> str:
    """What a waiting flow asks, when the api sends it (keel 0.18.13): its questions' ids and options, or its named
    choices (a * marks one that needs a reason), so KeelBot can propose an answer with the right ids and names."""
    qs = [q for q in w.get("questions") or [] if isinstance(q, dict) and q.get("id")]
    if qs:
        return " (questions: " + "; ".join(
            f"{q['id']}{' [several]' if q.get('multiple') else ''}: {q.get('question', '')} ["
            + " | ".join(str(o.get("label", o) if isinstance(o, dict) else o) for o in q.get("options") or []) + "]"
            for q in qs) + ")"
    info = [c for c in w.get("choice_info") or [] if isinstance(c, dict) and c.get("name")]
    names = [f"{c['name']}{'*' if c.get('why') == 'required' else ''}" for c in info] or \
        [str(c) + ("*" if c == "reject" else "") for c in w.get("choices") or []]
    return f" (choices: {', '.join(names)}; * needs a reason)" if names else ""


def _agents() -> list[str]:
    out = []
    for f in addons.agent_files():
        m = re.search(r"^description:\s*(.+)$", f.read_text(), re.M)
        about = (m[1].split(". ")[0] if m else "").strip()
        if len(about) > 100:
            about = about[:100].rsplit(" ", 1)[0] + "…"
        if f.stem != "helper":
            out.append(f"{f.stem}: {about}")
    return out


def format_block(plugins: list[str] | None = None) -> str:
    from keel_engine.rules import PHASES
    from keel_engine.runtime.action_docs import DOCS

    acts = [f"{a} {DOCS[a]['summary']}" if a in DOCS else a for a in USEFUL_ACTIONS]
    parts = [FORMAT, "Phases: " + ", ".join(p for p in PHASES if p != "none") + ".",
             "Actions for code steps (more are in keel's templates):\n" + "\n".join(f"- {a}" for a in acts)]
    mine = extensions.keelbot_actions(plugins)       # each part's step lines (keel_engine/extensions.py)
    if mine:
        parts.append("The project's plugins add these code steps; their settings go in the step's `with:`, for example\n"
                     "  - { id: orphans, kind: code, name: no score without a player, action: db:check, soft: true,\n"
                     "      with: { sql: \"SELECT s.id FROM scores s LEFT JOIN players p ON p.id = s.player_id WHERE p.id IS NULL\", "
                     "expect: none } }\n" + "\n".join(f"- {a}" for a in mine))
    agents = _agents()
    if agents:
        parts.append("Agents for agent steps:\n" + "\n".join(f"- {a}" for a in agents))
    return "\n\n".join(parts)


def keel_block(keel: dict | None, question: str) -> str:
    """What KeelBot knows about keel in this project, for its prompt; "" when the api sent nothing."""
    if not keel:
        return ""
    parts = []
    wfs = [w for w in keel.get("workflows") or [] if w.get("id")]
    if wfs:
        parts.append("The workflows this project can run (a flow is one run of a workflow):\n"
                     + "\n".join(_workflow_line(w) for w in wfs))
    flows = list(keel.get("flows") or [])[:MAX_FLOWS]
    if flows:
        parts.append("This project's flows, newest first (several can run at once, each in its own worktree):\n"
                     + "\n".join(_flow_line(f) for f in flows))
    elif wfs:
        parts.append("No flow has run in this project yet.")
    parts.append(ACTIONS)
    on = list(keel.get("plugins") or [])
    parts += [kb["prompt"] for kb in extensions.keelbot(on) if kb.get("prompt")]     # the parts on (Database ...)
    q = question or ""
    if ABOUT_WORKFLOW.search(q) and WRITE_WORDS.search(q):
        parts.append(format_block(on))
    if ABOUT_RULE.search(q) and WRITE_WORDS.search(q):
        parts.append(formats.RULE)
    if ABOUT_STACK.search(q) and WRITE_WORDS.search(q):
        parts.append(formats.STACK)
    if ABOUT_SKILL.search(q) and WRITE_WORDS.search(q):
        parts.append(formats.SKILL)
    elif ABOUT_AGENT.search(q) and WRITE_WORDS.search(q):
        parts.append(formats.AGENT)
    return "\n\n".join(parts)


# ------------------------------------------------------------------ KeelBot's hook (its PART, __init__.py)

def pr_body_sections(thread_id: str) -> list[str]:
    """The PR body's and the final review's list of the commits KeelBot made for this flow (Fix at a gate)."""
    from . import helper          # late: KeelBot's module imports most of the runtime
    helped = helper.commits_for(thread_id)
    if not helped:
        return []
    lines = []
    for c in helped:
        files = c["files"]
        more = ", …" if len(files) > 6 else ""
        lines.append(f"- `{c['sha'][:7]}` {c['subject']}" + (f" ({', '.join(files[:6])}{more})" if files else ""))
    return ["## KeelBot changes", "", "Made with KeelBot at a gate, then checked and committed by keel:", ""] + lines + [""]
