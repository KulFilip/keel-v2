-- keel Product (docs/plans/product-link-tickets.md, B6): tickets already on the teams' Tasks boards (Jira tickets
-- or local tasks) that a product manager links to an initiative. Title and status are not copied: they are read from
-- the Tasks board each time.
CREATE TABLE product_initiative_tickets (
    initiative_id TEXT NOT NULL,
    key           TEXT NOT NULL,                -- the Jira key (SHOPS-1234); a local task's id (tk_…) when it has none
    project_id    TEXT,                         -- the keel project whose Tasks board has it
    task_id       TEXT,
    added_at      TEXT NOT NULL,
    PRIMARY KEY (initiative_id, key)
);
CREATE INDEX product_initiative_tickets_by_key ON product_initiative_tickets (key);
