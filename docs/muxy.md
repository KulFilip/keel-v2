# keel in Muxy

[Muxy](https://github.com/muxy-app/muxy) (MIT) is a native macOS terminal built on libghostty: projects with split
panes, a command palette, and a notification center that other programs feed through a Unix socket. keel2 has two
commands for it:

```
keel2 muxy hook [--project <name>]   keel's waiting questions and flow results as Muxy notifications
keel2 muxy hook --test               one sample notification (is the path to Muxy working?)
keel2 muxy hook --install            start the hook at login (a LaunchAgent; asks first) · --uninstall
keel2 muxy workspace [folder]        open the folder in Muxy: keel2 tui, keel's live events, a shell
keel2 muxy workspace --layout-only   only write .muxy/layouts/keel.json (pick it in Muxy: Layouts › keel)
```

```
  keel (GET /api/events, /api/inbox)          Muxy
  ┌──────────────────────────┐   one line    ┌──────────────────────────────────┐
  │ a gate waits             │──────────────▶│ toast + notification center      │
  │ a flow is done / failed  │  keel|pane|   │ click: jumps to the pane         │
  │ a budget cap stopped it  │  title|body   │ (the hook's pane, or the active) │
  └──────────────────────────┘  muxy.sock    └──────────────────────────────────┘
            ▲
            └── keel2 muxy hook (reads only; you answer in keel2 tui or the dashboard)
```

## What the hook does

- It follows keel's live events (`GET /api/events`; `?project=*`, the bell's events, when it is not in a terminal) and,
  when the stream is down, reads `/api/inbox` and `/api/notifications` every 15 s.
- At start it tells every question that already waits. Then one notification per new question and per bell
  notification keel makes: a gate or a question waits, the flow is done, the flow failed, an agent or code step failed,
  a budget cap stopped the flow, guard reverted an edit, a plugin asks. keel's own bell settings decide what exists
  (Settings › Notifications: "started" is off by default and the hook skips it). Review replies and keel check results
  do not make a bell notification in keel today, so they do not reach Muxy either.
- The text: `keel · <project>: <flow> waits for you`, then the question, the choices, and where to answer:
  `Answer in keel2 tui or http://localhost:<port>/inbox`. Muxy has no buttons on notifications (see below), so the hook
  never answers anything. It uses only GET.
- Never twice: each question (thread + question id) and each notification (its id) is marked in
  `~/.local/state/keel2/<KEEL_NAME>.muxy-seen/`. A restart, or a second hook (the LaunchAgent and the workspace pane),
  does not repeat it. When Muxy is not running, the notifications wait (up to 30) and go out when it starts.
- Auth: the sign-in key (`keel2 auth key`) as `Authorization: Bearer`, read from keel's data and given to curl on stdin.
  It is never on a command line, in a log, or in the LaunchAgent.
- In a Muxy pane (`MUXY_PANE_ID` is set) the notifications belong to that pane, so a click goes there; elsewhere Muxy
  puts them on the active project's first pane. `--pane <id>` picks one.
