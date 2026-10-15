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

**Built** (branch `wk_generic`, from `feat/workflow-market`). The plugin and workflow answers are the same as before
(the engine's and the tools' tests ran unchanged, except the one that said `rules` reads as nothing; one more test
compares every plugin and workflow answer with and without rule packs in the index). The **Rules tab and the rules
install call are not built**: they wait for the rules session's final pack format.

| part | module | what it does |
| --- | --- | --- |
| engine: the table | `keel_engine/marketplace/kinds.py` | `TABLE` = `PLUGIN`, `WORKFLOW`, `RULES` (`Kind`: name, list, noun, suffix, max size, categories, the entry and version types, the hooks with each kind's own checks, `summarise`); `rules_review` checks a pack version's catalog review; `pack_review(doc)` builds it from a pack's YAML (read-only, tolerant of unknown fields) |
| engine: the catalog | `keel_engine/marketplace/catalog.py` | `parse_index` reads every list through the table (the shared checks: name rule, publisher and keys, version, sha256, https, size up to the kind's limit, `requires.keel` / `requires.plugins`; then the kind's own); `Index.rules`, `Index.entries(kind)`; revoked by `kind`; `matching` / `lookup_kind` for any kind |
| engine: rule packs | `keel_engine/marketplace/rulepacks.py` | `search`, `detail` (no fetch, no install) |
| engine: routes | `keel_engine/marketplace/routes.py` | `GET /marketplace/rule-packs`, `GET /marketplace/rule-packs/{name}`, `?kind=rules` on search |
| tools: the table | `tools/keel-plugin/keel_plugin/catalog.py` | `FILE_KINDS` = `WORKFLOWS`, `RULES` (`FileKind`): `rules/<name>.yml`, the releases' `<name>-<version>.yaml` packs (a mapping with a list of `rules` and no `steps`; anything else stays a workflow), the repo's own `rules/<name>/<version>.yaml` (`--files-url`); `revoked.yml` takes `kind: rules` |
| tools: lint | `tools/keel-plugin/keel_plugin/rules.py` | `keel-plugin rules lint <file> … [--name N --version V]` |

- **Rules entries** (the index's `rules` list): `{name, kind: "rules", title, publisher, summary, category, tags,
  repo?, versions: [{version, released, requires: {keel?}, url, sha256, size (≤ 64 KB), review}]}`, review
  `{rules: int, kinds: {kind: count} (adds up to rules), phases: [str], lanes: [str]}` (other review keys are dropped).
  Categories: `safety`, `code`, `git`, `files`, `secrets`, `other` (unknown reads as `other`). A broken entry or
  version is left out and listed with the words `rule pack <name> …`. A plugin may still not be called `workflows`,
  `rules` or `refresh`.
- **The pack review** (the engine's `pack_review` and the tool's `rules.review` give the same): every rule that is a
  mapping counts; its `kind` counts as itself (`unknown` when missing); a rule without `phases` reads as `all`; phases
  and lanes in the order they first appear; kinds in the order bash, edit, read, mcp, then others by name.
- **`keel-plugin rules lint`**: `id` (a name, the same as the marketplace name), `name`, `description` (text, optional),
  `rules` (a non-empty list) with a unique `id`, `kind` (bash, edit, read, mcp), `how` (contains, glob, name, regex;
  a warning when it is not the kind's: contains → bash, glob → edit/read, name → mcp), `match` (a pattern or a list;
  a regex must compile), `phases` (all, in-flow, none or a list of phase names), `lanes` / `except` (lists; `except` on
  bash or mcp is a warning), `reason`; at most 64 KB; a field it does not know is a warning. It prints the review.
- The marketplace repo's `sync.yml` also puts `rules/<name>/<version>.yaml` (+ `.minisig`) on Pages. Not yet:
  `fetch-releases.sh` and `check-pr.yml` for rule packs (with the Rules tab).

### Engine routes (as built)

`/marketplace/rules` was already the four marketplace rules (13-step4-contract.md §12; the api's `/api/plugins/rules`
calls it), so the packs are under **`/marketplace/rule-packs`**. A refusal is `{error, hint?}` as for plugins.

```
RulesHit {name, kind: "rules", title, publisher, publisher_title, verified, version: str|null (the newest that fits),
          summary, category, tags: [str], review: {rules, kinds: {kind: count}, phases: [str], lanes: [str]},
          requires: {keel?}, fits: bool, refused: null|{error, hint}, source, repo, latest, old: bool,
          why_not: str|null, trust: "content"}

GET /marketplace/rule-packs?q=&category=  → {rules: [RulesHit], sources: [Source], categories: [str]}
GET /marketplace/rule-packs/{name}        → RulesHit + {versions: [{version, released, requires, review, url, size,
                                              sha256, revoked: str|null, fits, why_not}] (newest first),
                                              checks: [str]}                  404 unknown, 400 a bad name
GET /marketplace/search?q=&category=&kind=plugin|workflow|rules|all
    kind=rules → the rule-packs answer; kind=all adds rules and rules_categories (next to workflows and
    workflow_categories); kind=plugin (the default) and kind=workflow answer as before.
```

- **The newest that fits**: not revoked (`kind: rules`) and keel's version in `requires.keel`. `refused`: the catalog
  is old, or no version is for this keel. A pack only refuses, so its trust is `content`: the rule "allow unverified
  publishers" never blocks it.
- A Source (`sources`) is unchanged: it has no rule pack count yet (the plugin and workflow answers stay the same);
  the Rules tab can add `rules: int` there.
- No `POST …/fetch` or install route: the Rules tab will fetch the verified YAML and call the rules session's
  `POST /api/projects/{pid}/rule-packs`.

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
