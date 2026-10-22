-- The business flows the flow analysts found per repo (product-flows workflow; the file flows/<project>.json in the
-- product repo is the versioned copy), and the runs that found them. A flow the product manager renamed or hid keeps
-- those changes when the flows are found again.
CREATE TABLE product_flows (
    project_id TEXT NOT NULL,
    id         TEXT NOT NULL,                -- checkout
    name       TEXT NOT NULL,
    summary    TEXT,
    team       TEXT,
    data_json  TEXT NOT NULL,                -- steps, endpoints, tables
    edited     INTEGER NOT NULL DEFAULT 0,
    hidden     INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, id)
);

CREATE TABLE product_flow_runs (
    thread_id     TEXT PRIMARY KEY,
    projects_json TEXT NOT NULL,
    status        TEXT NOT NULL,             -- running, done, failed, stopped
    error         TEXT,
    started_at    TEXT NOT NULL,
    ended_at      TEXT
);
