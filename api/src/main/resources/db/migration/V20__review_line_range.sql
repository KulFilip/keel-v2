-- The Code Review plugin's multi-line comments: a pending comment on a range of lines starts at start_line on
-- start_side and ends at line on side (both NULL for a comment on one line).
ALTER TABLE review_drafts ADD COLUMN start_line INTEGER;
ALTER TABLE review_drafts ADD COLUMN start_side TEXT;
