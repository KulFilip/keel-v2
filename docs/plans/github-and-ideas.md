# keel v2 — GitHub, Ideas inbox, org memory, Vertex AI (plan, not started)

Status: **plan only, nothing built.** Written on 2026-10-23 (keel 0.18.44) from a tester's feature list. Do not start
before the person says so.

The feature list was checked against the code (0.18.44). What keel already has stays as it is; this plan covers the gaps.

## 0. What is there today

| Request                                                | Today                                                                                       | Where                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Git worktrees for parallel work                        | yes: a flow runs in the project folder or in its own worktree                               | `api/.../flow/FlowService.kt` (`where = folder                               | worktree`), Flyway V8 |
| Idea → spec → test → code → review → PR                | yes: keel's flows                                                                           | `content/workflows`, `engine/keel_engine/runtime`                            |
| Ideas as tasks                                         | yes: Tasks board (local or Jira), a task starts a flow; KeelBot hands a chat over to a flow | `plugins/tasks`, `plugins/keelbot` (`Helper.kt` handover)                    |
| PM view: Initiative → Epic → Story, teams, ticket keys | yes (Product edition)                                                                       | `plugins/jira`, `plugins/tasks`, `docs/product/pm-jira-teams-design.md`      |
| Connect to GitHub                                      | yes: `gh` device sign-in or a token                                                         | `api/.../connections/GitHubLoginService.kt`, `web/src/pages/Connections.tsx` |
| Act as the user on GitHub                              | yes: PRs, reviews, comments, CI with the user's token                                       | `plugins/review`, `plugins/git`, `plugins/ci`                                |
| Run on the user's Copilot seat                         | yes: Copilot CLI (subscription), OpenCode, GitHub Models                                    | `engine/keel_engine/models/catalog.py`, `cli_runners.py`                     |
| See the Copilot budget                                 | yes, unofficial: premium-request quota from `api.github.com/copilot_internal/user`          | `engine/keel_engine/models/usage.py`                                         |
| Memory                                                 | project only: facts + the knowledge base with citations                                     | `api/.../knowledge/KnowledgeService.kt`                                      |

Missing: an Ideas inbox that routes ideas to projects or creates new ones; the Copilot **cloud** agent; signing in to
keel with GitHub; repo discovery and clone; orchestrating cloud agent sessions; a GitHub App; GitHub Issues; account-,
org- and instance-wide memory; running against an org's Copilot budget; Vertex AI.

## 1. Ideas inbox (Tasks / Product plugin)

- One place to drop ideas: the web (Tasks › Ideas), the TUI (`/idea …`), MCP (`keel_idea`), later GitHub Issues with a
  label and Jira.
- An idea has: text, links, attachments, who, when, status (new → triaged → planned → in flow → done / dropped).
- **Triage** (one cheap model call, the same style as "Is the reviewer right?"): suggests the project it belongs to
  (from each project's knowledge base and README), or "new project"; a size (small fix / feature / epic); duplicates of
  other ideas or tasks. The person confirms; nothing starts by itself.
- **To an existing project:** becomes a task (or an Epic with stories in the Product edition) and can start a flow
  (spec first).
- **New project:** keel asks for a folder or a new GitHub repo (section 3, repo discovery and create), runs init, then
  the first flow.
- Reuses: Tasks storage and board, the judge's cheap-call code, the Inbox for confirmations.

## 2. GitHub plugin: Issues

- Sync GitHub Issues ↔ Tasks the way Jira syncs today (`plugins/tasks` SyncInfo, `kind = "github"`): per project, the
  repo's issues with chosen labels/milestones; status mapping (open/closed + labels ↔ task status).
- Ticket keys: `#123` and `owner/repo#123` in branch names and commits link to the issue (same matcher as the Jira keys).
- A flow started from an issue comments back (spec link, PR link) only when the person turns that on.
- Issues as an Ideas inbox source (a label like `keel:idea`).

## 3. GitHub plugin: repos

- **Discover:** list the user's and their orgs' repos (`gh api /user/repos`, `/orgs/{org}/repos`), search, filter.
- **Add as project:** clone into the workspace (a keel volume folder or a chosen host folder), then init.
- **Create:** a new repo for a "new project" idea (private by default; asks first).
- Uses the existing GitHub connection; nothing new to sign in.

## 4. Sign in to keel with GitHub

- Optional: "Sign in with GitHub" next to the local key, for keel run on a shared host (omarchy-style servers).
- GitHub OAuth (device flow, no callback needed) → keel user = GitHub login; an allow-list of logins/orgs.
- Permissions follow the user: each user's own GitHub token for their actions (today one keel = one token).
- Needs per-user settings and tokens in the API: a design change, plan it carefully (auth, `LocalAuth.kt`, MCP levels).

## 5. Copilot cloud agent

- **Assign a task to Copilot's cloud agent:** create an issue (or use one) and assign it to Copilot, or start an agent
  task through GitHub's API, with keel's prompt (the spec, the acceptance criteria, the rules) as the task text.
- Track it: the agent's PR, its sessions and logs, CI, as a flow step of kind `remote` (waits, then reviews the PR with
  keel's reviewers).
- **Orchestrate sessions:** a board of running cloud sessions across projects; the Supervisor can watch them like local
  flows (stop, comment, ask for changes).
- Check first: which GitHub API exists for starting and watching agent sessions at that time (it changes often), and
  the plan/seat it needs. No scraping of undocumented endpoints for actions.

## 6. GitHub App

- A dedicated keel GitHub App (one-click install on a user or org; Probot-style webhooks): issue/PR/comment events push
  to keel instead of polling; fine-grained repo permissions; acts as the app, not as one user.
- Webhooks need a reachable keel (a tunnel or a hosted relay); keep polling as the fallback.
- **Org Copilot budget:** find out whether an app (or org-owned token) can run Copilot against the org's budget instead
  of a seat. Research first; it may not be possible. Until then, seat-based only.

## 7. Memory beyond one project

- Levels: **project** (today) → **account** (the person's own facts: style, preferences, earlier answers) → **org /
  instance** (shared conventions, architecture rules, glossary).
- Stored in keel's database with a scope column; shown and edited in Knowledge; each fact says its scope and source.
- Agents get the narrowest facts first (project, then account, then org), within a token budget.
- Org memory needs sign-in per user (section 4) to know who may change it.

## 8. Vertex AI

- A model provider `vertex`: Claude and Gemini models through Google Vertex AI (project, region, a service-account key
  or ADC kept as a secret).
- Fits the existing model catalog (`catalog.py` modes, efforts) and the API runner (`api_runner.py`); usage and cost
  from Vertex's token counts.

## 9. Order (when the person says go)

1. GitHub plugin: Issues ↔ Tasks, then repos (discover, clone, create).
2. Ideas inbox (uses 1 for new projects and Issues as a source).
3. Vertex AI provider (small, independent).
4. Memory levels: account first, org after sign-in.
5. Sign in with GitHub (design change).
6. Copilot cloud agent and session board (after checking the current GitHub API).
7. GitHub App and the org-budget research.

Each step: its own branch, tests that fail first, the targeted suites locally, CI, then a release.
