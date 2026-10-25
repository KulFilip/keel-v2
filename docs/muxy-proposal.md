# Proposal for Muxy: answer a waiting tool from the notification

A draft for an issue or PR at [muxy-app/muxy](https://github.com/muxy-app/muxy). Nothing here has been sent. It is
written from Muxy's 1.6.1 (build 981, tag `v1.7.0-beta.981`) source; paths are in that tree. The `main` branch is a
Rust rewrite, so the same ideas would land in its notification and extension crates instead.

## The use case

Tools that run long jobs in a terminal (keel runs coding flows with agents; Claude Code, Codex and OpenCode ask for
permissions) often stop on a short question with two to four fixed answers: "approve / send back", "allow / deny",
"fix / exclude / accept". Today Muxy shows the question, and a click opens the pane. To answer, the person types in
that pane or goes to another app. Answering from the notification would save that trip.

```
today                                        proposed
┌──────────────────────────────────┐         ┌──────────────────────────────────┐
│ keel · shop: feature waits       │         │ keel · shop: feature waits       │
│ Approve the spec? Answer in …    │         │ Approve the spec?                │
│                                  │         │ [ approve ] [ send back ] [ … ]  │
└──────────────────────────────────┘         └──────────────────────────────────┘
 click → the pane                              a button → Muxy tells the tool
```

## What exists today

- Socket line `type|paneID|title|body` (`Muxy/Services/Socket/NotificationSocketServer.swift:769-833`) and the v3
  agent JSON for known providers (`docs/features/ai-notifications.md:20-39`). Neither carries actions.
- `MuxyNotification` has pane, project, worktree, tab, title, body, time, read (`Muxy/Models/UI/MuxyNotification.swift`).
- Desktop notifications handle only the default action (`Muxy/Services/Notifications/DesktopNotificationService.swift:148-150`).
- Extensions can post notifications (`notify({ title, body?, paneID? })`, `docs/extensions/tabs.md:132`), have side
  panels (`docs/extensions/panels.md`) and a background script with events (`docs/extensions/events.md`).
- `muxy.http` refuses loopback and private hosts (`docs/extensions/http.md:40-46`).

## Proposal 1: actions on notifications (the main one)

### Wire format

A v3-style JSON line for any tool, not only registered AI providers:

```json
{
  "v": 3,
  "kind": "notification",
  "id": "keel:t-1:q-1",
  "source": "keel",
  "paneID": "…",
  "title": "keel · shop: feature waits for you",
  "body": "Approve the spec?",
  "actions": [
    { "id": "approve", "title": "Approve" },
    { "id": "send back", "title": "Send back", "destructive": true }
  ],
  "reply": { "socket": "/Users/ana/.local/state/keel2/muxy-reply.sock" }
}
```

- `id`: the tool's own id, so the same notification is not shown twice (the v3 dedupe already does this for agent
  events) and so a later `{"kind":"notification.done","id":…}` can remove it when the question was answered elsewhere.
- `actions`: up to 4 (macOS shows that many in a notification's action menu). Optional `destructive`, `textInput`
  (`UNTextInputNotificationAction`, for "send back with a reason").
- `reply`: where Muxy sends the choice. Two simple options:
  1. **the same socket, subscribe style**: the tool keeps a connection open (`subscribe|notification.action` already
     exists for extensions, `NotificationSocketServer.swift:578-582`) and gets
     `event|notification.action|id=keel:t-1:q-1|action=approve|text=…`; or
  2. **a reply socket path** the tool listens on, one JSON line per click.
     The first needs no new file; the second also works for short-lived senders.

### Where it shows

- the in-app toast and the notification panel: one row of buttons;
- the macOS notification: a `UNNotificationCategory` per action set, registered on the fly (or a small fixed set of
  categories for 1 to 4 actions with dynamic titles), and `handleNotificationResponse` passes the action id on instead of
  ignoring it (`DesktopNotificationService.swift:148-160`).

### For extensions

`muxy.notifications.notify({ title, body, paneID, actions: [{ id, title }] })` returns the chosen action id
(or `null` when the notification is dismissed), or delivers a `notification.action` event to the background script.

### Safety

A button only sends the action id back to the tool that posted the notification; Muxy never runs anything for it.
Notifications from unidentified socket clients could show actions only when the user allows the source once
(like extension consent), so a random local process cannot put "Allow" buttons in front of the person.

## Proposal 2: a panel that can reach a local tool

keel has a web dashboard on `localhost`. A Muxy extension panel could show keel's waiting questions next to the
terminal and answer them with buttons, but `muxy.http` blocks loopback before asking
(`docs/extensions/http.md:40-46`). Proposal: a manifest field, for example

```json
"localHosts": ["localhost:8080"]
```

that lets `muxy.http` reach exactly those loopback host:port pairs after the usual per-host consent prompt (the prompt
names the port). Private network ranges stay blocked. With that, a tool can ship a small extension (panel + status-bar
count + palette commands "keel: answer next question") without a resident process.

## Proposal 3 (small): a click command

An optional `open` field on a notification, `{"open":{"command":"keel2 tui","cwd":"/path"}}`: a click opens a new
tab in the notification's project running that command, instead of jumping to the pane. Useful when the pane that sent
the notification is a background helper, not where the person answers. Same consent rule as above.

## What keel does until then

`keel2 muxy hook` sends the plain line, with the question, the choices and where to answer
(`Answer in keel2 tui or http://localhost:8080/inbox`); inside a Muxy pane it sets the pane id, so a click lands next to
keel2 tui (see [muxy.md](muxy.md)). With Proposal 1, it would add `actions` with the gate's choices and answer through
keel's `POST /api/inbox/{thread}/act` with the question id, which already refuses a stale answer (409).
