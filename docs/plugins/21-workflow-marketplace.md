# 21 · A marketplace for workflows (and, next, rule packs)

Milad's request: "make the marketplace also for workflows". The plugin marketplace (step 4) gets a second kind of item:
a **workflow** you can find, read, install into a project, update and remove, and publish. The design leaves room for a
third kind, **rule packs** (keel 0.16.2 "Rules" builds them on `main`'s line; not built here). Plugin track only:
`plugin-base`, never `main`, no tag, no release.

## 1 · The choice: a new kind of catalog entry, not a `.kplug`

```
 plugin  (step 4)                                  workflow  (this plan)
 ──────────────────                                ──────────────────────
 .kplug: code + content, keel-wide                 one YAML file: the workflow, per project
 install → /data/plugins/store, restart            install → the workflows table, no restart
 a plugin's own repo, release per tag              a publisher's repo, release per tag (or the catalog repo)
 signed (minisign), sha256, trust, revoked,        THE SAME: signed (minisign), sha256, trust, revoked,
 expiry, publisher keys                            expiry, publisher keys
```

**Recommended:** a catalog entry of kind `workflow` whose file is the signed workflow YAML. It reuses everything that
matters for safety (signatures, publisher keys, verified, revoked, expiry, the Sources and the rules), and the install
path keel already has for its built-in library (`WorkflowService.install`, the **Install review**: steps, gates, agents,
MCP servers, shell commands, files it changes, warnings). A content-only `.kplug` would also work, but it installs
keel-wide, needs a restart, cannot be per project and is not an editable copy — so it fits a workflow badly.

## 2 · The catalog format (format 1 stays readable by today's keel)

The index gets new top-level lists next to `plugins`. A keel that does not know them ignores them.

```json
{
  "format": 1, "built": "…", "expires": "…", "publishers": { … }, "plugins": [ … ], "revoked": [ … ],
  "workflows": [
    { "name": "release-notes", "kind": "workflow", "title": "Release notes", "publisher": "ana-k",
      "summary": "…", "category": "docs", "tags": ["release"], "repo": "https://github.com/ana-k/keel-workflows",
      "versions": [
        { "version": "1.2.0", "released": "2026-10-15",
          "requires": { "keel": ">=0.16.1", "plugins": { "git": ">=1.0.0" }, "agents": ["release-writer"] },
          "url": "https://github.com/ana-k/keel-workflows/releases/download/release-notes-v1.2.0/release-notes-1.2.0.yaml",
          "sha256": "…", "size": 4210,
          "review": { "steps": 6, "gates": 2, "agents": ["release-writer"], "mcp": [], "commands": ["git log …"],
                      "edits_files": true, "keel_rules": true } } ] } ],
  "rules": []
}
```

- `kind` is in every entry (`plugin` for the old list when absent), so one search and one Sources list serve all kinds.
- `revoked` entries get an optional `kind` (default `plugin`).
- `review` is the Install review the catalog's sync computed (keel computes it again at install; a difference stops the
  install).
- **Rule packs next:** a `rules` list with `kind: "rules"` and a YAML file (`content/rules/*.yaml` on `main`'s line),
  installed per project like a workflow. Nothing here builds it; the format, the search, the Sources and the publishing
  tool are written so it is one more kind, not a new system.

## 3 · Install, update, remove (per project)

| action | how |
| --- | --- |
| **install** `{name, version?, project, scope: project\|all}` | engine (marketplace): choose the newest fitting version (keel version, needed plugins), refuse revoked / expired / unverified-and-not-allowed, download (max 256 KB), check sha256 and the publisher's signature → api `WorkflowService.installFromMarketplace` validates it (the engine validator), computes the Install review, inserts the row with origin `marketplace`, the catalog, name and version |
| **update** | the same for a newer version: a new version of the same row (the old one stays in `workflow_versions`, so Roll back works); if the person changed their copy, keel asks: keep my changes (a new copy) or replace |
| **remove** | deletes the row (as Delete does today); runs and their history stay |
| **needs** | a needed plugin that is not on → the dialog offers to install / turn it on first (the plugin path of step 4); a needed agent that keel does not have → listed, the install is refused with the agent's name (agents come with plugins, or as custom agents) |

No restart: a workflow is data, not code. Trust level of every workflow: **content only** (it runs only through keel's
flow engine, its agents and gates), but the review shows the shell commands and the files it changes, in red when it
runs commands.

**Data:** a migration adds to `workflows`: `market_catalog`, `market_name`, `market_version` (null for others). It
takes the number after the track's last one (V17 today); a port from `main` renames the track's unreleased migrations
when `main` releases one with the same number, as before.

## 4 · The web

- **Control › Plugins › Marketplace** gets a kind switch: **Plugins · Workflows** (later **Rules**). The Workflows
  view: search, categories, cards (title, publisher ✓, version, summary, the review in short: "6 steps · 2 gates ·
  runs 1 command", needs), Install / Installed in this project / Update.
- **A workflow's page** (`#/plugins/workflow/<name>`): the steps as a small graph (the Workflows page's own graph
  component, read-only) and the YAML (folded), the Install review (agents, MCP, commands, files it changes, warnings),
  needs, versions, and the checks keel runs. Install asks: this project or all projects.
- **Build › Workflows:** an installed one shows the badge **"from marketplace · 1.2.0"** (and "update 1.3.0 ready"),
  with Update and Remove in its menu.
- **Publish:** a workflow's menu gets **Publish to marketplace**: it shows what the package will hold (the YAML, the
  name, version, summary, needs, the Install review), lets the person fix them, and downloads a folder (zip) with
  `<name>-<version>.yaml` and the marketplace entry `workflows/<name>.yml`, plus the exact `keel-plugin` commands to
  sign it and open the pull request. Signing stays with the person (their key never touches keel).

