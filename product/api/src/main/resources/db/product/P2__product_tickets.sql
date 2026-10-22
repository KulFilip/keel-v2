-- The Jira tickets keel Product made above the stories (the initiative, each epic). A second send, a send of the
-- stories left, or a new plan version finds them here and puts its stories under them instead of making twins.
CREATE TABLE product_tickets (
    initiative_id TEXT NOT NULL,
    level         TEXT NOT NULL,             -- initiative, epic
    ref           TEXT NOT NULL,             -- the epic id (PAY); the initiative id for the initiative
    site          TEXT NOT NULL,             -- the Jira base URL
    jira_project  TEXT NOT NULL,
    jira_key      TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (initiative_id, level, ref, site, jira_project)
);
