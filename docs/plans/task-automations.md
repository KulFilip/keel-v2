# Task automations (Tasks + Jira + Code Review plugins)

keel proposes, the person approves. A ticket that moves in Jira, a ticket that reaches review, and a ticket assigned
to KeelBot make keel pick a flow and ask in the Inbox. Per project a rule may let keel start by itself.

## What it does

```
 Jira (someone moves SHOPS-1234)          keel sync (poll / Sync now)
 ───────────────────────────────          ─────────────────────────────────────────────────────────
  To Do ──▶ In Progress        ──────▶   JiraSync.upsert: Jira status != task.external_status
                                           │  (keel's own moves set external_status = the status it moved to,
                                           │   so they never come back as a change: no loops)
                                           ▼
                                         TaskService.fire(JiraMoved)   task: todo ─▶ in_progress
                                           ▼
                                         TaskAutomations.onJiraMoved(task, from, to)
                                           │ rule for "in_progress"?  off ──▶ nothing
                                           │                          propose ─▶ pick ─▶ Inbox proposal
                                           │                          start ─▶ pick ─▶ start the flow (cap, run mode)
                                           ▼
                                         TaskPicker: one cheap model call (engine POST /tasks/pick)
                                           ticket (title, description, comments, PR, knowledge facts)
                                           + the project's workflows  ─▶ {workflow, why, title, request, questions[]}
                                           no model / fake / over cap / bad answer ─▶ the type's default flow
```

```
 Inbox card (kind task-proposal)                       answers (POST /api/inbox/tasks/{item}/act)
 ┌───────────────────────────────────────────────┐
 │ I want to run the fix flow on SHOPS-1234      │     start   ─▶ TaskService.start(workflow, title,
 │ why: the ticket describes a crash at checkout │                 request + answers, run mode, cap)
 │ ? Which payment provider?  (o) card  ( ) bank │     other   ─▶ the same with the workflow the person picked
 │ [Start] [Use another flow ▾] [Not now]        │     later   ─▶ the item closes, history says "not now"
 └───────────────────────────────────────────────┘
```

Review status:

```
 Jira: In Progress ─▶ In Review  (or keel's "Review it" button)
   ▼
 rule for "in_review": propose | start | off
   ▼
 the task's PR (task.pr_url; none: the item says so and asks for the link)
   ▼
 TaskPicker kind=review: review-pr (default) or another review workflow, why, focus
   ▼
 the review flow runs read-only (own_branch off); task_runs remembers it; on thread.done the
 task's history gets "The review-pr flow finished" + its summary. review-pr posts only at its own
 "post" gate, so nothing reaches GitHub without the person's OK.
```

KeelBot-owned tickets:

```
 Jira assignee == KeelBot account (accountId or name)   or   label "keel" (fallback)
   ▼  (sync also reads "assignee = <account>" / "labels = <label>" tickets, not only currentUser())
 task_watch(task) owned = 1
   ▼  every review poll (TaskPoll, 2 minutes)
 PrCommentJudge.threads(pr)   (Code Review plugin: ReviewService.view)
   ▼  new = last comment id not in task_watch.seen, author != PR author; first look = baseline only
 for each new comment (at most 3 per poll):
   PrCommentJudge.check  ─▶ ReviewJudgeService.judge (cheap "Is the reviewer right?", cached per comment)
   Jira comment on the ticket: who, where, one line of what they said, keel's verdict + why (no code, secrets masked)
   Inbox item (kind task-review): [Use keel's reply] [Address it (small flow)] [I'll handle it]
   allow_reply switch on: keel posts its reply itself (still no push, no code change)
 all reviews approve ─▶ the existing check moves the task to Testing (PP) and the ticket with the status map
```

## Data model (core migration V24: the tasks tables live in core history V7)

