# keel and xal: a plugin, not a base for keel's TUI

[xal](https://github.com/xal-sh/xal) (MIT, TypeScript on Bun, UI on OpenTUI, a Rust native addon, beta
`0.1.0-beta.256`) is a terminal coding harness: a headless agent core where every capability, the TUI included, is a
plugin. Two questions: can keel be a first-class xal plugin, and should keel's own TUI (`feat/keel-tui`, Ink) be built
on xal or OpenTUI instead?

## Decision

1. **Yes, ship keel as an xal plugin** (`clients/xal/`), as one more client next to Claude Code, Codex and OpenCode.
   It reuses keel's MCP server for every command's words and every write, keel's REST api for the brief, the live
   events and the shared diagram renderer, and the web's event words. No new keel route, no copied formatter.
2. **Keep keel's own TUI on Ink.** Do not build it on xal or OpenTUI. xal is a whole agent product, not a UI kit; its
   plugin API has no panels and no status line, so keel's TUI could not be "xal plus a plugin" anyway; and shipping
   it would put a 94 MB per-platform Bun binary (plus a Rust addon per OS, arch and libc) into keel's image and native
   tarballs, on a beta that changes almost daily.

## What xal's plugin API gives (read in `apps/cli/src/plugins/types.ts`, 0.1.0-beta.256)

