# keel roadmap (from v0.15.7, October 2026)

```
 main      0.15.7 ──► 0.15.8 ──► 0.16.0 ──► 0.16.1 ──────────────► (plugin track lands) ──► …
           (now)      layouts    full MCP   native mode                    ▲
                                                                           │ only when equal + tested
 plugin-base (0.15.6) ── merge main 0.15.7, 0.15.8, … ── every plugin tested ┘
 keel v1   0.80.0 ── fixes only ────────────── deprecated ── archived (3-6 months later)
```

| version | goal | size | depends on | plan |
|---|---|---|---|---|
| 0.15.8 | read keel v1 layouts; clear "folder not mounted" errors; keel_dashboard, keel_start_flow | M (about 2-3 days) | v0.15.7 | [0.15.8.md](0.15.8.md) |
| 0.16.0 | full MCP: read, --write, --admin, allowlist, confirm prompts, audit in the timeline | L (about 1 week) | 0.15.8 (keel_dashboard, keel_start_flow, layout-aware specs) | [0.16.0.md](0.16.0.md) |
| 0.16.1 | native mode: `keel2 start --native`, no Docker, no sudo | L (about 1 week + CI) | 0.16.0 (`keel2 mcp` must work without `docker exec`) | [0.16.1.md](0.16.1.md) |
| plugin track | every part of keel as a plugin, the same product as main | XL, in progress | each main release merged in first | docs/plugins/ on the track |
| keel v1 end | freeze, deprecate, archive | S per step | everything above | below |

## 0.15.8 — layouts

- Goal: projects that use keel v1's `layout: keel` or `external` (or both folders, like ludus-engine) show their
  specs and knowledge; new specs go where the layout says; clear errors for folders keel cannot see.
- Release checklist:
  - [ ] engine pytest, `./gradlew test -q`, web vitest all green
  - [ ] real check: three scratch repos (repo, keel, external) in a throw-away keel; Wiki and Files show specs
  - [ ] `keel_start_flow` through `keel2 mcp --write` reaches the first gate; timeline says "via MCP"
  - [ ] CONTRACT v0.15.8, GUIDE / README; version in the five files
  - [ ] the user says "release": merge to main and release/0.4.0, tag v0.15.8, image builds
  - [ ] then merge main into plugin-base (track step, below)

## 0.16.0 — full MCP

- Goal: everything the dashboard does, from Claude Code, at the level the person picks; agents stay read-only.
- Release checklist:
  - [ ] tool lists per level tested; `--read-only` wins; `--allow` works
  - [ ] confirm prompts: accepted, declined, client without them (refused; `--yes` allows)
  - [ ] every write / admin call shows "via MCP · <client>" in the timeline
  - [ ] no secret through any tool (test with a `.env` and saved logins); `repo/file` refuses secret files
  - [ ] the v1 → v2 MCP table in the docs; `--print-config` presets
  - [ ] real check per level with a stdio client; then release as above and merge into plugin-base

## 0.16.1 — native mode

- Goal: keel without Docker, with a clear warning that agents run as the person; Docker stays the default.
- Release checklist:
  - [ ] the release job uploads the native tarball + sha256
  - [ ] `native-smoke` CI green on macOS and Linux
  - [ ] start / stop / status / logs / doctor / update / rollback / mcp / add / backup natively
  - [ ] nothing written outside `~/.keel2/<name>`, the project and the folders list; the person's `~/.claude*`,
        `~/.codex` and git config untouched
  - [ ] the warning at first start, in `status` and in the web header
  - [ ] real check on this Mac (`keel-native-lab`), then release as above and merge into plugin-base

## Plugin track (branch `plugin-base`)

- Today `plugin-base` is at 0.15.6 (`fca8ec9`); v0.15.7 is not in it yet.
- Rules (they do not change):
  - main → plugin-base only. **Never merge plugin-base into main**, and never tag it, until every plugin is
    tested and the track is identical to the newest 0.15.x / 0.16.x release (parity e2e: 0 differences).
  - The track's own migrations always come after main's (main's released ones keep their numbers).
  - This roadmap's sessions never touch plugin-base; the track has its own sessions.
- Order: take 0.15.7, then **0.15.8 first** (layouts touch KnowledgeService, wiki and map, which are plugins on
  the track: `plugins/wiki`, `plugins/map`), then 0.16.0 (the MCP tools must call plugin routes), then 0.16.1.
- Done when: all plugins (map, wiki, ci, tasks, jira, db, review, git, graph, code, keelbot) pass their own tests,
  the parity e2e against the latest main release shows 0 differences, and an upgrade from the latest release's
  database works. Then one release from the track replaces main.

## keel v1: freeze, deprecate, archive

keel v1 is at 0.80.0 (repo /Users/mili/Projects/claude/keel).

1. **Freeze (now)**: fixes only, no new features. New ideas go to keel v2.
2. **Deprecate** when all of these are true:
   - [ ] v2 reads every v1 layout (0.15.8)
   - [ ] v2 runs native, without Docker (0.16.1)
   - [ ] the plugin track is done and released
   - [ ] every v1 MCP tool exists in v2 (keel_status, keel_projects, keel_timeline, keel_next, keel_explain,
         keel_dashboard; 0.15.8 + 0.16.0)
   - [ ] a v1 → v2 migration guide exists (install, layouts, MCP config, flows and gates, what has no v2 twin)
   Then: a v1 release whose session start prints the deprecation note and the guide's link; README banner.
3. **Archive** 3 to 6 months after deprecation: last v1 release, the GitHub repo archived (read-only), the
   marketplace entry points to v2.

## Every release (same for all versions)

- Plan file first, under `docs/plans/`.
- Work on a branch cut from main; never push, tag or release until the user asks.
- Engine, api and web tests green; a real check in a throw-away keel (never the user's keel on 8088), cleaned up.
- CONTRACT, GUIDE, README updated; the version in api/build.gradle.kts, engine/pyproject.toml, engine/uv.lock,
  engine/keel_engine/config.py and keel2.
- After the release: merge main into plugin-base (track sessions do this).