- It needs python3 (like `keel2 mcp`'s relay). Without it (or `KEEL_MUXY_PY=0`) it tells only the number of waiting
  questions, with `nc -U`.
- `--install`: Muxy has no place to start a helper (below), so it is a user LaunchAgent,
  `~/Library/LaunchAgents/dev.keel.keel2.muxy-hook.<KEEL_NAME>.plist`, running `keel2 muxy hook --wait` (it waits for
  keel and for Muxy). It asks y/N first (`KEEL_YES=1` does not ask); `--uninstall` removes it. Log:
  `~/Library/Logs/keel2-muxy-hook.log`.

## The workspace

`keel2 muxy workspace [folder]` writes Muxy's layout file `.muxy/layouts/keel.json` in the folder:

```
┌──────────────────────┬──────────────────────┐
│                      │ keel live            │
│ keel                 │ keel2 muxy hook      │
│ keel2 tui            │   --feed             │
│                      ├──────────────────────┤
│                      │ shell                │
└──────────────────────┴──────────────────────┘
```

With Muxy running (or startable), it then drives the `muxy` command line (on PATH, or the one inside Muxy.app):
`create-project`, `switch-project`, `split-right --project <folder> "keel2 muxy hook --feed"`, `split-down` for the
shell, and `send` + `send-keys Enter` to start `keel2 tui` in the first pane. If a step fails it prints the steps.
Running it twice adds panes again; to reset, pick top bar › Layouts › keel (it replaces that worktree's terminals).

There is no `keel2 agents --follow`. The right pane runs `keel2 muxy hook --feed`, which also prints keel's live events
(agents start and finish, flows start, finish, fail) and the notifications it sends. `/live` inside keel2 tui follows
the agents too. Muxy's layout schema has no sizes, so the left pane is half the width, not more.

## What Muxy supports (read from its source)

Read from the Muxy build installed here: `Muxy.app` 1.6.1, build 981 = tag `v1.7.0-beta.981` of
`github.com/muxy-app/muxy` (commit `ab00859`). The repository's `main` is now a Rust rewrite (2.x) with other
internals; `sisimomo/muxy` is an older fork (its protocol differs in details, noted below). Paths are in that repo.

### Notifications

| Question               | Answer                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Socket                 | `~/Library/Application Support/Muxy/muxy.sock` (`MUXY_SOCKET_PATH` overrides) — `docs/features/muxy-cli.md:475-484`                                                                                                                                          |
| Format for any tool    | one line `<type>\|<paneID>\|<title>\|<body>`, no answer — `Muxy/Services/Socket/NotificationSocketServer.swift:769-833` (parsed at `:799`)                                                                                                                   |
| Unknown type           | accepted, shown as a generic `socket` source — same file `:904-937`; checked live: keel's lines are stored with source `socket`                                                                                                                              |
| Empty pane             | the active project's first pane — `NotificationSocketServer.swift:927-937`. (The old fork split with `omittingEmptySubsequences: true`, so an empty pane id shifted the fields there.)                                                                       |
| Unknown pane id        | dropped without a word — `Muxy/Services/Notifications/NotificationStore.swift:113-130`                                                                                                                                                                       |
| Fields                 | pane, project, worktree, tab, title, body, time, read — `Muxy/Models/UI/MuxyNotification.swift:26-37`. No level, no actions, no link.                                                                                                                        |
| Agent protocol (v3)    | JSON `{"v":3,"kind":"agent_event","provider":…,"phase":…}` with an ack and dedupe by id — `docs/features/ai-notifications.md:20-39`. Only for known AI providers (`NotificationSocketServer.swift:351-352`, `:836-844`); keel uses the generic line instead. |
| Click                  | opens the notification's pane; only the default action — `Muxy/Services/Notifications/DesktopNotificationService.swift:148-150`                                                                                                                              |
| Action buttons         | none: no `UNNotificationAction`/category anywhere; the extension API is `notify({ title, body?, paneID? })` — `docs/extensions/tabs.md:132`                                                                                                                  |
| Run a command on click | no                                                                                                                                                                                                                                                           |
| Pane env               | `MUXY_PANE_ID`, `MUXY_SOCKET_PATH`, `MUXY_PROJECT_ID`, `MUXY_WORKTREE_ID` in every terminal — `docs/features/ai-notifications.md:57`                                                                                                                         |

How the OpenCode plugin talks to Muxy: `Muxy/Resources/scripts/opencode-muxy-plugin.js:116-150` spawns the staged
`muxy-hook` bridge (`agent-event --provider opencode --event …`), which sends the v3 JSON line and waits for the ack.

### Driving Muxy from outside

| Way                      | Exists?                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI                      | yes: `muxy` (Muxy › Install CLI; the script is also at `Muxy.app/Contents/Resources/Muxy_Muxy.bundle/scripts/muxy-cli`). `create-project`, `switch-project`, `split-right/down [--from] [--project] [cmd]` (prints the new pane id), `list-panes`, `send`, `send-keys`, `new-tab` (no command), workspaces, worktrees, browser tabs — `docs/features/muxy-cli.md`, wire format in `Muxy/Resources/scripts/muxy-cli:197-230`, `:335-358`, `:635-659`      |
| Socket                   | the same verbs, `verb\|args` lines (`NotificationSocketServer.swift:576-587`), plus `open-project\|<path>` (`:771-785`)                                                                                                                                                                                                                                                                                                                                  |
| URL scheme               | `muxy://open?path=<folder>` and an extension install link — `Muxy/MuxyApp.swift:376-390`, `:328`, `:366`                                                                                                                                                                                                                                                                                                                                                 |
| Layout files             | `<project>/.muxy/layouts/<name>.{yaml,yml,json}`: a tree of `layout` + `panes`, leaves `tab: {name, command}` — `docs/layouts/schema.md`, `Muxy/Models/Workspace/LayoutConfig.swift:73-108`. Never applied by itself: the user picks it in the top bar and confirms, and it replaces the worktree's terminals — `docs/layouts/overview.md:26-27`, `Muxy/Models/Workspace/AppState.swift:788-810`. No pane sizes. No CLI or socket verb applies a layout. |
| AppleScript              | no (no `.sdef` in the app, no `NSAppleScriptEnabled`)                                                                                                                                                                                                                                                                                                                                                                                                    |
| Start a helper with Muxy | no direct place. An extension's background script runs inside Muxy's host and can `muxy.exec` with a consent prompt (`docs/extensions/permissions.md:34`, `:45`), but extensions are off until the user enables them (`docs/extensions/manifest.md:68`) and exec is for commands that end, not a resident bridge. So `--install` is a LaunchAgent.                                                                                                       |

### Extensions

Muxy has a real extension system: `~/.config/muxy/extensions/<name>/package.json` with a `muxy` object
(`docs/extensions/overview.md:27-40`, `docs/extensions/manifest.md`). An extension can add palette commands, tabs,
**side panels** (`docs/extensions/panels.md`), popovers, top-bar and status-bar items, a background script, settings,
and post notifications. Two limits matter for keel:

- `muxy.http` refuses `localhost` and private addresses before any prompt (`docs/extensions/http.md:40-46`), so a
  panel cannot call keel on `localhost:8080` with it (only through `muxy.exec(["curl", …])`, with a consent prompt).
- Notifications from extensions have no buttons either (`docs/extensions/tabs.md:132`).

What keel would need from Muxy for answering in place (buttons on notifications, a panel that can reach keel):
[muxy-proposal.md](muxy-proposal.md).

## Checked

- Fakes: `scripts/test-keel2-muxy.sh` (fake docker, curl with a recorded SSE stream, a python3 Muxy socket listener,
  fake `muxy`, `uname`, `launchctl`).
- Live, read-only, on this Mac with Muxy 1.6.1 (981) and a running keel: `keel2 muxy hook` sent the questions that
  were already waiting; Muxy stored them (`notifications.json`, source `socket`); a second run sent nothing again;
  `--feed` connected to the full event stream. `keel2 muxy workspace` and `--install` were tested with fakes only.
