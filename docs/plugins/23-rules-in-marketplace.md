# 23 · Rule packs in the marketplace (the third kind)

Milad's request: **rules** (keel's guard rules) in the Marketplace, next to plugins and workflows: a **Rules** tab to
browse, preview what a pack blocks and in which phases, which part of keel enforces it, install per project, update,
remove. Branch `feat/workflow-market` (the marketplace branch), not `main`.

**The rules session owns the pack format and the install api** (keel 0.17.2 "Rules": `docs/rules/pack-format.md`,
`GET /api/projects/{pid}/rule-packs`, install / uninstall). This page plans the marketplace side only. **The Rules tab
is built only after that session says the format is final.** Until then only the generic catalog kind (§2) is built.

## 1 · What a rule pack is (as the rules work has it today)

```yaml
id: no-new-dependencies
name: No new dependencies
description: Agents never add a package, inside or outside a flow.
rules:
  - id: no-install
    kind: bash                 # bash | edit | read | mcp
    how: regex                 # contains (bash) | glob (edit, read) | name (mcp) | regex
    match: ['\bnpm\s+install\s+[^-\s]', …]
    phases: all                # all | in-flow | none | [green, refactor]
    lanes: [web]               # optional
    except: ["**/*.lock"]      # optional (edit, read)
    reason: Adding a package is a person's decision.
```

A pack is installed per project as `.keel/rules/<id>.yaml`. **A pack rule only refuses**: it can never allow what keel's
own rules forbid. That makes it safe to share. It can still stop work, so the preview must show exactly what it blocks.

## 2 · The catalog: one generic "kind"

The signed index already has `plugins`, `workflows` and a reserved `rules: []` list (21-workflow-marketplace.md §2).
Step one, built now: the catalog code (keel's engine and `keel-plugin index`) handles kinds through **one table**, not
three copies:

| kind | list | file | max size | review | install goes to |
| --- | --- | --- | --- | --- | --- |
| plugin | `plugins` | `.kplug` | 200 MB | permissions, parts | the plugin store (restart) |
| workflow | `workflows` | `.yaml` | 256 KB | steps, gates, agents, commands, files | the workflows table (per project) |
| rules | `rules` | `.yaml` | 64 KB | rules by kind, phases, lanes, enforcement | the rules session's install api (per project) |

Each kind gives: its list name, file suffix, size limit, a `review` builder, and its checks. Search, Sources, revoked
(`kind`), expiry, signatures, publisher keys and trust stay shared. A new kind is one more table row and its install
call.

## 3 · The Rules tab (after the format is final)

- **Marketplace › Rules:** cards (title, publisher ✓, version, description, "3 rules · bash 1 · edit 2 · in every
  phase", Install / Installed here / Update).
- **A pack's page:** every rule in a table: kind, what it matches (the patterns), how, **phases**, lanes, except, the
  reason; and **who enforces it**:
  - **before the action** — the PreToolUse hook (Claude Code), the ToolBox (other engines) and keel's MCP guard refuse
    a matching `bash`, `read`, `edit` or `mcp` call before it runs;
  - **after the step** — the diff guard checks a step's changed files against the `edit` rules and fails the step.

  The exact list per engine comes from the rules session's api (each engine's real support), not from this page.
- **Install** into this project (or all projects): the rules session's `POST …/rule-packs` with the verified YAML and
  the marketplace's name, version and catalog (so Build › Rules can show "from marketplace · 1.0.0"). **Update** and
  **Remove** through the same api.
- Trust level: **content**. The rule "allow unverified publishers" does not block a pack (it only refuses), but the
  preview always shows everything it blocks.

## 4 · Open questions (recommended answers)

1. Per project or for all? → Like workflows: ask, default this project (if the rules api supports "all").
2. A pack that blocks something keel's own flow needs (for example `git commit`)? → The preview warns ("this blocks a
   step keel runs: commit") using the rules api's check; install still allowed.
3. Can a project's own changes to an installed pack be kept on update? → Follow the rules session (packs are files in
   `.keel/rules/`, so "keep my copy" = keep the file and skip the update).
4. Publishing a pack → the same Publish flow as workflows (a zip with the YAML and the entry, signing by the person).
