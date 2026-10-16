# keel TUI: keel v2 in the terminal

keel's own terminal app, the Claude Code way: open it and see keel's logo, the version and which keel you talk to;
KeelBot is the main view; slash commands do what the dashboard does; panels show the flow, the agents and the inbox;
what happens in the dashboard shows in the terminal, and what you do in the terminal shows in the dashboard.

```
  keel2            (no arguments, in a terminal, keel running)  ─┐
  keel2 tui                                                      ├─▶ keel-tui (Ink app, node)
  keel-tui --url http://localhost:8080   (npm bin)              ─┘        │
                                                                          │  web/src/api.ts  (the web's typed client,
                                                                          │   one transport: base URL + headers)
                                                                          ▼
                     ┌──────────────── keel api (Kotlin) ─────────────────┐
   REST  /api/...  ──┤  X-Keel-Via: tui  → ClientAudit → event tui.call    │──▶ timeline: "via keel TUI: /approve"
   SSE   /api/events ◀┤  gate.waiting, thread.done, agent.started, ...     │
   POST /api/diagrams/ascii ──▶ engine POST /diagrams/ascii ──▶ keel_engine/diagrams.py (shared with keel2 mcp)
                     └─────────────────────────────────────────────────────┘
```

## Stack

TypeScript + **Ink 5** (React for the terminal, React 18 like the web; Claude Code itself is an Ink app) in a new
package `cli/`. esbuild bundles it into one file, `cli/dist/keel-tui.mjs`, that needs only Node 20+.

*OpenTUI* (sst/opentui) was the alternative: a Zig core with TypeScript bindings, fast and with a richer layout
model. Not chosen: it needs Bun or a native Zig build per platform (the Docker image and the native release would ship
native binaries), it is pre-1.0 with a changing API, it has no `ink-testing-library` equivalent, and Ink lets the TUI
use React and the web's own typed client with nothing new to learn.

**No copy-paste of the client.** `web/src/api.ts` gets a small transport (`setTransport({ base, headers, fetch })`;
the web leaves it at "" and the browser's fetch). The TUI imports `web/src/api.ts`, `web/src/inboxApi.ts` and
`plugins/keelbot/web/keelbotApi.ts` as they are (`@keel/web-sdk` points to `cli/src/sdk.ts`, which re-exports
`web/src/api.ts`). SSE in Node: `cli/src/sse.ts`, a small reader over fetch's body stream (named events, reconnect
with backoff), the twin of the web's EventSource use in `web/src/state.tsx`.

## Tasks and files

| # | Task | Files |
|---|------|-------|
| 1 | Transport in the web client | `web/src/api.ts` (setTransport), web test |
| 2 | Shared ASCII diagram renderer | `engine/keel_engine/diagrams.py`, engine route `POST /diagrams/ascii`, api `POST /api/diagrams/ascii` (`api/.../diagrams/DiagramController.kt`), `McpLevels.kt` READ_POSTS, golden tests `engine/tests/golden/diagrams/`, shared workflow fixtures `engine/tests/fixtures/flowmap/*.json` read by pytest and vitest |
| 3 | "via keel TUI" | `api/.../mcp/ClientAudit.kt` (X-Keel-Via: tui → `tui.call` event), engine `runtime/service.py` (`started_via: tui` → `thread.started.via`), web `components/events.ts` |
| 4 | The app | `cli/src/`: `main.tsx` (args), `transport.ts`, `sse.ts`, `keel.ts` (status, next, timeline… as text), `commands.ts` (registry, parse, autocomplete), `markdown.ts`, `logo.ts`, `ui/*` (App, StartScreen, Prompt, Picker, Panels, StatusLine), `script.ts` (non-interactive driver) |
| 5 | Ship it | `keel2` (`tui`, the no-argument default), `Dockerfile` (cli stage → `/opt/keel-v2/cli/keel-tui.mjs`), `scripts/build-native.sh` (`cli/keel-tui.mjs` in the tarball), `cli/package.json` bin `keel-tui`, CI job |
| 6 | Tests and the real check | `cli/test/*` (ink-testing-library), `cli/test/contract.test.ts` (stub api), `scripts/test-keel-tui.sh` (throw-away keel), captures in `docs/pictures/tui/` |

### What the app has

- **Start screen**: keel's ASCII logo, `keel v2 <version>`, the URL, docker or native, the fake model when it is on,
  the project and its branch, one line "waiting for you" (inbox count, the gate of this project) and one line "next"
  (the same words as `keel_next`), tips.
