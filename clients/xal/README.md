# keel in xal

[xal](https://github.com/xal-sh/xal) is a terminal coding harness where every capability is a plugin. This folder is
keel v2's xal plugin: keel's commands in xal's TUI and shell, a short keel brief for xal's model, keel's live events
in xal's transcript, and (opt-in) keel's guard on xal's own tools. Why a plugin and not more: `docs/plans/keel-xal.md`.

```
  xal TUI   /keel:status  /keel:approve  /keel:watch …        xal's model
  xal keel status   (shell, no TUI)                            mcp__keel__keel_next …
        │                                                              │
        ▼                                                              ▼
  clients/xal/plugin.ts ── stdio ──▶ keel2 mcp --admin       keel2 mcp (read)   ◀── pluginConfig.mcp (xal's own
        │                             (the commands' words)                          MCP client, not this plugin)
        ├── GET  /api/projects, /api/inbox/count   the brief in each new session's system prompt
        ├── GET  /api/events (SSE)                 /keel:watch: gates, flows, agents as transcript lines
        ├── POST /api/diagrams/ascii               /keel:diagram flow|workflow (keel 0.18's shared renderer)
        └── POST /api/projects/{p}/helper/…        /keel:ask: a KeelBot chat (ask mode)
```

## Install

1. xal (beta): `curl -fsSL https://xal.sh/install | sh -s -- --beta` (Bun and Rust are only needed to build xal
   itself; the release is one executable).
2. A keel v2 checkout gives the plugin (it reads the web's event words from `web/src/components/events.ts`, so it
   needs the whole checkout, not only this folder). keel must run (`keel2 status` prints its URL) and `keel2` must
   be on `PATH`.
3. Add it to xal's user config, `~/.xal/config.json` (or a project's `.xal/config.json`):

```json
{
  "plugins": ["/path/to/keel-v2/clients/xal"],
  "pluginConfig": {
    "keel": { "url": "http://localhost:8080" },
    "mcp": {
      "servers": {
        "keel": { "transport": "stdio", "command": "keel2", "args": ["mcp"] }
      }
    }
  }
}
```

The `mcp` part gives xal's **model** keel's read tools (`mcp__keel__keel_status`, `keel_next`, `keel_timeline` …),
found through xal's `mcp_tool_search`. Leave it out if the model should not see keel. Add `"--write"` to its
`args` only when the model may decide gates and start flows. The plugin's **commands** start their own server
(`pluginConfig.keel.mcp`, admin by default: they are you at the keyboard, like keel's dashboard).

Check it: `xal keel status` in the project's folder. In the TUI, type `/keel` to see the commands.

## Commands

The names are the keel TUI's (`docs/plans/keel-tui.md`), so the same words work in both. In the TUI type
`/keel:<command>` (or `/keel <command>`); in a shell `xal keel <command>`.

| command | what it does | keel's tool |
|---|---|---|
| `status` | the flow: phase, criteria, what waits, usage | `keel_status` |
| `next` | what waits for you and how to answer it | `keel_next` |
| `inbox` | what waits for a person | `keel_inbox` |
| `live` (`jobs`) | the agent calls running now | `keel_live` |
| `flows [limit]` | this project's flows | `keel_flows` |
| `timeline [all\|steps\|agents\|failed] [limit]`, `steps` | what happened | `keel_timeline` |
| `workflows [id]` | the workflows, or one workflow's steps | `keel_workflows` (read since 0.18.5) |
| `rules`, `budget`, `plugins` | phase rules, tokens and money, keel's plugins | `keel_rules`, `keel_budget`, `keel_plugins_installed` |
| `dashboard [flow\|map\|er]` | the link to keel's page | `keel_dashboard` |
| `flow <workflow> <idea…>` | start a flow | `keel_start_flow` |
| `approve [why…]`, `reject <why…>` | decide the gate that waits | `keel_approve_gate` |
| `answer [approve\|reject] [why…]` | answer the Inbox's first item | `keel_answer` |
| `resume [approve\|reject] [why…]` | continue a waiting flow | `keel_resume` |
| `stop` | stop the flow; keel asks you first (yes/no) | `keel_stop_flow` (write since 0.18.5) |
| `diagram <kind> [id]` | flow rail, workflow, map in plain text | `keel_diagram` (0.18), else `POST /api/diagrams/ascii` |
| `ask [--new] <question…>` | ask KeelBot (read-only); the chat stays for the next question | KeelBot's REST |
| `watch [on\|off]` | keel's events in the transcript as they happen | `GET /api/events` |
| `panel` | status, flow rail, inbox, live agents at once | the above |
| `brief` | the brief xal's model got at session start | `GET /api/projects` |

Every write goes through keel's MCP server, so keel's timeline says who did it: *via MCP · xal 0.1.0-beta.256
(keel plugin): keel_approve_gate*.

## Settings (`pluginConfig.keel`)

| field | default | |
|---|---|---|
| `url` | `$KEEL_URL`, else `http://localhost:8080` | keel's api as this computer reaches it |
| `project` | `$KEEL_PROJECT`, else the project whose folder holds xal's folder, else the only one, else keel's main project | a keel project id or name |
| `mcp` | `["keel2", "mcp", "--admin"]` | the command the slash commands use; `--write` hides stop, workflows |
| `brief` | `true` | a short `<keel-brief>` in each new session's system prompt |
| `guard` | `false` | ask keel's guard before xal's `write`, `edit`, `bash`, `read` and MCP tools |
| `guardCommand` | `["keel2", "hook", "pre-tool"]` | keel 0.19's host hook (Claude Code's input on stdin, exit 2 = refuse) |
| `timeoutMs` | `60000` | per MCP request (`keel_start_flow` waits up to 20 s for the first gate) |

A wrong type or an unknown field fails the plugin at start: xal reports `plugin failed: …/clients/xal:
pluginConfig.keel: unknown field …` and runs without it.

`guard` is for keel 0.19, when your session can hold a flow step: the hook refuses only while this folder holds a
step and is silent otherwise. If the guard command cannot run, changes are refused (fail-closed, like keel's own
agents) and reads pass.

## What xal does not let a plugin do (xal 0.1.0-beta)

- **No panel and no status line.** A plugin can replace the whole UI (`registerUi`) but cannot add a pane or a
  status-line item. `/keel:panel` prints one snapshot; `/keel:watch` prints notices; the status bar shows
  `keel: status…` while a command runs.
- **No push to the model.** keel's events reach the transcript (you), not the model's context. The brief is read
  once when xal starts.
- **KeelBot is not an xal agent.** xal's task agents are its own sessions; `/keel:ask` talks to KeelBot instead.

## Tests

```
cd clients/xal && node --test test/*.test.ts      # Node 23.6+ runs the .ts files as they are
npm install && npx tsc --noEmit -p .              # types
```

The tests fake keel's MCP server (in memory and as a child process), keel's REST api and xal's plugin context.
The real check (xal beta + a throw-away keel on the fake model) is in `docs/plans/keel-xal.md`.
