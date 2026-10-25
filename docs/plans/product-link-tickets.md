# keel Product: link the tickets you already have (B6)

Status: built on branch fix/jira-e2e. Found by the product edition + Jira e2e test.

## The problem

keel Product knew only two kinds of tickets:

- the tickets it **made** itself (Send to Jira, from the plan), and
- the ticket **keys it found in git** (branch names, commit messages).

But a team often has the tickets already: they are in Jira, and keel's Tasks board shows them (the Jira plugin syncs
them). keel Product could not use them. You could not say "SHOPS-1234 belongs to this initiative", and the Product
map's "Tickets and work" showed only keys from git.

## What you see

On an initiative's page, a new panel **Tickets**:

```
+-- Tickets ------------------------------------------------------------+
| Tickets on the teams' Tasks boards that belong to this initiative.    |
|                                                                       |
|  SHOPS-1234  Coupon applies once        In progress  Jira: In Review  |
|              shop · ana · 2 branches, 5 commits          [Unlink]     |
|  SHOPS-1240  Cart total in euro         To do        Jira: To Do      |
|              shop · bo                                   [Unlink]     |
|                                                                       |
|  [ Add tickets ]                                                      |
|                                                                       |
|  +-- Add tickets ---------------------------------------------------+ |
|  | Search  [ coupon                  ]   [x] only this initiative's | |
|  |                                           repos                  | |
|  |  [ ] SHOPS-1251  Coupon for new users   To do     shop           | |
|  |  [x] SHOPS-1252  Coupon report          To do     shop           | |
|  |                                                                  | |
|  |  [ Link 1 ticket ]  [ Close ]                                    | |
|  +------------------------------------------------------------------+ |
+-----------------------------------------------------------------------+
```

- The list shows each linked ticket with its keel status, its Jira status, the project, the assignee and the work
  keel found for its key in git.
- **Add tickets** searches the Tasks boards (Jira tickets and local tasks) by key or title. By default only the
  initiative's repos; untick the box to search every project.
- **Unlink** takes a ticket out of the initiative. Nothing changes in Jira.

On the **Product map**, "Tickets and work" gets a second list, **On the Tasks boards**: the team projects' Jira
tickets with their status, the initiative each one belongs to, and its git work. Keys from git stay as they were.

```
+-- Tickets and work ---------------------------------------------------+
| On the Tasks boards                                                   |
|  SHOPS-1234  Coupon applies once   In progress  INI-3   5 commits     |
|  SHOPS-1240  Cart total in euro    To do        INI-3                 |
|  SHOPS-1300  Fix the login page    In review    -       2 commits     |
|                                                                       |
| Keys found in git   (as before)                                       |
+-----------------------------------------------------------------------+
```

## API (only new endpoints; the old ones stay)

| Method and path                                        | What it does                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/initiatives/{id}/tickets`                    | the linked tickets, each with its task (status, Jira status, link) and its git work                                       |
| `GET /api/initiatives/{id}/tickets/candidates?q=&all=` | tickets on the Tasks boards that are not linked yet; the initiative's repos, or every project with `all=true`; at most 50 |
| `POST /api/initiatives/{id}/tickets`                   | body `{ "tasks": ["tk_…"] }` or `{ "keys": ["SHOPS-1234"] }`: link them; answers the list                                 |
| `DELETE /api/initiatives/{id}/tickets/{key}`           | unlink one; answers the list                                                                                              |

`GET /api/initiatives/{id}` also has `linked` (the same list), and `GET /api/product/map` has `board` (the board
tickets of the team projects). Errors keep the `{error, hint}` shape: an unknown initiative or task is 404, an empty
or bad body 400, an unknown key (no task has it) 404 with a hint.

## Data

A new keel Product migration, `P7__product_initiative_tickets.sql` (Product has its own Flyway history):

```
product_initiative_tickets
  initiative_id  TEXT     the initiative (INI-3)
  key            TEXT     the Jira key (SHOPS-1234); a local task's id (tk_…) when it has no key
  project_id     TEXT     the keel project whose Tasks board has it
  task_id        TEXT     the task, when keel knows it
  added_at       TEXT
  PRIMARY KEY (initiative_id, key)
```

The ticket's title and status are not copied: they are read from the Tasks board each time, so they stay right
after a Jira sync. A ticket whose task is gone still shows, with "not on a Tasks board now".

## Steps

1. Migration P7, store methods (link, unlink, list by initiative, list by keys).
2. Service: list with live task data and git work, candidates, link, unlink.
3. Endpoints in ProductController; `linked` on the initiative, `board` on the Product map.
4. Web: the Tickets panel and the Add tickets picker on the initiative page; "On the Tasks boards" on the Product map.
5. Tests: api (link, list, candidates, unlink, errors, the map) and web (picker, unlink, the map list).
