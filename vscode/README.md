# keel for VS Code

keel v2 in VS Code: the flows of your project and what their agents do right now, the questions they wait at, pull
request review in the normal editors, and KeelBot. The same features as the
[JetBrains plugin](https://github.com/MiladNalbandi/keel-v2/tree/main/jetbrains), on VS Code 1.90 and newer. Light,
dark and high-contrast themes follow the editor.

## Connect

Run **keel: Connect** (or the plug button in the Flows view):

1. keel's address: the setting `keel.url`, `http://localhost:8088` by default (a Tailscale or tunnel address works too).
2. How to sign in:
   - **Use keel2 on this computer**: the extension runs `keel2 auth key` and keeps the key in memory only. When no key
     is stored and keel runs on this computer, this happens on its own (setting `keel.useLocalKeel2`).
   - **Paste an API key**: the key `keel2 auth key` prints. It is kept in VS Code's secret storage (the OS keychain),
     never in settings.
   - **Pair with a code**: keel › Settings › Devices › Pair shows a one-time code. The extension calls
     `POST /api/devices/pair` with `platform: "vscode"` and keeps the device token (`kd_…`) in the secret storage.
     Removing the device in keel signs VS Code out.

The keel project is found by matching the workspace folder to keel's project paths (the whole path, then the folder
name, then the project name). When nothing matches, **keel: Pick project** chooses it by hand.

## What is where

| Where | What |
|---|---|
| keel sidebar › Flows | the project's flows, the waiting and running ones on top; a click opens the flow |
| Flow tab | step bar, phase, criteria (red / green), the question it waits at with exactly the choices keel offers (a reason box when a choice needs one), Stop flow, Resume; **Now**: each running agent with model, elapsed time, tokens and cost; **Activity**: reads, edits (+/−, click to open the file), commands with exit code and folded output, test results, guard refusals, gates; agents' answers as markdown, folded; filter All / Edits / Commands / Tests; auto-scroll with Pause |
| keel sidebar › Inbox | the questions waiting for you; a click opens the flow at its question |
| keel sidebar › Review | open pull requests (filter: review, assigned, mine, all); a PR's changed files and threads |
| Review mode | changed files open as normal editors: added and changed lines in the gutter and background, a red marker where lines were removed, a hover with the old text and **Ask KeelBot what changed here**; review threads inline (VS Code comments) with Reply and Resolve; a Changed files view; Next change |
| keel sidebar › KeelBot | chat with Ask / Fix / Edit, model picker, answers as markdown with clickable `file:line`, the tool log, changed files with Done / Undo all; the answer streams in as it is written |
| Editor | **keel: Ask KeelBot about selection** (Ctrl+Alt+K, Cmd+Alt+K on a Mac), **keel: Start a flow from selection** |
| Status bar | `◆ keel: 1 question`, or the running flow's phase; a click opens the Inbox |
| Notifications | a new question of this project: **Approve / Open** when the question offers a single approve, else **Open** |

**keel: Start a flow**: a workflow (the one that fits your words is suggested), a title, the request in your own
words, where it runs (its own worktree or this folder) and the model.

Live updates come from keel's event stream (`GET /api/events`, one connection per window). When it drops, the
extension reconnects with a growing pause, reloads what it may have missed, and looks again every 20 s meanwhile.

## Settings

| Setting | Default | What |
|---|---|---|
| `keel.url` | `http://localhost:8088` | keel's address |
| `keel.useLocalKeel2` | `true` | read keel2's key on this computer when no key is stored |
| `keel.notifications` | `true` | a notification when a flow of this project waits for you |
| `keel.review.filter` | `review` | which pull requests the Review view lists |

## Build and test

```sh
cd vscode
npm ci
npm run typecheck      # the extension and the two webview scripts
npm test               # unit tests (vitest): api client, SSE parser, activity lines, diff ranges, gate buttons, …
npm run test:smoke     # VS Code with the extension against a demo keel (scripts/demo-keel.mjs)
npm run package        # keel-vscode-0.1.0.vsix
code --install-extension keel-vscode-0.1.0.vsix
```

`npm run test:smoke` downloads a VS Code for the test; set `VSCODE_EXECUTABLE` to use an installed one. It opens a
VS Code window for a few seconds (on Linux, run it under `xvfb-run`).

`node scripts/demo-keel.mjs 8099` starts a stand-in keel with demo data only (project `shop`); point `keel.url` at it
and start VS Code with `KEEL_VSCODE_TOKEN=demo-token` to try the extension without a real keel.

## Code

```
src/
  api/       KeelApi (fetch), the api's JSON types, the SSE parser and the reconnecting live stream
  logic/     pure parts, unit-tested: activity lines, gate buttons and answers, PR diff ranges, project mapping,
             markdown, the flow panel's view models, formatting
  core/      sign-in (SecretStorage, keel2 auth key, pairing), KeelState (projects, inbox, flows, the live stream),
             Start a flow, the status bar
  views/     the Flows and Inbox trees, the flow panel and KeelBot (webviews), the webview protocol
  review/    review mode (decorations, comment threads, hover) and the Review / Changed files trees
  webview/   the webview pages' scripts (bundled for the browser)
```