| keel wants | xal has | in the plugin |
|---|---|---|
| commands like `/keel:flow` | `registerCommand` (any name; the palette matches substrings, so `/keel` lists them all) | `/keel:<command>` for each keel TUI command, and `/keel <command>` |
| the same from a shell | `registerCli` (top-level only: `parent` is dropped by the loader) | `xal keel <command>`; this is also how the real check drives it |
| a panel (flow rail, inbox, live agents) | **none**: `registerUi` replaces the whole UI; `registerToolRenderer` only draws tool output | `/keel:panel` prints one snapshot; the status bar shows `keel: status…` while a command runs (`ctx.busy`) |
| a status line | **none** | the brief, and `/keel:status` |
| keel's events in xal ("vice versa") | no event API for plugins, but a command's `print` appends an info block and keeps working after the command returns | `/keel:watch`: `GET /api/events` (SSE) → `keel · gate · AC gate waits for you (ac_gate)` |
| a brief for the model | `registerPrompt` (a system-prompt section for runtime state) | `<keel-brief>`: project, flow, phase, AC n/m, what waits; read once at bootstrap |
| keel's tools for the model | xal is an MCP client (`pluginConfig.mcp.servers`, deferred behind `mcp_tool_search`) | nothing to build: `keel2 mcp` configured in xal (README) |
| KeelBot | task agents are xal's own sessions on xal's providers; no way to plug in an outside agent | `/keel:ask` (KeelBot's ask mode over REST). Not a model tool: xal's model asking keel's model pays twice |
| keel's guard | `registerHook({beforeTool})`: block with a reason, runs before xal's permission check; file tools use Claude's argument names | opt-in hook that feeds keel's own hook (`keel2 hook pre-tool`, keel 0.19, `agent-clients.md` §F) Claude's input; fail-closed for changes |
| confirm before stop/delete | MCP elicitation is answered by the client | the plugin's MCP client answers keel's elicitation with xal's `ask` (yes/no) |

xal's public website API (`https://xal.sh/openapi.json`) is product metadata only (`GET /api/v1/product`); there is
no hosted account, webhook or remote-session API to integrate with.

## Why not build keel's TUI on xal or OpenTUI

| | Ink (plan in `keel-tui.md`) | on xal | on OpenTUI directly |
|---|---|---|---|
| what keel ships | one `keel-tui.mjs`, Node 20+ (already in the image) | xal's executable (94 MB per platform) or Bun + `bun install` + the Rust addon built per target | Bun or a native Zig/Rust core per platform |
| panels, status line | yes (our own React tree) | no plugin API for them: we would write our own `Ui`, i.e. OpenTUI code inside xal's process | yes |
| stability | Ink 5, stable for years; Claude Code is an Ink app | beta, "breaking changes may occur", ~250 betas so far | `@opentui/core` 0.5, pre-1.0 |
| reuse | the web's typed client and React | xal's chat/agent loop, which keel does not need (KeelBot runs in keel's engine) | widgets only |
| tests | `ink-testing-library` | none for a foreign `Ui` | no Ink-style test library |
| licence | MIT | MIT | MIT |

Licence is not the problem; packaging, the missing extension points and the beta are. The cost of the plugin is
small (about 1,200 lines, no runtime dependency) and it can follow xal's changes alone.

## How the plugin keeps one source

- **Words**: every command but `diagram`, `ask`, `watch`, `panel` and `brief` prints keel's MCP tool text unchanged
  (`engine/keel_engine/mcp_server.py`), the same words Claude Code, Codex and OpenCode show. Notices use the web's
  `eventLine` (`web/src/components/events.ts`), imported, not copied.
- **Names**: the keel TUI's command names and arguments (`docs/plans/keel-tui.md`); a test checks they are all there.
  The prefix is `/keel:` because xal has no keel v1 plugin (Claude Code's plugin is `/keel-v2:` for that reason).
- **Diagrams**: `keel_diagram` (MCP, keel 0.18) when the server has it, else `POST /api/diagrams/ascii` with the flow
  view's `{workflow, thread}`: the shared renderer of `feat/keel-tui`, never a second one.
- **Audit**: writes go through MCP, so the timeline says "via MCP · xal 0.1.0-beta.256 (keel plugin): …". REST calls
  send `X-Keel-Via: xal` and `X-Keel-Client`, like the TUI's `X-Keel-Via: tui`.

To fold in when they land (marked `TODO` in the code): the TUI's `web/src/api.ts` transport (`setTransport`) instead
of `src/rest.ts`; one SSE reader with the TUI's `cli/src/sse.ts`; the command table from
`content/agent-clients/commands.yaml` (`agent-clients.md` Q2).

## Tests and the real check

- `clients/xal/test/` (Node's test runner on the `.ts` files, 37 tests): config, the MCP client (in memory and a
  real child process, paging, errors, timeouts, elicitation), SSE parsing and reconnect, project choice and the
  brief, notices, the guard (with a real process), every command's tool and arguments, diagrams over REST, KeelBot,
  watch, panel, and the plugin's contract with xal's loader. CI job `xal-plugin`.
- Real check (2026-10-16): xal `0.1.0-beta.256` installed into a scratch folder (`XAL_HOME` of its own), a
  throw-away keel 0.17.3 (`keel-xal-lab`, volume `keel-xal-lab-data`, port 8098, `KEEL_FAKE=1`, a scratch git repo).
  `xal keel help|status|workflows|next|inbox|live|flows|rules|budget|plugins|timeline|panel|brief` answered with
  keel's text (1.3-1.7 s per one-shot command: `docker exec` + the MCP server's start). A `change` flow on the fake
  model: `xal keel watch` showed *flow started*, *explorer start*, *scope check waits for you*; `xal keel approve
  looks right` moved it (timeline: `mcp.call` from "xal 0.1.0-beta.256 (keel plugin)"), the watch showed the red and
  green agents and *AC gate · CHG-1.1 waits for you*. `xal keel stop` in a terminal asked "keel: stop the flow? (yes/no)" (keel's MCP elicitation) and "yes" stopped the flow; without a terminal it declines and says why.
  `xal keel ask` got KeelBot's (fake) answer. In xal's TUI (a pty): `/keel:status` printed in the transcript with
  `keel: status…` in the status bar, `/keel:watch` printed *ac_gate approved* and *which ship steps run waits for
  you* while another client approved, `/keel:next` worked.
- Found on keel's side: `keel_start_flow` cannot start a flow on a fake-model keel (409, the MCP tool sends no
  `allow_fake`); keel 0.17.3 has no `/api/diagrams/ascii` (the plugin says so). The flow-view data the plugin sends
  was rendered offline with `feat/keel-tui`'s `diagrams.py` and gave the full flow rail.

## Open

- Package it: the native tarball and the image could carry `clients/xal` (and the one web file it imports), and
  `keel2 clients install xal` could write xal's config, like the other clients in `agent-clients.md`.
- The guard waits for keel 0.19's host hook (`keel2 hook pre-tool`); until then `guard` stays off.
- `keel_start_flow` with a fake-model keel: pass `allow_fake` when keel runs with `KEEL_FAKE=1`, or say why.
- The api's `ClientAudit` (TUI branch) could record `X-Keel-Via: xal` writes the way it records `tui`; today the
  plugin's only REST write is a KeelBot question.
- xal is beta: `src/xal.ts` holds the shapes the plugin relies on, and `test/plugin.test.ts` is the contract to
  re-check on each xal update.
