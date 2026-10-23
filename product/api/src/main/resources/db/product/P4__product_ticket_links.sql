-- What keel found in the teams' git: a branch or a commit and the ticket key in it (by the team's key pattern).
-- key '' = no team's pattern matched (the "no ticket key" list). A scan replaces a project's rows.
CREATE TABLE product_ticket_links (
    project_id TEXT NOT NULL,
    kind       TEXT NOT NULL,                -- branch, commit
    ref        TEXT NOT NULL,                -- the branch name; the commit sha
    key        TEXT NOT NULL,                -- SHOPS-1234, or ''
    team_id    TEXT,                         -- whose pattern matched
    title      TEXT,                         -- the commit's subject; the branch's last commit subject
    author     TEXT,
    at         TEXT,                         -- commit time (ISO)
    files_json TEXT,                         -- a commit's files (at most 50)
    PRIMARY KEY (project_id, kind, ref, key)
);
CREATE INDEX product_ticket_links_by_key ON product_ticket_links (key);

CREATE TABLE product_scans (
    project_id TEXT PRIMARY KEY,
    at         TEXT NOT NULL,
    branches   INTEGER NOT NULL DEFAULT 0,
    commits    INTEGER NOT NULL DEFAULT 0,
    linked     INTEGER NOT NULL DEFAULT 0,
    error      TEXT
);
