-- keel 0.18.6: a skill installed from a marketplace catalog remembers where it came from (like V17 for workflows).
-- NULL for every other skill (the person's own, or one imported from a link).
--   market_catalog   the catalog (source id) it came from
--   market_name      its name in that catalog
--   market_version   the version installed (1.2.0)
--   market_sha256    the sha256 of the SKILL.md keel saved: a copy whose text differs was changed by the person
ALTER TABLE custom_skills ADD COLUMN market_catalog TEXT;
ALTER TABLE custom_skills ADD COLUMN market_name TEXT;
ALTER TABLE custom_skills ADD COLUMN market_version TEXT;
ALTER TABLE custom_skills ADD COLUMN market_sha256 TEXT;