```
task_automations(project_id PK, json, updated_at)          the settings below, one row per project
task_watch(task_id PK, pr_url, owned, seen JSON, updated_at) KeelBot ownership + comments already handled
task_runs(thread_id PK, task_id, kind, workflow_id, created_at) review/address flows started for a task
task_inbox.data TEXT                                        the proposal / review item's JSON
```

Settings JSON (GET/PUT /api/projects/{pid}/tasks/automations):

```
{
  "rules": {                                   per keel status a Jira move lands in (the Jira status map decides it)
    "in_progress": {"mode": "propose", "run_mode": null, "cap_tokens": null},
    "in_review":   {"mode": "propose"}          mode: off | propose | start
  },
  "keelbot": {"account": "acc-keelbot-1", "label": "keel"},   ownership (account wins, label is the fallback)
  "allow_reply": false,                        KeelBot-owned: post keel's reply on GitHub without asking
  "daily_auto_starts": 5,                      cap on flows keel starts by itself per project per day
  "pick_cap_tokens": 8000                      the pick call does not run above this estimate (default flow instead)
}
```

Defaults: in_progress = propose, in_review = propose, everything else off; no KeelBot account; allow_reply off.

## Rules that keep it safe

- Only a change seen by sync counts (actor jira); keel's own moves update external_status first. A new import is not
  a move (no burst on the first sync).
- One open proposal per task and kind: a new one replaces the old one.
- "start by itself" respects daily_auto_starts (counted from task_events kind auto_start); over it, it proposes.
  It never starts while a flow already runs for the task.
- Review flows never change the task's status and never post: review-pr has its own post gate.
- KeelBot-owned: no reply, push or code change without a button, unless allow_reply (reply only).
- The Jira comment has no code blocks, at most 300 characters of the reviewer's words, tokens masked.
- Every step writes a line in the task's history (kind automation, actor keel).

## The pick (engine POST /tasks/pick)

Input: model, keys, kind (flow | review), ticket {key, title, description, type, status, comments, pr_url},
workflows [{id, name, about}], default, facts. One call through models.ask (the same no-tools path as the review
check), answer in a `keel-task-pick` JSON block: workflow (must be in the list), why, title, request,
questions (at most 3, each 2 to 4 named options), settings. Fake model, an error, an unknown workflow or bad JSON:
the default with `fallback: true` and the reason. The api books the tokens as an agent call (Budget).

## API (additive)

- GET/PUT /api/projects/{pid}/tasks/automations
- POST /api/tasks/{id}/pick ("Pick a flow for me") and POST /api/tasks/{id}/review ("Review it"): open a proposal
- POST /api/inbox/tasks/{item}/act gains actions start | other | later (proposal) and reply | address | handle
  (review comment); body gains workflow_id and answers
- POST /api/tasks/{id}/start gains title, request, cap_tokens
- GET /api/projects/{pid}/jira/users?q= (the KeelBot account picker)
- core SDK: keel.api.flow.PrCommentJudge (the Code Review plugin gives the bean; without it no comment watch)

## UI

- Tasks page: an "Automations" section (rules per status, KeelBot account + label, switches), and on every task the
  buttons "Pick a flow for me" and "Review it".
- Inbox: the proposal card (why, questions as named choices, Start / Use another flow / Not now) and the review
  comment card. Notifications follow the Inbox items (the same notifications.create as other task items).

## Tests

- api (tasks plugin): Jira-less unit of the rules; (jira plugin, fake Jira + stub engine): a Jira move → one proposal;
  keel's own move → nothing; Start → the picked workflow; start-by-itself rule; KeelBot ticket + new PR comment →
  judge once, Jira comment, Inbox item; approved → moved.
- engine: pytest for the pick (fake model, a good answer, a bad answer, an unknown workflow).
- web: vitest for the Automations section, the two buttons and the proposal card.

## Not now

- An MCP tool for proposals (the Inbox tools already list and answer task items).
- Finding a PR by branch name when the task has no PR link (the card asks for the link instead).
