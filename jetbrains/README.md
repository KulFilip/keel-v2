# keel for JetBrains IDEs

The keel plugin for IntelliJ IDEA, PyCharm, WebStorm, GoLand and the other IntelliJ-based IDEs (2024.3 and newer):
review pull request threads inside the editor, answer the questions your flows wait at, start a flow from a
selection, and chat with KeelBot. Kotlin, Swing and the IntelliJ Platform's own components (Kotlin UI DSL, JBColor:
light and dark themes follow the IDE).

## Connect

Settings › Tools › keel:

- **keel address**: `http://localhost:8088` by default (a Tailscale or tunnel address works too).
- **Use keel2 on this computer**: the plugin runs `keel2 auth key` (from the PATH, `~/.local/bin`, `/usr/local/bin` or
  `/opt/homebrew/bin`) and sends the key as `Authorization: Bearer <key>`. The key stays in memory; it is read again
  when keel stops taking it (after `keel2 auth reset`).
- **Pair with a code**: in keel, Settings › Devices › Pair a phone shows a one-time code. The plugin calls
  `POST /api/devices/pair {code, name: "<IDE> on <host>", platform: "jetbrains"}` and keeps the device token in the
  IDE's PasswordSafe (the OS keychain or KeePass), never in settings files or logs. Removing the device in keel signs
  the plugin out.
- **keel project**: keel usually runs in Docker, so its project root and the IDE's folder can differ. The plugin
  matches the whole path, then the folder name, then the project name; pick the project by hand when none matches.

## What is where

| Where | What | keel api |
|---|---|---|
| Tool window › Review | PRs, one PR (Submit review / Approve / Check out), Changes / Threads / Pending / Overview | `GET …/review/prs`, `…/review/view`, `POST …/review/submit`, `DELETE …/review/drafts/{id}` |
| A PR file (editor) | the diff with the threads between the lines; Reply, ✦ Is the reviewer right?, ✦ Address it, Resolve; editor menu › keel: Comment on This Line | `GET …/review/diff`, `POST …/threads/{id}/reply`, `…/resolve`, `…/judge` + `GET …/review/ai`, `…/address`, `POST …/review/drafts` |
| Tool window › Flows | flows, a flow's steps and criteria, its question with named choices | `GET …/runs`, `…/flows/{tid}`, `POST /api/inbox/{tid}/act` (409: it asks something else now), `/api/threads/{tid}/stop`, `…/history` + `…/rewind` |
| Balloon, status bar | "<flow> waits for you" (Answer / Open / Later), KeelBot's command approvals, "keel · N questions" | `GET /api/inbox`, `POST /api/approvals/{id}/decide`, `GET /api/events` (SSE; a 20 s poll when it is down) |
| Start a flow (Tools › keel, Flows tab, editor menu, Alt+Enter on a selection) | workflow, title, request, where, model + effort, run mode, cap | `GET …/workflows`, `GET /api/providers/models`, `POST …/flows` |
| Tool window › KeelBot | Ask / Fix / Edit, model chip, tool log, file:line links, changed files with Diff / Undo / Done | `…/helper/sessions` (`GET`, `POST`, `PATCH {mode}` / `{model}`), `…/turn`, `…/stop`, `…/changes`, `…/undo`, `…/done`, `GET /api/jobs/{call}/steps` |
| Editor | Ask KeelBot on a selection (**Ctrl+Alt+K**; rebind it in Keymap › Plugins › keel), "KeelBot changed lines a–b · Keep / Undo / Diff" | the same, plus `git diff -U0 HEAD` for the lines |

Model and effort in Start a flow go along as flow options (`options.provider/mode/model/effort`); keel's start route
has no model field yet, so the workflow's agents keep their own models until a workflow reads them.

## Build and test

```sh
cd jetbrains
./gradlew test           # JVM tests: pairing, Bearer, inbox, gate answers (409), review threads, KeelBot, mapping, keel2's key
./gradlew buildPlugin    # build/distributions/keel-jetbrains-<version>.zip
./gradlew verifyPlugin   # the JetBrains plugin verifier against IntelliJ IDEA Community 2024.3
```

Install the zip with Settings › Plugins › ⚙ › Install Plugin from Disk. The first build downloads IntelliJ IDEA
Community 2024.3 (about 1 GB) into Gradle's cache.

## Code

```
src/main/kotlin/dev/keel/jetbrains/
  api/       KeelApi (OkHttp + kotlinx.serialization), Models, GateForm, LiveHub (SSE) and Logic: the Android app's
             client without Android; ProjectMapper, LocalKey (keel2 auth key), IdeLogic. No IDE classes: unit-tested.
  core/      KeelConnection (sign-in), KeelProjectService (mapping, inbox, live stream), ReviewSession, LocalGit
  settings/  KeelSettings, KeelProjectSettings, KeelCredentials (PasswordSafe), KeelConfigurable
  ui/        the tool window (ReviewPanel, FlowsPanel + GatePanel, KeelBotPanel), StartFlowDialog, balloons, status bar
  editor/    PrDiffEditor, ThreadComponent, ComponentInlays (Swing between editor lines), KeelBotMarks
  actions/   Tools menu, editor menu, intentions
```
