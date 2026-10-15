# 0.17.1: one place for plugins

**Why:** keel 0.17.0 had two places to switch a plugin: **Tools › Plugins** (cards: Install for this project, For
every project) and **Control › Plugins** (installed, marketplace). Milad: the Tools one "should not exist". From
0.17.1 **Control › Plugins** is the one place.

```
  0.17.0                                    0.17.1
  ──────                                    ──────
  Tools page                                Tools page
   ├ Plugins (cards, on/off)   ── goes ──▶   (gone)
   ├ Servers (+ plugin servers)              ├ Servers (+ plugin servers)    stays
   ├ Recent tool calls                       ├ Recent tool calls             stays
   └ Who may use what                        └ Who may use what              stays

  Control › Plugins › Installed             Control › Plugins › Installed
   └ keel-wide switch                         └ keel-wide switch
                                                + "This project" switch (db, git, ci, review)
  #/plugins/<name>                          #/plugins/<name>
   └ About, Permissions, Versions, Needs      + About: KeelBot tools, workflow blocks, commands, shows in
                                              + Projects: every project with its switch
```

## What moves where

1. **Tools page.** The Plugins section and `PluginCards.tsx` go (nothing else used it). The page keeps Servers, the
   rows of the plugins' own MCP servers (`withPlugins`, for "Who may use what"), Recent tool calls and the catalog
   cards. Its sub text no longer says "Plugins keel adds".
2. **Installed tab.** A plugin a project turns on (`per_project: true`; today db, git, ci, review: the ones
   `GET /api/projects/{pid}/plugins` lists) shows a second switch under the keel-wide one: **This project**, for the
   project chosen now. It calls `PUT /api/projects/{pid}/plugins/{name}` `{enabled, scope: "project"}`. A small
   **For every project** button sends `scope: "all"`. No project yet: no second switch.
3. **The plugin's page** (`#/plugins/<name>`). About also lists what the cards said: KeelBot tools, workflow blocks,
   commands, where it shows. A new **Projects** section lists every project with its own switch (scope `project`)
   and **On for every project** (scope `all`). A project that follows "every project" says so.
4. **Links and hints.** Every "Tools › Plugins" a person reads now says **Control › Plugins**: the Workflows page's
   note on an off block, the api's and engine's 409 hints (Database, Git, CI/CD, Code Review off for this project),
   Claude Code's MCP error, docs/GUIDE.md and the README's "What you see" row. No ⌘K action or notification linked to
   `#/tools` for plugins, so none changes.

No api change: the per-project api is the same as in 0.10.0.

## Code page toolbar

The person's screenshot of the Code page: the top row had the index status, **Rebuild**, **KeelBot only** and
**Focus**.

```
  0.17.0  head:  Index: ready · … · now  [Rebuild]  [Update from main]  [KeelBot only]  [Focus]
          status bar:                                           ludus-engine   Focus ⇧⌘\

  0.17.1  head:  [Update from main]
          status bar:          Index: ready · … · now  ↻ Rebuild   ludus-engine   Focus ⇧⌘\
```

- **Focus** leaves the head. It stays in the purple status bar (and ⇧⌘\, Esc Esc).
- **Rebuild** and the index status move to the status bar, next to the project name, in its style ("↻ Rebuild",
  "Starting…" while busy). Only when the Graph plugin is loaded, as before. They now show in Focus mode too.
- **KeelBot only** goes: the panel has its own KeelBot toggle and "Open KeelBot full screen". It had no key, so the
  ⌘/ cheat sheet and `keys.ts` do not change.

## The menu's view switch (a bug)

The All / Product / Dev switch (Shell.tsx `ViewSwitch`, shown when keel has both parts) spilled out of the menu. The
menu head (`.side-head`) is a grid with two columns: the brand and the side tools. The project picker spans both
columns; the switch did not, so it sat in the narrow left column (about 95 px) and its three buttons spilled over.

```
  before                         after
  ┌──────────┬────────┐          ┌───────────────────┐
  │ keel     │ tools  │          │ keel        tools │
  │ [project picker  ]│          │ [project picker  ]│
  │ [All|Prod│uct|Dev]  ← out    │ [All |Product|Dev]│  three equal parts
  └──────────┴────────┘          └───────────────────┘
```

Fix in `web/src/styles.css`: `.view-switch` gets `grid-column: 1 / -1` and `repeat(3, minmax(0, 1fr))`, its buttons
`min-width: 0`, and the focus ring `outline-offset: -2px` (it stays inside the frame).

## Tests

- web: the Tools page has no Plugins section (and still shows the plugin's server in "Who may use what" once it is
  on); Installed's **This project** switch sends scope `project`, **For every project** sends `all`; the plugin
  page's Projects section lists each project with its switch; the Workflows note says Control › Plugins.
- Code plugin (plugins/code/web/test): no Focus or KeelBot only button in the head; Rebuild and the index status in
  the status bar; Focus from the status bar.
- The view switch (web/src/test/viewswitch.test.tsx): its three buttons, and the CSS rule (jsdom draws no CSS).
- api and engine: the hints' new words (no test pinned the old ones).
- e2e/parity: `web #/tools *` and `web #/repo *` differ from 0.17.0 only by what is gone (allow.yml, reason
  "0.17.1, …").
