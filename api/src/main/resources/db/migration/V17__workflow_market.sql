-- the plugin track's workflow marketplace (docs/plugins/21-workflow-marketplace.md §3): a workflow installed from a
-- catalog remembers where it came from. NULL for every other workflow (keel's, yours, the library's). V17: the number
-- after the track's V16__approvals.sql; a port from main renames the track's unreleased migrations when main releases
-- one with the same number.
--   market_catalog   the catalog (source id) it came from
--   market_name      its name in that catalog
--   market_version   the version installed (1.2.0)
--   market_sha256    the sha256 of the YAML keel wrote: a copy whose YAML differs was changed by the person
ALTER TABLE workflows ADD COLUMN market_catalog TEXT;
ALTER TABLE workflows ADD COLUMN market_name TEXT;
ALTER TABLE workflows ADD COLUMN market_version TEXT;
ALTER TABLE workflows ADD COLUMN market_sha256 TEXT;
