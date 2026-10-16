"""How a person (or KeelBot, or an MCP client for them) writes a new keel workflow, rule pack, agent or skill: the formats
in short, with an example each. KeelBot's prompt (the KeelBot plugin), keel's MCP tool keel_format and keel TUI's /create
use the same words. The full references: docs/GUIDE.md (workflows), docs/rules/pack-format.md (rules, rules/packs.py).
"""

from __future__ import annotations

WORKFLOW = """How a workflow is written (YAML; ids are lower-case words with dashes):
id: <id>
name: <short name>
keel_rules: false        # true only when you copy a keel template whole: its locked steps (lock: true) must stay
version: 1
steps:                    # run one after another, top to bottom
  - { id: <id>, kind: code, name: <what it does>, action: <action>, phase: <phase> }
  - id: <id>
    kind: agent           # an AI agent does the step
    name: <what it does>
    agent: <agent id>
    phase: <phase>
    instructions: >-
      <what the agent must do, in plain words>
  - { id: <id>, kind: gate, name: <what the person checks>, back: <an earlier step to go back to on reject> }
  - { id: <id>, kind: branch, name: <the question>, when: { marker: RESULT, step: <step id>, equals: pass }, no: <step id> }
A workflow does not need agents: a few code steps (`run: <shell command>`) and a gate automate a task without any \
model. Use only the steps the task needs. A `run:` command must be this project's own: look it up first (the \
`commands` in .keel/config.yml, package.json scripts, pyproject.toml, the Gradle or Maven build, a Makefile); never \
copy the example's commands. `phase` decides which files a step may change (leave it out for steps that \
change nothing). A `run:` command goes through keel's shell guard: no git commit or push (use the commit action), no \
dependency install.
Example, code steps only (for a project whose tests run with npm):
```keel-workflow
id: check-before-push
name: check before push
keel_rules: false
version: 1
steps:
  - { id: lint, kind: code, name: run the linters, action: "run: npm run lint", soft: true }
  - { id: tests, kind: code, name: run the tests, action: "run: npm test" }
  - { id: look, kind: gate, name: look at the results }
```"""

RULE = """How a rule pack is written (YAML; a pack only refuses, it never allows more than keel's own rules):
schema: 1
kind: rules
name: <id>                 # lower-case words with dashes; the file .keel/rules/<id>.yaml
title: <short title>
version: 1.0.0
summary: <one sentence: what it keeps agents from doing>
rules:
  - id: <id>
    kind: bash | edit | read | mcp      # a shell command, a file write, a file read, an MCP tool call
    match: [<what it matches>]          # bash: words in the command; edit/read: path globs; mcp: tool names
    how: contains | glob | name | regex # default: contains (bash), glob (edit, read), name (mcp)
    phases: all | in-flow | none | [green, refactor]   # when it applies (default all)
    lanes: [api] | [web]                # optional: only while an agent works on that kind of criterion
    except: ["**/*.lock"]               # optional (edit, read): these paths pass
    reason: <what the agent is told, and what to do instead>
Example:
```keel-rule
schema: 1
kind: rules
name: no-migrations-by-hand
title: No migrations by hand
version: 1.0.0
summary: Agents never edit an applied migration; a new one is written instead.
rules:
  - id: applied-migrations
    kind: edit
    match: ["**/db/migration/V*__*.sql"]
    phases: all
    reason: An applied migration never changes. Write a new migration that changes the schema.
```"""

AGENT_TOOLS = ("Read", "Grep", "Glob", "Edit", "Write", "Bash")

AGENT = """How an agent is written (JSON; keel's rules and the phase still decide what it may change):
{"name": "<short name>", "about": "<one sentence: what it is for>",
 "prompt": "<its instructions: what it does, how, and what its answer looks like>",
 "tools": ["Read", "Grep", "Glob"],     # from Read, Grep, Glob (read only), Edit, Write (change files), Bash (run commands)
 "phases": ["any"]}                      # the phases it works in: any, or keel phases such as red, green, refactor
A workflow uses it in an agent step: `agent: <its id>` (the name in lower-case words with dashes).
Example:
```keel-agent
{"name": "doc writer", "about": "Writes the user docs for a finished feature.",
 "prompt": "Read the spec and the code of the feature. Write or update its page under docs/, in plain English, with one example. Change nothing else.",
 "tools": ["Read", "Grep", "Glob", "Edit", "Write"], "phases": ["any"]}
```"""

SKILL = """How a skill is written (a SKILL.md: front matter, then the text an agent reads before it works):
---
name: <id>                  # lower-case words with dashes: the skill's id
description: <one sentence: what it teaches, and when an agent needs it>
---
# <title>
<the know-how, short and concrete: what to do, in which order, what to avoid; an example>
## <a section per topic>
A skill adds words to an agent's prompt (every word costs tokens on each run of that agent), so keep it short. It never gives an agent more power: keel's rules and the phase still decide what the agent may change or run. After it is saved, attach it to the agents that need it (keel_skill_attach, /skill attach, or the Skills page).
Example:
```keel-skill
---
name: changelog-entries
description: How to write the CHANGELOG entry of a finished feature, in this project's style.
---
# Changelog entries

Add one line under "Unreleased" in CHANGELOG.md, in the past tense, for each change a user can see.

## How
- Name what changed for the user, not the files: "Players see their rank on the scores page."
- Link the pull request at the end: (#123).
- Never edit the entries of a released version.
```"""

FORMATS = {"workflow": WORKFLOW, "rule": RULE, "agent": AGENT, "skill": SKILL}
