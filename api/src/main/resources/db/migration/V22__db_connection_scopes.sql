-- The Database plugin's connections, global or per project (plugins/db). V22: the review agents' rename took V21.
--   scope        project_id '*' is a global connection (as project_plugins does); db_connection_projects narrows a
--                global one to some projects (no row: every project), db_connection_hidden turns one off in a project.
--   fields       what the editor shows (driver, how keel connects, host, port, user, default database, ...). The
--                password is never here: the whole address stays in keel's secret store (db.<id>), as before.
--   agents       agent_access none | read | write_approve, ask_first, keep_password keel | session | never.
-- The rows a keel had before have no driver yet: the plugin's api reads each one's address once and fills the fields
-- (DatabaseStore.backfill), so their secrets keep working unchanged.
ALTER TABLE db_connections ADD COLUMN driver TEXT;
ALTER TABLE db_connections ADD COLUMN connect_mode TEXT NOT NULL DEFAULT 'url';
ALTER TABLE db_connections ADD COLUMN host TEXT;
ALTER TABLE db_connections ADD COLUMN port INTEGER;
ALTER TABLE db_connections ADD COLUMN username TEXT;
ALTER TABLE db_connections ADD COLUMN default_db TEXT;
ALTER TABLE db_connections ADD COLUMN url_override TEXT;
ALTER TABLE db_connections ADD COLUMN socket_path TEXT;
ALTER TABLE db_connections ADD COLUMN env_var TEXT;
ALTER TABLE db_connections ADD COLUMN note TEXT;
ALTER TABLE db_connections ADD COLUMN agent_access TEXT NOT NULL DEFAULT 'read';
ALTER TABLE db_connections ADD COLUMN ask_first INTEGER NOT NULL DEFAULT 0;
ALTER TABLE db_connections ADD COLUMN keep_password TEXT NOT NULL DEFAULT 'keel';
ALTER TABLE db_connections ADD COLUMN updated_at TEXT;

CREATE TABLE db_connection_projects (
    connection_id  TEXT NOT NULL,
    project_id     TEXT NOT NULL,
    PRIMARY KEY (connection_id, project_id)
);

CREATE TABLE db_connection_hidden (
    connection_id  TEXT NOT NULL,
    project_id     TEXT NOT NULL,
    PRIMARY KEY (connection_id, project_id)
);
