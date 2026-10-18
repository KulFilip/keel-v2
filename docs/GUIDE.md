# keel v2 guide

The [README](../README.md) is the short version. This page has the details.

- [Flows in detail](#flows-in-detail)
- [KeelBot](#keelbot)
- [Plugins and the Marketplace](#plugins-and-the-marketplace)
- [Quality](#quality)
- [Inbox and run modes](#inbox-and-run-modes)
- [Tasks and Jira](#tasks-and-jira)
- [Logins](#logins)
- [Use keel from Claude Code or Claude Desktop (MCP)](#use-keel-from-claude-code-or-claude-desktop-mcp)
- [Docker mode](#docker-mode)
- [Problems](#problems)
- [Folders in the container](#folders-in-the-container)
- [Without the install script](#without-the-install-script)
- [Develop keel v2](#develop-keel-v2)

## How a flow works

```
 you: "show each player's rank"
   │
   ▼
 spec ─◆─ red ─ green ─◆─ … (one loop per criterion) … ─ review ─◆─ done
        │     │       │                                          │
        │     │       └ you approve each criterion               └ you approve the end
        │     └ an agent writes the smallest code that passes; keel commits it
        └ you approve the criteria; an agent writes a failing test, keel checks it fails, then commits it
```

- The flow is a [LangGraph](https://github.com/langchain-ai/langgraph) graph; the agents are LangChain or CLI agents.
- keel runs the tests and makes the commits itself, on its own branch (`feat/…`). It never pushes, and it never
  commits files you changed yourself.
- keel's commits are by you, and end with `Co-Authored-By: KeelBot <keel.dev.bot@gmail.com>`, so GitHub shows both.
  Settings › Git: **KeelBot as co-author** (on by default) and **Commit author** (`Name <email>`; empty: the
  project's git name — in Docker there is none, so set it there, or the commits are by KeelBot alone).
- Every step, file change, command and token is visible: **Live agents**, **Jobs**, **Budget**.
- **Several flows at once**: while a flow runs in the project folder, the next one runs in a worktree of its own
  (a copy of the project on its own branch, under `.keel/worktrees/`), so neither touches the other's files. Press
  **Start** on three tasks, or **Start another flow** on the Flow page. The Flow page then shows a board: each flow,
  the files two flows both change, the branches that will not merge cleanly, and an order to merge them in. The
  Inbox groups their gates by flow. On top of the Flow page, a tab for each flow that runs or waits switches between
  them, and **History** lists every flow of the project (all, or one workflow's); **Open** shows any of them with all
  its details.
- When something needs you, keel plays a sound, shows a pop-up and its mascot jumps.
- keel v2 has its own guard, rules, agents, skills and MCP server. [keel v1](https://github.com/MiladNalbandi/keel) is a
  separate project and is not in the image.

## Flows in detail

| Flow | What it does |
|---|---|
| **feature** | spec (with questions) → plan → contract → per criterion: failing test, code, review ◆ → security, full review, e2e, smoke → ship |
| **change** | small change without a spec: trivial (one commit) or 1–3 criteria; too big → hands over to feature |
| **quick** | one agent makes the change and a test → keel runs the tests (2 fix rounds) → your one look ◆ → one commit; no spec, no ship |
| **implement** | the usual order, not test-first: the code → its tests → keel runs them; pass → one commit, done; fail → a fix and the tests again (2 rounds); no gate |
| **small** | a short plan with 1–3 criteria ◆ → per criterion a failing test and the code → one review (its blocking findings fixed, 2 rounds) → your one look ◆; no ship |

Start a flow suggests a size from your words (quick, implement, small, change, feature, or fix for a bug) and shows each size's steps and estimate; you pick.
| **fix** | reproduce the bug as a failing test ◆ → find the cause (parallel investigators) ◆ → fix → regression test → ship |
| **diagnose** | a bug you cannot reproduce yet: 3–4 guesses, one investigator each → hand to fix or feature, or write a note |
| **review** | read-only review of the branch, one reviewer per lens; the report word for word |
| **lint** | run the project's formatters and linters (from its stacks and `.keel/config.yml`) → fix the findings without changing behaviour (2 rounds) → `chore(lint)` commit → report ◆ |
| **cover** | measure coverage of the changed lines → per gap: test / delete / accept with a reason |
| **ship** | verify, static checks, release tests, coverage, deps, audit, trace, lens reviewers, final review ◆, memory, PR body ◆ (never pushes) |
| **hunt** · **hunt-next** | read-only bug hunt: hunters per lens, provers reproduce each candidate twice, a report; the top bug goes to fix |
| **init** · **knowledge-refresh** | set a project up (architecture, setup checks, knowledge) · refresh `docs/knowledge/` |

◆ = keel stops and waits for you. The flows are YAML files in `content/workflows/`; the **Workflows** page edits them.
A workflow can sit in a **Folder** (type a name above the blocks; the list groups by folder), and the page shows how
often it ran and opens its last run. A workflow does not need agents: a few code steps (`run: npm test`) and a gate
automate a task without any model. KeelBot writes one for you when you ask.

## Rules

keel checks every agent with rules. **Build › Rules** shows all of them in plain words.

```
 an agent wants to act ──► keel's hook checks it ──► allowed ──► it runs
                              │                                     │
                              └─► refused: the agent reads why      ▼
                                                        after the step: keel compares the files
                                                        and puts back what the phase does not allow
```

- **Always on**: `.env` files, keel's own rule files (`.keel/config.yml`, `.keel/rules/`), old migrations, force push,
  `--no-verify`, commits and history rewrites inside a flow, secrets and switched-off tests in an edit. These never
  switch off.
- **You can switch off**: generated files, build output, `-x test`, new packages, reading a file twice, big-file
  reads, the push gate, MCP tools that change things. Off is saved in `.keel/config.yml` (`rules.off`).
- **Your lists** (`.keel/config.yml`): protected files, generated files, build output, shell commands, `mcp.allow`,
  the big-file limit (`read_guard_max_lines`, default 2000 lines; 0 = off), the push gate, architecture boundaries.
  The page edits them in place; only the `guards`, `mcp`, `rules` and `boundaries` parts are rewritten.
- **Rule packs**: your own rules, one YAML file each in `.keel/rules/`, shared with the team through git. **Library**
  installs one (strict secrets, no new dependencies, migrations only in a flow, frontend can't touch the API, Spring,
  Node, Python); **New rule** writes one with a form or as YAML; **Check and try it** says which of the project's recent
  tool calls it would have refused. Export and Import move a pack between projects.

```yaml
schema: 1
name: no-deploys          # the id and the file name: .keel/rules/no-deploys.yaml
title: No deploys
version: 1.0.0
rules:
  - id: no-kubectl
    kind: bash            # bash | edit | read | mcp
    match: [kubectl apply]
    phases: all           # all | in-flow | none | [green, refactor]
    reason: Deploys are a person's job.
```

The whole format (publisher, summary, `requires`, every field of a rule) is in
[docs/rules/pack-format.md](rules/pack-format.md). A pack file is shaped like a plugin's manifest, so the same file can
later come from the Marketplace; the Rules page shows where each pack came from (keel's library, your own, the
marketplace) and its version.

**Which engine checks what, when.** Each rule on the page shows one sign per engine:

| Sign | Means |
|---|---|
| ✓ | checked **before** the action: it never happens |
| ◐ | checked before for git, gh, the package managers and file printers only |
| ↺ | checked **after the step**: keel puts the file back |
| ✗ | not checked by this engine |

Claude, OpenCode, API-key models and Codex 0.150+ are checked before every action. Copilot has no hook keel can load:
its shell commands go through keel's command wrappers, and its file edits are only checked after each step. The model
picker says so when you choose Copilot or Codex.

**Rules now** on the Flow page says, for the phase that runs: what agents may change (✓), what they may not (✗), what
never (🔒), the files you allowed, your rule packs, which rules stopped something (how often, before the action or after
the step), how well the running engine is checked, and the last command an agent saw fail.

**When keel cannot read the rules** (no guard context, or an error in the hook) it fails closed: only reads pass, and
`.env` files and build output stay refused. Everything else waits until it is fixed.

## KeelBot

Open the Code page and press **⌘I** (or the KeelBot button at the bottom of the left bar), or open **KeelBot** in the
menu. Ask about the project in plain words. KeelBot reads the code, the knowledge pages, the map and the code graph,
and every answer links to the lines (`file:line` opens the editor there).

KeelBot also knows keel itself: the workflows this project can run and its flows. It gives you buttons; nothing
starts or is saved until you press one.

- **Which workflow?** Ask "how do I add a weekly report page?": KeelBot names the workflow that fits and why, and
  gives a **Start the flow** button with a title (you can change it) and the request every agent gets.
- **About a running flow**: "why does Euro prices wait?", "how far is the fix?", "what did it cost?".
- **A workflow of your own**: "make a workflow that runs the linters and the tests, then stops for a look". KeelBot
  writes it with only the steps the task needs (code steps only when no model is needed); keel checks it on the spot
  and shows what it runs. **Save the workflow** (into a folder if you like), or **Ask KeelBot to fix it** when the
  check finds a problem.

- **More room**: hide keel's menu with ‹ next to the bell (or ⌘\; ☰ brings it back); drag KeelBot's left edge to make it wider; **Focus** (in
  the status bar at the bottom, or ⇧⌘\) hides everything but the code; ⤢ in the panel (or **KeelBot** in the menu)
  opens KeelBot alone on its own page, where a `file:line` link opens the Code page at that line. The status bar also
  shows the code graph index and **↻ Rebuild**.
- **Point at things**: select lines and press **Ask** (or ⌘I); type `@` for a file, a symbol or a criterion of the
  running flow; the open file always goes along.
- **Commands**: type `/` — `/explain`, `/where`, `/review`, `/plan`, `/gate` (what the waiting gate asks), `/test`. A
  project can add its own in `.keel/plugins/<name>/plugin.yml` (see `plugins/keelbot/content/plugins/core/plugin.yml`).
- **Ask mode changes nothing**: no edit, no new file, no command that changes files or git, whatever the model.
- **Fix mode** (while a flow waits at a gate): switch to **Fix** and tell KeelBot what to change. It works inside the
  rules of the flow's phase. A command that changes something waits for your OK in the panel or the Inbox (**Allow
  once**, **Always**, **Deny**). The panel lists every changed file with its diff and **Undo**. **Done** runs the tests
  and lets keel commit only those files; if the tests fail, one click hands the failure back to KeelBot.
- **Edit mode** (any time, keel 0.18.7): switch to **Edit** (in `keel2`: `/mode edit`) and KeelBot changes files and runs
  commands in the project folder itself, with no flow. keel's always-on rules still hold (no secrets, no `.git`, no
  applied migration), a command that changes something (`git checkout`, a build) asks you first, and KeelBot never
  commits or pushes: **Keep** runs the checks and makes keel's commit, **Undo** puts a file back.
- **Side sessions** (any time): switch to **Side** to try an idea in KeelBot's own copy of the project (a git
  worktree on its own branch). Nothing touches your project folder or a running flow. **Keep** runs the tests and
  commits on that branch. Then **Make a task**, **Start a flow on the branch** (a change flow writes the tests for it),
  or **Throw away**.
- **Costs**: each answer shows its tokens and time; the budget bar counts them. Claude and Codex continue their own
  session, so a follow-up question is cheap (the context stays cached).
- The model is the `helper` agent's (Agents page); change it for one chat in the panel.

## Thinking effort

Each agent, and KeelBot, has a **thinking effort** next to its model: how hard the model thinks before it acts. More
effort is slower and uses more tokens; less is quicker and cheaper. **default** leaves it to the engine.

- **Where to set it**: the Agents page (per agent, per project), KeelBot's model picker (for one chat), keel TUI
  (`/model` asks for the effort after the model; `/effort high`, `/effort default`), and MCP (`keel_agent_model`, or
  `keel_agent_create` with `effort`; both ask you first).
- **Where you see it**: next to the model everywhere: Agents, Jobs, Live agents, the Flow page, KeelBot's header and
  each answer ("sonnet · high"), keel TUI's job lines and "✓ Finished … · claude/sonnet · high", and `keel_agents`.
  Each agent call keeps the effort it ran with, so the history shows it too.
- **Which models have it**:

| Engine | Efforts | How keel passes it |
|---|---|---|
| Claude Code (subscription) | low, medium, high, xhigh, max (not Haiku) | `claude --effort` |
| Claude API key | low, medium, high, xhigh, max (not Haiku) | `output_config.effort` |
| Codex CLI and OpenAI key | what each model offers (from Codex's model list) | `-c model_reasoning_effort=…` / `reasoning_effort` |
| Copilot through OpenCode | low, medium, high (newer GPT also xhigh; Gemini none) | `opencode run --variant` |
| Copilot CLI, GitHub Models key | none | — |
| Fake model | low, medium, high (only noted, for tests) | — |

A model without an effort setting shows "no effort setting", and keel ignores an effort it cannot pass on.

## Plugins and the Marketplace

From 0.17.0 keel is a small **core** with **plugins**. The core runs flows, workflows, agents, gates, the Inbox,
the budget and connections. Each other part is a plugin with its own version:

| Plugin | What it adds | Needs |
|---|---|---|
| **Code** | the Code page (the IDE) | |
| **Git**, **Code Review**, **Database**, **CI/CD** | their panels in Code, their workflow steps and agent tools | Code (CI/CD also Git) |
| **KeelBot** | the chat (⌘I) and its commands | |
| **Map**, **Graph**, **Wiki** | their pages | |
| **Tasks**, **Jira** | the task board and Jira tickets | Jira needs Tasks |
| **keel Product** (beta) | initiatives and teams | Tasks and Jira |

**Control › Plugins** has three tabs:

- **Installed:** every plugin with its version and an On switch. Turning a plugin on or off restarts keel (about 30 s).
  A plugin that others need goes off together with them, and one that needs others turns them on. Database, Git,
  CI/CD and Code Review also have a **This project** switch: they are on only for the projects you choose.
- **Marketplace:** plugins you can add, with who made them, what they may do ("Runs code in keel"), and what they
  need. keel checks each package's signature before it installs. The public marketplace opens soon; until then it
  shows the plugins of the catalogs you add. The switch at the top finds **Plugins · Workflows · Rules · Skills · Stacks**.
- **Skills** (0.18.6): know-how an agent reads before it works. **From keel** lists keel's own skills (in every
  project already): **Agents…** picks which agents load each. A catalog's skill opens with its whole text and keel's
  review (its size in tokens, its sections); **Install** asks which agents should load it; **Update** asks before it
  replaces a copy you changed; **Remove** takes it away. A skill only adds words to a prompt: keel's rules still decide
  what an agent may do. The same from keel TUI (`/skills`, `/skill attach <id> <agent…>`, `/skill install <name>`,
  `/create skill <what it should teach>`) and from MCP (`keel_skills`, `keel_skill_attach`, `keel_skill_market_install`,
  `keel_skill_create`); KeelBot gives a **Save the skill** card.
- **Stacks** (0.18.9): how a project builds and tests (its test layers, commands and tools). **From keel** lists
  keel's own stacks: they are used wherever they are detected, and a keel pack has **Install pack**. A catalog's stack
  opens with its YAML, every command it runs and keel's check against your project; **Install** saves it as
  `.keel/stacks/<name>.yml`; **Update** and **Remove** as for skills.
- **Sources and rules:** the catalogs keel reads (add one with its URL and public key), and, for plugin authors, a
  `.kplug` file from a path in `/data` (keel marks it **unsigned**).

Click a plugin to see its page: its parts (engine, api, web, content), permissions, versions and what it needs. For
Database, Git, CI/CD and Code Review it also shows what each adds (KeelBot tools, workflow blocks, commands) and a
**Projects** list with a switch per project.
Agents cannot install plugins; they can only **ask**, and you approve in the Inbox.

Start keel with fewer plugins:

| Command | What you get |
|---|---|
| `keel2 start` | keel with every plugin (the `:latest` image) |
| `keel2 start --core` | keel's core only (the `:core` image); add plugins in Control › Plugins |
| `keel2 start --safe` | only the plugins that came with keel, none you installed (when a plugin breaks keel) |

Make your own plugin: [docs/plugins/17-publish-your-plugin.md](plugins/17-publish-your-plugin.md), or let keel build it:
the **plugin** workflow writes its spec (you approve), scaffolds it with `keel-plugin new`, builds each criterion test
first, then runs `keel-plugin lint` and the plugin's tests (`scripts/plugin-check.sh`) and ends at a review gate. How it all works:
[docs/plugins/README.md](plugins/README.md).

## Stacks

**Build › Stacks** shows how each project builds and tests. A stack is one YAML file: its lane (api or web), the
files that show a project uses it, its test layers, its commands (test one criterion, every test, coverage, static
checks, migrate, compile) and its tools (formatters, linters, pre-commit).

- **New stack** asks step by step: lane, the files that detect it, test layers, commands, tools. keel reads your
  project first (package.json scripts, Gradle, Maven, pyproject, composer.json, go.mod, a Makefile, pre-commit) and
  fills each step; you change what you like. Then keel checks it (nothing is saved yet) and **Save the stack** writes
  `.keel/stacks/<name>.yml`.
- **Remove** takes away a stack the project added (its own, an installed pack, one from the marketplace), after a yes.
  keel's own stacks cannot be removed (other projects use them): **Turn off for this project** stops keel using one
  here (`stacks: {ignore: [...]}` in `.keel/config.yml`); **Turn on** brings it back.
- **Find stacks** opens Marketplace › Stacks.

The same from keel TUI (`/stacks`, `/stack <name>`, `/stack remove <name>`, `/stack off <name>`, `/stack install
<name>`, `/create stack`) and MCP (`keel_stacks`, `keel_stack`, `keel_stack_suggest`, `keel_stack_check`,
`keel_stack_create`, `keel_stack_remove`, `keel_stack_off`, `keel_stack_market_install`). Ask KeelBot "write a stack
for this project": it gives a **Save the stack** card, checked by keel first.

## Plugins: Database, Git and CI/CD

Turn them on in **Control › Plugins**: in **Installed**, the plugin's **This project** switch (or **For every
project**); its own page lists every project with its switch. Nothing new to learn: they add to the
pages you use.

- **Database**: add the project's database in **Connections › Databases** (keel suggests what docker compose,
  `.env.example` or Spring's config name; the password is saved encrypted). Then:
  - ask KeelBot data questions ("which players have no score?") — it reads the schema, runs one read-only query and
    shows the rows; `/sql` does it directly;
  - **Map › Database (ER) › Query**: click a table for its first rows, or write SQL;
  - workflows get `db:query`, `db:check` (a data check: `expect: none`), `db:change` and `db:migrate` blocks — a
    workflow of code steps only checks your data with no model and no tokens.
  A change of data (INSERT, UPDATE, DELETE) runs only on a **local** or **test** database: keel counts the rows first,
  then you press **Run it**. Staging and prod are read only for everyone. Schema changes belong in your migrations.
- **Git**: add a token in **Connections › GitHub**. Then **Code › Source control** shows the branch against its
  remote and main, **Push**, **Update from main**, **Switch branch**, **New branch**, a commit box, and the pull
  request with its CI checks and review comments (**Ask KeelBot to address the comments**). KeelBot reads git and the
  PR (`/commit`, `/pr`, `/sync`, `/branch` draft the next step) and gives buttons; workflows get `git:sync`,
  `git:push`, `git:pr`, `git:pr-checks` (wait for CI), `git:branch` and `git:cleanup`. keel never force-pushes and never
  pushes to main.
  Under **Branches**, click a branch (for example `feat/test`) to open it as a tab: the files it changed since it left
  main (click one for its diff), its commits that main does not have, **Switch to feat/test**, and **Ask KeelBot to
  review it**. Switching keeps your uncommitted work; git stops when a change would be lost.
- **Database tool (Code page)**: with the Database plugin on, the Code page gets a **Database** activity, like the
  database window of an IntelliJ IDE: every connection as a tree of tables and columns (keys, types, foreign keys).
  Click a table for its data (and its structure); press the console icon on a connection for a query console
  (⌘↵ runs the statement under the cursor). Several connections side by side: a local, a test and a read-only prod.
- **CI/CD**: keel watches the pipelines on GitHub Actions (with the GitHub token) and tells you when one fails.
  **Run › Jobs › Pipelines** shows the runs; open a failed one for its failed jobs and the end of the log, then
  **Fix it** (the ci-fix flow: read the failure, fix, commit, push, wait for CI), **Run the failed jobs again**, or
  **Ask KeelBot why** (`/ci`). **Settings › When CI fails**: tell me, start the fix flow by itself, or nothing.
- **Claude Code**: `keel2 mcp` adds the read tools (`keel_db_query`, `keel_git_status`, `keel_ci_failure` …);
  `keel2 mcp --write` also the acting ones, and each waits for your **Allow** in keel's Inbox.
- **Code Review in the terminal** (0.18.6): with the Code Review plugin on, keel TUI (`keel2 tui`) has a **review mode**.
  `/review` opens the branch you are on, `/review 12` pull request #12; it takes the whole screen (keel's header and
  status line stay) until **Esc**. ↑↓ and **Enter** open a changed file's diff, with the threads, your drafts and keel's
  findings under their lines; `]` `[` go to the next file, `}` `{` to the next change. Keys: **c** a line comment (a
  draft), **r** reply, **x** resolve, **v** viewed, **e** / **f** ask keel to explain the change or find problems, **o** /
  **F** read them, **s** submit (approve, request changes or comment: keel asks first), **p** another pull request,
  **?** all keys. `/review prs` lists the open pull requests. `keel2 mcp` has the same: `keel_review_prs`,
  `keel_review_files`, `keel_review_diff`, `keel_review_notes`, and with `--write` `keel_review_comment`,
  `keel_review_explain`, `keel_review_findings`, `keel_review_reply`, `keel_review_resolve`, `keel_review_submit` (the
  last three post to GitHub or GitLab, so your client asks you first). Any plugin can add a mode like this:
  [docs/plugins/25-tui-plugins.md](plugins/25-tui-plugins.md).

## Quality

**Build › Quality** shows how well keel's flows work with each model. keel runs small eval projects (in
`content/evals/`) through the flows you pick, in run mode **auto**, one case at a time, and scores each run from 0 to
100: did it reach the end, how often was something sent back, and did it stay within the token estimate. Pick one or
two models and press **Run now**, or turn on **Every night at …**. When a score falls by 15 points or more since the
run before, the page shows it in red: check the last change to a prompt, an agent, a skill or a model. The runs' tokens
count in the budget.

## Inbox and run modes

**Inbox** lists everything that waits for you in every project: gates, the explorer's questions, a check that keeps
failing, a budget pause, a new dependency. Answer it there or open its flow.

Each flow has a run mode. Pick it in *Start a flow* (the default is in Settings), and change it on the Flow page while
the flow runs.

| Run mode | keel decides by itself |
|---|---|
| **manual** (default) | nothing: it stops at every gate |
| **important** | a criterion's gate, when its checks pass and its review is clean |
| **auto** | every gate it can decide (plain approve, the default choice, the recommended answers); each is logged and listed in the final review and the PR body; it never opens a PR |
| **readonly** | nothing; agents cannot edit, write or commit anything |

In every mode keel still stops for the token cap, a new dependency, a secret in a commit, a check that keeps failing,
and anything only you can answer. It never pushes.

## Tasks and Jira

**Tasks** is a board of your work: your own tasks, or the tickets of a Jira board or query (Connections › Jira, per
project: Jira Cloud with email + API token, or Server / Data Center with a personal access token).

Press **Start** on a task and keel runs a flow for it (bug → fix, story → feature, task → change). It moves the Jira
ticket to In progress, to In review when the PR opens (and asks the reviewers on GitHub and in Jira), and to Testing
(PP) when the PR is approved. Then the Inbox asks you to confirm PP testing and the release. When keel cannot reach
Jira, the Inbox asks you to move the real ticket by hand. Without Jira, tasks stay in keel with their history.
Details: [CONTRACT.md](CONTRACT.md), "v0.5.0: tasks and Jira".

## Logins

The image has claude, codex, copilot and opencode installed. Nothing from your computer is copied in. Each login is
saved encrypted in keel's own database (the `keel-data` volume), so it survives restarts and updates.

| Tool | Log in from the dashboard | Or paste |
|---|---|---|
| Claude (subscription) | sign in on claude.com, paste the code it shows | `claude setup-token` on your computer |
| Codex (ChatGPT) | open the device link, type the code | `~/.codex/auth.json` |
| GitHub Copilot | open github.com/login/device, type the code | a token with "Copilot Requests" |

From the terminal: `keel2 token <claude|codex|copilot>`, and `keel2 tokens` to list them. A long token is often shown over two lines; send it in one piece from the clipboard: `pbpaste | keel2 token claude` (Linux: `wl-paste | keel2 token claude`). keel checks the token before it saves it and says what is wrong.

## Signing in

keel answers only you. There is no password: `keel2 start` and `keel2 open` open keel in your browser already signed
in. A browser that is not signed in shows one screen: "Run keel2 open in a terminal".

```bash
keel2 open            # open keel signed in (a link that works once, for 60 seconds)
keel2 open --print    # print that link, to open it in another browser
keel2 auth reset      # a new key: every browser signs in again (keel restarts)
```

Other programs on your computer, and web pages, cannot change anything in keel. keel2, keel's MCP server and keel's
own engine bring their own keys. keel's agents never read those keys (a rule that cannot be switched off).

## Use keel from Claude Code or Claude Desktop (MCP)

keel has an MCP server with three levels; each includes the one below:

| level | how | adds |
|---|---|---|
| read (default) | `keel2 mcp` | status, timeline, next step, phase rules, dashboard links, flows, Inbox, live agents, budget, specs (with history), knowledge, search, read a file, engine actions, keel's rules (`keel_rules`) |
| write | `keel2 mcp --write` | decide or send back a gate, answer the Inbox, start a flow, restore a spec, git / PR / CI / database writes |
| admin | `keel2 mcp --admin` | stop and delete flows, add and remove projects, change workflows, install and change rules |

```bash
keel2 mcp --print-config                                 # the Claude Code line and Claude Desktop JSON per level
claude mcp add keel-v2 -- "$(command -v keel2)" mcp --write
```

Pushes, database changes, deletes and stops ask you first in the client; a client that cannot ask is refused unless
you add `--yes`. `--allow keel_status,keel_approve_gate` keeps only those tools. Everything the client changes shows
on the flow's timeline as "via MCP · <client>: <tool>". keel's own agents always get the read level.

| keel v1 MCP | keel v2 MCP |
|---|---|
| keel_status, keel_projects, keel_timeline, keel_next, keel_explain | the same names |
| keel_dashboard (flow, map, er) | keel_dashboard (flow, map, er) |
| — | keel_flows, keel_inbox, keel_live, keel_budget, keel_specs, keel_knowledge, keel_search, keel_read_file, keel_actions (read); write and admin tools (v1 has none) |

keel v1 is a separate project; its MCP server can be added like any other: `keel2 start --with-keel-v1 <keel
checkout>`, then turn on "keel v1 (optional)" in Tools.

## Where keel keeps its files (layouts)

keel reads keel v1's `layout:` from `.keel/config.yml`: `repo` (specs in `docs/specs` or `specs`, `docs/knowledge`,
`docs/adr`, `docs/RUNNING.md`, committed with your code), `keel` (all of it in `.keel/`, which keel hides from git in
`.git/info/exclude`) or `external` (`.keel` is a link to a folder outside the repo; add that folder too:
`keel2 add <folder>`). A new project gets `keel`. A project that has keel files in `docs/` keeps them there. A project
with both `.keel/specs` and `docs/specs` shows both in the Wiki and in Code › keel files.

keel keeps every version of these files in its own database, because `.keel/` is not in git: each Wiki page of a
spec, a knowledge section or a decision has a **History** (who changed it, in which step, a diff, Restore), Code ›
keel files shows a file that went missing with a **Restore** button, and the Flow page lists what keel applied
(branch, commits, files).

In the **Wiki** (0.17.3) every menu section (Specs, Knowledge base, Workflows, Runbook, Decisions) opens and closes
with its ▾/▸ title; a closed one shows how many pages it has, keel remembers your choice per project in this browser,
and the section of the page you read stays open (on a phone, the same in the Page dropdown). Each spec has a pill:
**built**, **in progress**, **stopped** or **not built**. A spec's page shows its **Build status**: the flow that built
it (a link), the flow that builds it now (its phase, the gate it waits at, **Open the flow**), **Resume** for a stopped
flow (only the last stopped flow can be resumed; otherwise it says why), and **Start a flow from this spec** (the
feature flow, started from this spec and its criteria, with the estimate first). keel knows this from the flows that
wrote the spec (its History) and the flows started from it.

## Native mode (no Docker)

```bash
keel2 start --native ~/Projects/shop        # Java 21, uv and git on this computer; Node 20+ for the agent CLIs
```

keel runs on your computer instead of in a container: the engine and the api start from `~/.keel2/<KEEL_NAME>/`
(the release is downloaded and checked once; `keel2 update` gets the next one, `keel2 update --rollback` goes back).
Every other command works the same: `status`, `stop`, `logs`, `doctor`, `mcp`, `add`, `backup` …

**Agents run as you**: they can read what you can (your SSH keys, other projects, your network). In Docker they only
see the project folders. Docker stays the default; use native mode only on a computer and projects you trust. keel
gives the agent CLIs a home of their own under its data folder, so your own `~/.claude`, `~/.codex` and
`~/.copilot` are never touched.

## Docker mode

The image has JDK 21, Node 20, Python 3.12 and the Docker CLI (compose, buildx). `keel2 start --docker` mounts your
Docker socket and the project at the **same path** as on your computer, so Testcontainers and compose bind mounts
work. Docker access is as strong as root on your computer: use it only for projects you trust.

## Several project folders

`keel2 start <folder>` gives keel one folder. To add projects from other places, name them, several at once:

```bash
keel2 add ~/Projects/api ~/Work/web ~/Projects/clients   # each a git repo, or a folder of git repos
keel2 folders                                            # the main folder and the added ones
keel2 remove ~/Work/web                                  # off the list; keel keeps its history
```

The list is kept per keel in `~/.config/keel2/<KEEL_NAME>.folders`. If keel runs, `add` and `remove` restart it once
(they ask first when agents are working). Each added folder is mounted at the **same path** as on your computer, and
every git repo in it becomes a project (a folder of repos: each repo directly inside it). More repos later? All
projects › Add projects lets you pick them. A folder that no longer exists is skipped (`keel2 folders` marks it).

**A second keel** (`KEEL_NAME=keel-lab PORT=8097 ./keel2 start …`) gets its own data: the volume is `<KEEL_NAME>-data` (`keel-data` only for the default `keel-v2`; `KEEL_VOLUME` sets another). keel2 refuses to start a keel, restore a backup or delete data on a volume another running keel uses: two keels on one volume would write one database at the same time.

## Problems

Run `keel2 doctor` first. The most common ones:

| You see | Do this |
|---|---|
| "Docker is not running" | start Docker Desktop (keel2 starts it on a Mac) |
| "not a git repository" | say yes when keel2 offers `git init` |
| port 8080 is busy | nothing: keel2 uses the next free port and tells you |
| an agent "is not logged in" | Connections › Set up login |
| your tests start containers | `keel2 start --docker <folder>` |

All commands: `keel2 help` (logs, tokens, backup, restore, uninstall …).

## Folders in the container

| Folder | What |
|---|---|
| `/workspace` | your project (one git repo, or a folder of repos); its real path with `--docker` |
| the same path as on your computer | each folder added with `keel2 add` |
| `/data` | keel's database, flow checkpoints, encrypted logins |
| `/opt/keel-v2/content` | keel v2's agents, skills, stacks, packs, templates and workflows |
| `/opt/keel-v1-optional` | only with `--with-keel-v1`: that keel v1 checkout, read-only, for its MCP server |

## Without the install script

```bash
docker run -d --name keel-v2 -p 127.0.0.1:8080:8080 \
  -v /path/to/your/project:/workspace -v keel-data:/data \
  ghcr.io/miladnalbandi/keel-v2
```

## Develop keel v2

| Part | Tech | Run | Tests |
|---|---|---|---|
| `engine/` | Python 3.12, FastAPI, LangGraph, LangChain, MCP | `uv run keel-engine` (:8090) | `uv run pytest` |
| `api/` | Kotlin, Spring Boot 3, SQLite, Flyway | `./gradlew bootRun` (:8080) | `./gradlew test` |
| `web/` | React, TypeScript, Vite | `npm run dev` (:5173) | `npm test` |

How the parts talk: [CONTRACT.md](CONTRACT.md).

```bash
docker build -t keel-v2 .                                 # everything is installed in the image
docker build --build-arg INSTALL_CLIS=0 -t keel-v2:slim . # without the agent CLIs
npx -y -p playwright@1 node docs/gif/record.js            # record the README's GIF from a running keel
scripts/no-v1.sh                                          # lists anything that still depends on keel v1 (CI: 0)
```

A version tag (`v*`) builds amd64 + arm64 images and pushes them to `ghcr.io/miladnalbandi/keel-v2` (and to Docker
Hub when the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` secrets are set). Dependabot (`.github/dependabot.yml`) opens a
pull request every week for each part's dependencies, the Docker base images and the GitHub Actions.
