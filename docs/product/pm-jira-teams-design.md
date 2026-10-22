# keel Product: the PM view, the Jira ticket tree, teams and ticket keys (design)

Status: approved 2026-10-22 (keel-wide Jira connection with a per-project override; all six steps). Branch `feat/product-jira` (from `fix/bughunt`).

## 0. What is there today

```
 keel Product (plugin)                               Jira plugin (per keel project)
 ┌───────────────────────────────────────────┐       ┌─────────────────────────────┐
 │ Initiative INI-n                          │       │ jira_connections            │
 │  idea → brief → impact → decision → plan  │       │  1 row per keel project     │
 │                     │ (agents read code)  │       │  site, token, project key   │
 │                     ▼                     │       └──────────────┬──────────────┘
 │  plan items: epic + stories (+ criteria)  │  handoff             │
 │                     └──────────────────────┼──────────────────────▶ Epic, Story, Sub-task
 │ Teams: name, lead, Jira key, capacity,    │                        (no Initiative issue)
 │        owns: project + glob (CODEOWNERS)  │
 └───────────────────────────────────────────┘
 keel core: projects = id, name, root. No owner, no team, no users.
 Code analysis: map (modules, endpoints, tables), graph (symbols), knowledge (journeys = free markdown).
 Nothing lists "business flows" as data. Nothing reads ticket keys from branches or commits.
```

## 1. The PM view (a)

One new Product page, **Product map**, for a product manager. Three columns, filtered by team:

```
┌ Product map ───────────────────────────────────────────────────────────────────────────┐
│ Team [All ▾]   Jira: ERPDM · SW              [Find flows again]  [+ New tickets]        │
├────────────────┬─────────────────────────────────────┬─────────────────────────────────┤
│ TEAMS          │ BUSINESS FLOWS                      │ TICKETS AND WORK                │
│ ▸ ERP DM   (3) │ ● Checkout          web-shop · pay  │ ERPDM-1234 In progress          │
│   erp-core     │   5 steps · 3 endpoints · 2 tables  │   branch feat/ERPDM-1234-vat    │
│   erp-ui       │ ● Refund            pay             │   3 commits · last 2 days ago   │
│ ▸ SW       (2) │   3 steps                           │ ERPDM-1240 Done                 │
│   web-shop     │ ● Sign up           web-shop        │ ⚠ 2 branches with no ticket key │
└────────────────┴─────────────────────────────────────┴─────────────────────────────────┘
```

- **Business flows** are found by a read-only agent run (`product-flows` workflow, one analyst per repo, like the
  impact). It gets the repo's knowledge page `journeys`, the map's endpoints and tables, and answers with a JSON
  block. keel checks every `path:line` cite exists, then saves it.

  ```
  flow = { id: "checkout", name: "Checkout", summary, team, repos: [..],
           steps: [{ text, repo, cite: "src/Cart.kt:40" }], endpoints: ["POST /orders"], tables: ["orders"] }
  ```

  Stored in table `product_flows` and as `flows/<project>.json` in the product repo (a versioned commit, like the
  docs). The PM can rename, merge or hide a flow; a new run keeps those edits (matched by id).

- Click a flow: its steps (with links to the code), the teams that own its files, and the tickets whose branches or
  commits touched those files (from part 4). So the PM sees "which work changed Checkout".
- **+ New tickets** on a flow starts the ticket tree (part 2) with that flow already chosen.

## 2. The ticket tree: Initiative → Epic → Story (b)

```
 PM: idea + flows + teams
        │
        ├── full path (today):   brief → impact → decision → plan ──┐
        └── quick path (new):    impact → plan ─────────────────────┤  (skips brief and decision)
                                                                    ▼
                                         ┌─────────── DRAFTS (keel only, editable) ───────────┐
                                         │ INI-7  Euro prices            → Jira  PORT (optional)│
                                         │  ├ EPIC ERP  Price API v2     → team ERP DM · ERPDM  │
                                         │  │  ├ S1  Add EUR to /prices   ✎  criteria (3)     │
                                         │  │  └ S2  Rounding rule        ✎                   │
                                         │  └ EPIC WEB  Show euro         → team SW · SW       │
                                         │     └ S3  Price label          ✎                   │
                                         └───────────────────────┬─────────────────────────────┘
                                         [Preview]  shows per Jira project what will be made
                                                                 ▼
                                         [Send]  top-down: Initiative, Epics, Stories, Sub-tasks
                                                 keys are saved after each create → a re-send never makes a twin
```

- The plan stays as it is; its stories become **drafts**. The PM can edit title, text, criteria, tasks, team, repo
  and estimate, add or delete a story or epic, and move a story to another epic. A sent ticket is locked (it shows
  its Jira key and status).
