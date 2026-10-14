-- v0.15.9 keel's file history. In the keel and external layouts keel's files (.keel/) are outside git, so keel keeps
-- every version of a spec, a knowledge section, an ADR and the runbook here (the file on disk stays the current text;
-- this is history only), and what each flow applied on top of the repo: its branch, worktree, commits and files.
CREATE TABLE doc_versions (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL,
    path        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    version     INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    content     TEXT,
    size        INTEGER NOT NULL,
    deleted     INTEGER NOT NULL DEFAULT 0,
    by_kind     TEXT NOT NULL,
    by_name     TEXT,
    via         TEXT,
    thread_id   TEXT,
    step        TEXT,
    phase       TEXT,
    commit_sha  TEXT,
    at          TEXT NOT NULL,
    UNIQUE (project_id, path, version)
);
CREATE INDEX doc_versions_path ON doc_versions (project_id, path, version DESC);
CREATE INDEX doc_versions_thread ON doc_versions (thread_id);

CREATE TABLE flow_applied (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT NOT NULL,
    thread_id   TEXT NOT NULL,
    kind        TEXT NOT NULL,
    ref         TEXT NOT NULL,
    subject     TEXT,
    files_json  TEXT,
    at          TEXT NOT NULL
);
CREATE INDEX flow_applied_thread ON flow_applied (thread_id, at);
