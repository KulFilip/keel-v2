-- 0.18.57 what a flow works on, when its start names it (review-pr: pr:20 or branch:feature/x, from the engine's start),
-- and the newer run of the same source that replaced a failed or stopped one: the history keeps both, the runs list
-- marks the older one instead of piling up look-alike failures.
ALTER TABLE threads ADD COLUMN source TEXT;
ALTER TABLE threads ADD COLUMN replaced_by TEXT;