- **Preview** (`GET …/tickets/preview`): per Jira project the list of tickets to create, and every problem before
  anything is sent: no connection, no project key, the issue type does not exist (checked with Jira's createmeta),
  a story without criteria.
- **Send** (`POST …/tickets/send` with the checked ids): web page = preview, then a confirm dialog. When an agent
  asks for it (MCP or KeelBot), keel makes an Inbox **approval** (`product-jira-send`, the existing ApprovalService)
  and sends only after the PM approves.
- **Jira levels**, set per team (with sane defaults and a "Check with Jira" button):

  | level      | issue type (default) | parent link                                          |
  | ---------- | -------------------- | ---------------------------------------------------- |
  | initiative | `Initiative`         | optional; only when the Jira has that type           |
  | epic       | `Epic`               | `parent` (Cloud) or the "Parent Link" field (Server) |
  | story      | `Story`              | `parent` (Cloud) or the "Epic Link" field (Server)   |
  | sub-task   | `Sub-task`           | `parent`                                             |

  Without an Initiative type, the initiative stays in keel only and its id goes on every ticket as a label
  (`INI-7`).

## 3. Teams (c)

```
 Team "ERP DM" (lead Sara)                     Team "SW" (lead Tom)
 ┌──────────────────────────────┐              ┌──────────────────────────────┐
 │ projects: erp-core, erp-ui   │              │ projects: web-shop           │
 │ Jira: site acme.atlassian.net│              │ Jira: site jira.sw.local     │
 │       project ERPDM          │              │       project SW             │
 │ key pattern: ERPDM-\d+       │              │ key pattern: SW-\d+          │
 │ issue types, labels, comp.   │              │                              │
 └──────────────────────────────┘              └──────────────────────────────┘
```

- **Add a project to a team**: on the Teams page, and with `PUT /api/teams/{id}/projects/{pid}`. It is the existing
  ownership row with glob `**` (CODEOWNERS paths stay as they are). A project can be in more than one team.
- **The team's Jira** (chosen 2026-10-22): a new **keel-wide Jira connection** in the Jira plugin (one site and
  token for every project, like GitHub); a project's own connection still wins. A team names the project whose
  connection it uses (blank = the keel-wide one), then its project key, issue types, labels and component.
- Today's bug fixed on the way: the site and token come from the story's repo, but the project key from the team.

## 4. Ticket keys per team (d)

```
 git (each team's projects)                    keel                                    PM view
 ┌─────────────────────────────┐   scan    ┌──────────────────────────────┐        ┌────────────────────┐
 │ branch feature/erpdm-1234-x │ ────────▶ │ team ERP DM: ERPDM-\d+       │ ─────▶ │ ERPDM-1234         │
 │ commit "ERPDM-1234 add vat" │           │  → key ERPDM-1234            │        │  1 branch          │
 │ commit "fix typo"           │           │ no key → "no ticket" list    │        │  2 commits         │
 └─────────────────────────────┘           └──────────────────────────────┘        └────────────────────┘
```

- Each team has a **key pattern**, default `<JIRA KEY>-\d+`. It is matched case-insensitive with word edges, so
  `feature/erpdm-1234-vat` gives `ERPDM-1234`. The pattern is checked when saved: it compiles, it is short (100
  characters at most), it has no nested repeat (no `(a+)+`), and it matches the sample the PM types.
- keel scans the branches (local and remote) and the commits of the last 90 days of each team's projects, only the
  first 2 KB of each message. It runs on demand ("Scan now") and every 15 minutes. It stores
  `product_ticket_links(key, team, project, kind branch|commit, ref, sha, title, author, at)`.
- Shown: on the Product map (tickets column), on a sent draft (its branches and commits), and a team's
  **"no ticket key"** list (branches and commits that do not match: a hint that the pattern or the habit is wrong).
- Jira status of a linked key comes from the existing status cache (60 s), only for teams with a connection.

## 5. What is reused

| need                  | reused                                                               |
| --------------------- | -------------------------------------------------------------------- |
| agents that read code | the impact stage's runner and the analyst agent (read only)          |
| Jira calls            | `JiraClient` (createIssue, linkIssues, + createmeta, + labels)       |
| approvals and Inbox   | `ApprovalService` + `ApprovalHandler` (new kind `product-jira-send`) |
| git                   | the api's git helper (`RepoService.git`)                             |
| tests                 | `StubJira` in the api tests, the fake model for the engine           |

## 6. Steps (small commits, each with tests)

1. Bug fixes found in the check (section 7).
2. Teams: projects, Jira settings per team (types, labels), keel-wide Jira connection.
3. Ticket keys: pattern, scanner, links api, team page list.
4. Drafts: editable stories/epics, preview, idempotent send with Initiative level, Inbox approval for agents.
5. Business flows: workflow + agent + fake answers + `product_flows`, Product map page.
6. e2e: the product e2e gets a stub Jira and the new steps.

## 7. Bugs and gaps found in the check

Unit suites on `fix/bughunt`: product engine 15, api productTest 5 + jiraTest 15 + tasksTest 17, web 28 (Product,
Jira, Tasks): all green. Throw-away keel `keel-pj` (image built from `fix/bughunt`, 0.18.32, fake model, a stub Jira on
the host): the Product walk passes 27 checks once the e2e signs in.

| #   | what                                                                                                                   | how found                    |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1   | `product/e2e/e2e.py` sends no keel token: every call gets 401 on keel ≥ 0.18.1                                         | run                          |
| 2   | Sending the stories of one epic in two goes makes the Jira **Epic twice** (the epic's key is not kept)                 | run (stub Jira)              |
| 3   | Jira Server refuses a Story with `parent` = epic; keel retries without the epic and says nothing                       | code, DeliveryService.toJira |
| 4   | Site and token come from the first story's repo, the project key from the team: they can belong to two different Jiras | code                         |
| 5   | Issue type names are fixed (`Epic`, `Story`, `Sub-task`); team-managed Jira calls it `Subtask`                         | code                         |
| 6   | No Initiative level in Jira; the initiative stays in keel                                                              | code                         |
| 7   | The plan's stories cannot be edited before they are sent (read-only tab, no endpoint)                                  | code                         |
| 8   | After "Send to keel Tasks" the "Send to Jira" button is gone, though the api still allows it                           | code, Initiative.tsx:970     |
| 9   | Impact map and roadmap (`feat/product-impact-roadmap`) were never merged                                               | git                          |
| 10  | Nothing reads ticket keys from branches or commits; flow branch names have no `{key}`                                  | search                       |
| 11  | Product uses no Inbox card and no approval                                                                             | search                       |
| 12  | The local `keel-v2:product` image is old (0.18.21)                                                                     | run                          |
