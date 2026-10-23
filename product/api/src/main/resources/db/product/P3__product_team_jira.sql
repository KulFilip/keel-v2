-- A team's own Jira (which connection, issue types, Epic Link field, labels, component) and its ticket-key pattern
-- (SHOPS-\d+), which keel uses to link branches and commits to tickets.
ALTER TABLE product_teams ADD COLUMN jira_json TEXT;
ALTER TABLE product_teams ADD COLUMN key_pattern TEXT;
