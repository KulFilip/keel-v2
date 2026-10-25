-- keel 0.18.52 task automations (docs/plans/task-automations.md): per-project rules, KeelBot-owned tickets' PR watch,
-- the review flows keel started for a task, and the JSON of a proposal or review-comment Inbox item.

CREATE TABLE task_automations (
    project_id  TEXT PRIMARY KEY,
    json        TEXT NOT NULL,                          -- rules per keel status, keelbot owner, switches
    updated_at  TEXT NOT NULL
);

-- A task keel watches: owned = 1 when its ticket is assigned to KeelBot; seen = ["<thread id>:<comment id>", ...].
CREATE TABLE task_watch (
    task_id     TEXT PRIMARY KEY,
    pr_url      TEXT,
    owned       INTEGER NOT NULL DEFAULT 0,
    seen        TEXT NOT NULL DEFAULT '[]',
    looked      INTEGER NOT NULL DEFAULT 0,             -- 1 after the first look (its comments were the baseline)
    updated_at  TEXT NOT NULL
);

-- Flows keel started for a task without changing its status (a review, addressing a review comment).
CREATE TABLE task_runs (
    thread_id    TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL,
    kind         TEXT NOT NULL,                         -- review | address
    workflow_id  TEXT,
    created_at   TEXT NOT NULL
);
CREATE INDEX task_runs_task ON task_runs(task_id);

ALTER TABLE task_inbox ADD COLUMN data TEXT;