- **KeelBot** is the main view: plain text is a turn. The answer streams (`helper.step` events of the turn's call),
  the final answer is terminal markdown, `path/file.ts:12` is marked. `/model` picks a model (the catalog of
  `/api/providers/models`), `/chats` lists and opens earlier chats, `/new` starts a new one, `/mode ask|fix`.
- **Slash commands** with autocomplete (Tab, ↑/↓): /help /project /flow /flows /resume /stop /status /next /inbox
  /approve /reject <why> /answer /jobs /live /steps /timeline /workflows /diagram <flow|workflow|map-er|graph> /rules
  /plugins /budget /dashboard /model /chats /new /mode /panel /clear /quit.
- **Panels** (keys): Ctrl+F flow rail (steps, current, gates), Ctrl+A live agents, Ctrl+B inbox. **Status line**:
  project · flow · phase · AC n/m · gates waiting · tokens · live/reconnecting.
- **Vice versa**: the SSE stream's gate.waiting, thread.done / failed, agent.started, notifications show as notices
  in the transcript. Every request carries `X-Keel-Via: tui`, `X-Keel-Client: keel TUI <version>` and
  `X-Keel-Tool: <the command>`; writes become a `tui.call` event, so the dashboard's timeline says "via keel TUI".
  A flow started with /flow sends `options.started_via: "tui"`: "flow started via keel TUI". Flows, chats and
  decisions are keel's own records, so the dashboard and the TUI always see the same.

## Shared ASCII renderer (agreed with the "keel in Claude Code/OpenCode/Codex" session)

One renderer, `engine/keel_engine/diagrams.py`: `render(kind, data, width=100, max_lines=60) -> str`. Pure,
deterministic, plain ASCII (every char < 128), every line <= width, at most `max_lines` lines and then
`... N more (zoom with id=...)`.

| kind | data | picture |
|------|------|---------|
| `workflow` | `{workflow}` | the web's flow map (`web/src/components/flowmap.ts` buildFlowMap, ported): main path, side paths, if/else arms with their `when`, per-AC / for_each loops, included flows folded, orphans |
| `flow` | `{workflow, thread, visited?}` | the same, with each step's state (done, running, waiting, failed), what waits (the gate and how to answer) and the criteria strip |
| `map-system`, `map-modules` | a map level `{nodes, edges}` | boxes and their links |
| `map-er` | `{schema, focus?}` | tables with columns and FK arrows; a focus table and its neighbours; a short list for more than 12 tables |
| `graph` | `/graph/node` focus `{focus, columns}` | callers <- focus -> callees, columns -2..2, at most 24 per column |

Routes: engine `POST /diagrams/ascii {kind, data, width, max_lines}` → `{kind, text, lines}`; api `POST
/api/diagrams/ascii` (proxied; read level in `McpLevelGuard`, so `keel2 mcp` read-only may call it). The MCP tools
import `keel_engine.diagrams` directly; the TUI uses the api route. Drift guard: `engine/tests/fixtures/flowmap/`
holds one JSON per `content/workflows/*.yaml` (steps as the engine expands them, and the main path, sections and
orphans `buildFlowMap` gives); a pytest checks the Python port, a vitest checks the web's `buildFlowMap`.

## Tests

- web: transport (base URL, headers, a custom fetch); flowmap fixtures.
- engine: diagrams golden files (every kind, ASCII only, width, max lines, deterministic), the route.
- api: `tui.call` recorded for a write with `X-Keel-Via: tui`, not for a GET; `/api/diagrams/ascii` is read level.
- cli (vitest + ink-testing-library): start screen, command parsing and autocomplete, chat streaming (SSE stub),
  panels and status line, markdown, the SSE parser; an API-contract test against a stub http server (paths, methods,
  bodies and the via headers).
- Real check, `scripts/test-keel-tui.sh`: a throw-away keel (`KEEL_NAME=keel-tui-lab KEEL_VOLUME=keel-tui-lab-data
  PORT=8099 KEEL_OPEN=0`, own `XDG_CONFIG_HOME`, a scratch git repo, an image built from this branch) driven with
  `keel-tui --script`: start screen, /workflows, /flow on the fake model to its first gate, /approve, /live, one
  KeelBot turn. Text captures in `docs/pictures/tui/`. Then the container, its volume and the built image are removed.

## Risks

- Ink and raw mode: no TTY (CI, pipes) → `--script` / `-c` modes that never ask for raw mode.
- `docker exec -it` inside the container: the terminal must pass TERM and the size; Docker does. The project the
  terminal is in maps from the host path (the container's label) to `/workspace`.
- Two renderers drifting (web SVG flow map vs ASCII): the shared fixtures.
- The 0.17.4 engine work touches `runtime/service.py`: this branch changes one line there (started_via).
- `McpLevels.kt` READ_POSTS: the other session adds a line beside ours; whoever merges second rebases.

## Open questions (with my recommendation)

1. Where does the TUI run with Docker? **Inside the container (`docker exec -it`)**: Node is there, nothing to
   install on the computer. Native: the release's `cli/keel-tui.mjs` with the computer's Node. `npm i -g` of `cli/`
   gives `keel-tui` for anyone who wants it on the host.
2. Plain `keel2` opened help until now. **Open the TUI when stdin and stdout are a terminal and keel runs; otherwise
   help as before** (`KEEL_TUI=0` keeps help). Every subcommand stays as it is.
3. Write level: the TUI is a person at the keyboard, like the dashboard: **full access, no MCP level token**; its
   writes are recorded as "via keel TUI", not "via MCP".
4. Which KeelBot mode by default? **Ask** (read-only), like the web panel; `/mode fix` when a flow waits.
5. Mermaid output of the renderer: **later** (`format: "mermaid"` is reserved).