## 5 · Tools and the marketplace repo

- `keel-plugin workflow lint <file>` (schema checks without keel), `keel-plugin sign` (as for plugins), `keel-plugin
  index` reads `workflows/*.yml` and the releases' `*.yaml` + `.minisig` (and later `rules/`).
- The marketplace repo gets `workflows/` (one entry file per workflow) next to `plugins/`; `sync.yml` and
  `check-pr.yml` handle both.
- A workflow's file can come from a publisher's repo release (like a plugin), or, for small community workflows, from
  the marketplace repo itself (`workflows/<name>/<version>.yaml` + `.minisig`). Recommended: both, the same checks.

## 6 · Work, files and tests

| part | files | tests |
| --- | --- | --- |
| engine: catalog kinds, workflow install path, search across kinds, routes `/marketplace/workflows*` | `keel_engine/marketplace/{catalog,workflows,routes}.py` | index with workflows (good, bad signature, revoked by kind, expired, broken entry left out), search, the download checks, older index without `workflows` |
| api: `/api/marketplace/workflows`, `/api/projects/{pid}/workflows/market/{install,update,remove}`, the migration, the badge fields on `GET /projects/{pid}/workflows`, publish bundle `GET /workflows/{wid}/publish` | `keel.api.marketplace`, `keel.api.workflows` | install into a project and all projects, update (unchanged, changed copy), remove, needs (plugin off, agent missing), review mismatch refused |
| web: the kind switch, cards, the workflow page, the badge, Publish | `pages/Plugins.tsx`, new `pages/MarketWorkflow.tsx`, `pages/Workflows.tsx` | vitest for each |
| tools: `keel-plugin workflow lint`, `index` with workflows | `tools/keel-plugin` | the format, sign → index → verify |
| e2e: `e2e/marketplace` gets a workflow round | `e2e/marketplace/e2e.py` | search, install into a project, it runs on the fake model, update, remove, a bad signature |
| parity | — | a full keel with no workflow catalog: 0 differences beyond the allowed additions |

## 7 · Risks

- **A workflow can run shell commands** (`run:` steps) and edit files: the review must show it before install; keel's
  guard and gates still apply. Signed by a known publisher, but not "safe" by itself.
- **Agents a workflow names may not exist** in this keel: refused with a clear message (no silent missing step).
- **Migration numbers** can clash with `main` again (the Rules work may add one): the port renames the track's.
- **Rules on `main`** may shape rule packs differently: this plan only reserves the `rules` list and the kind; the
  details follow `main`'s 0.16.2.

## 8 · Open questions (recommended answers)

1. Install a marketplace workflow for **one project or all**? → Ask each time; default **this project**.
2. When the person has **changed** an installed workflow and an update comes? → Ask: **keep my copy** (default) or
   replace with the new version.
3. **Community workflows that run shell commands:** allowed? → Yes, with the red warning in the review; the rule
   "allow unverified publishers" does not block content, but the review always shows commands.
4. Where do workflow files live? → A publisher's repo release **or** the marketplace repo; both checked the same way.
5. keel's built-in **library** (`library/*.yaml`)? → Keep it (offline, in the image). Later it can be a catalog of its
   own.
