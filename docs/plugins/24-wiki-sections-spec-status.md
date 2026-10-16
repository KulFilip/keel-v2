# 0.17.3: Wiki sections you can close, and a spec's build status

**Why:** a project with many specs, knowledge sections and workflows has a long Wiki menu. And a spec page did not
say whether a flow built it, builds it now, stopped half way, or never ran. Both are in the Wiki plugin
(`plugins/wiki`); keel core gets two small additions (below).

```
  Wiki menu                                 A spec page
  ─────────                                 ───────────
  ▾ SPECS                                   # Scores
     Scores               [in progress]     ┌ Build status ─────────────────────────────┐
     Login                [built]           │ [in progress]  "Scores" · feature · red    │
     Export               [not built]       │ It waits for you: AC-2 gate                │
  ▸ KNOWLEDGE BASE   5 pages                │ [Open the flow]                            │
  ▸ WORKFLOWS        9 pages                │ Other flows on this spec: "Scores" stopped │
  ▾ RUNBOOK                                 └────────────────────────────────────────────┘
     How to run this project                (the spec's text, then its History)
```

## 1. Sections open and close

- Every section title in the menu is a button: `▾ Specs` (open) or `▸ Specs  4 pages` (closed). Click, Enter or
  Space toggles it. The button has `aria-expanded` and `aria-controls` (the id of the section's list).
- What is closed is kept per project in `localStorage`, key `keel.wiki.closed.<project id>` (a JSON list of section
  ids). Every read and write is in `try/catch`: in a private window, or with storage blocked, the menu still works and
  only forgets after a reload.
- The section of the open page is **always open** (its button shows open, and a click on it does nothing to that
  section while the page is open in it).
- While you search, every section that has a match shows its matches (searching must find things).
- **Phone** (narrow, under 900 px): the menu is a dropdown button ("Page: Scores ▾"). Its panel has the same
  sections with the same open/close buttons, the same storage and the same pills. Picking a page closes the panel.

## 2. A spec's build status

### Where the data comes from (keel already has it)

| Source | What it gives |
|---|---|
| `doc_versions` rows (0.15.9 file history) with a `thread_id` | the flows that **wrote** this spec file (the spec step, a freeze, an amendment) |
| `threads.state_json` → `spec` | the flow's spec path. New in 0.17.3: the engine's thread state carries `spec` (the spec the flow works on, or the one it was started from) |
| `threads` `status`, `phase`, `updated_at`, `created_at`; `state_json.waiting.title` | where the flow is |

Hidden runs (deleted from the run history) are left out, as the Runs list leaves them out.

### States

| Flow status | Spec state | The page shows |
|---|---|---|
| `done` | **built** | "Built by flow X", a link to it |
| `running`, `waiting` | **in progress** | the phase; "It waits for you: …" at a gate; **Open the flow** |
| `stopped`, `failed` | **stopped** | **Resume** when it can be resumed, else why not and **Start a flow from this spec** |
| no flow | **not built** | **Start a flow from this spec** |

**Which flow counts** when several flows touched one spec: a flow that runs or waits, else the newest one (by
start). The others are a small list under it ("Other flows on this spec").

**Resume** is the Flow page's own Resume (`ResumeRow`, moved to `components/ResumeRow.tsx` and shared through the
SDK): it asks for the last saved step (`GET /threads/{tid}/history`) and then rewinds to it (`api.rewind`). The rule
is the Flow page's and the api's (`FlowService.hide`): **only the last stopped flow can be resumed**, that is a
stopped or failed flow that is the project folder's current flow or the project's newest flow. Otherwise the page
says "A newer flow started after this one: only the last stopped flow can be resumed." and offers Start.

**Start a flow from this spec** opens keel's Start a flow drawer (`StartFlowDrawer`, now in the SDK) with the
feature workflow, the spec's title as the title, the spec's number of criteria for the estimate, and
`options: { spec: <path> }`. The engine (new in 0.17.3) reads `data.spec` at the start: when it is a `.md` file
inside the project, it becomes the flow's spec (`state.spec`), its criteria (`AC-n` lines) become the flow's
criteria, and the spec step is told to change that file instead of writing a new one.

### Limits

- A flow from before 0.15.9 that wrote a spec, and that was not started from it, is not linked (no row says so).
- A spec that lives only in a worktree (not yet merged) is not in the Wiki, so it has no status.
- A flow that only **read** a spec (and did not write it, and was not started from it) is not linked.
- "built" means the flow finished. It does not check that the code is still there.

## 3. The pills in the menu

Each spec in the menu (and in the phone dropdown) has a small pill: `built` (green), `in progress` (blue),
`stopped` (amber), `not built` (grey). One call loads all of them.

## 4. The endpoint (Wiki plugin, `keel.api.wiki`)

`GET /api/projects/{pid}/specs/status` (it reads core tables only through SQL; core does not import the plugin):

```json
[{ "spec": "spec:.keel/specs/scores.md", "path": ".keel/specs/scores.md", "title": "Scores", "acs": 3,
   "state": "in_progress", "thread_id": "t-1", "workflow": "feature", "flow_title": "Scores",
   "status": "waiting", "phase": "red", "waiting": "AC-2 gate", "updated_at": "…",
   "resumable": false, "why": null,
   "flows": [{ "thread_id": "t-1", "workflow": "feature", "title": "Scores", "status": "waiting",
               "state": "in_progress", "phase": "red", "waiting": "AC-2 gate", "created_at": "…",
               "updated_at": "…", "resumable": false }] }]
```

`state` is `built | in_progress | stopped | not_built`. `flows` is newest first (at most 10); the main flow is in it.
Specs with no flow have `state: "not_built"` and an empty `flows`.

## 5. Tests

- **web** (`plugins/wiki/web/test/wiki.test.tsx`): open/close by click, Enter and Space; `aria-expanded` and
  `aria-controls`; the closed count; storage per project; no storage (it throws) still works; the open page's section
  stays open; the phone dropdown; each status (built, in progress with Open the flow, stopped with Resume, stopped and
  not resumable with why + Start, not built with Start and its estimate); the pills.
- **api** (`plugins/wiki/api/.../SpecStatusApiTest.kt`): built, in progress (waiting), stopped and resumable,
  stopped and not resumable, not built, several flows on one spec (the running one wins, the list is newest first),
  a hidden run left out, the link through `doc_versions` and through `state_json.spec`.
- **engine**: `data.spec` at the start becomes `state.spec` and the criteria; a path outside the project is ignored;
  the thread state carries `spec`.
