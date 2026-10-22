-- The plan's epics as drafts the product manager edits before anything goes to Jira (the stories are
-- product_plan_items), and keel Product's own settings (where an initiative's Jira ticket goes).
CREATE TABLE product_plan_epics (
    initiative_id TEXT NOT NULL,
    version       INTEGER NOT NULL,
    id            TEXT NOT NULL,             -- PAY
    team          TEXT,
    title         TEXT NOT NULL,
    PRIMARY KEY (initiative_id, version, id)
);

CREATE TABLE product_settings (
    key        TEXT PRIMARY KEY,             -- initiative_jira
    json       TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
