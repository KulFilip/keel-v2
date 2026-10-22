-- The four review agents got names that say when each runs (keel.api.agents.AgentNames, engine agent_names.py):
--   ac-reviewer -> criterion-reviewer, code-reviewer -> branch-reviewer, reviewer -> lens-reviewer,
--   ticket-reviewer -> pr-reviewer.
-- A project's agent override (model, effort, tools, prompt ...) saved under an old name moves to the new name; when the
-- project already has one under the new name, that one wins and the old row goes. The api still reads an old name as
-- the new one, so nothing depends on this having run.

UPDATE agent_overrides SET agent_id = 'criterion-reviewer' WHERE agent_id = 'ac-reviewer'
    AND NOT EXISTS (SELECT 1 FROM agent_overrides o WHERE o.project_id = agent_overrides.project_id AND o.agent_id = 'criterion-reviewer');
UPDATE agent_overrides SET agent_id = 'branch-reviewer' WHERE agent_id = 'code-reviewer'
    AND NOT EXISTS (SELECT 1 FROM agent_overrides o WHERE o.project_id = agent_overrides.project_id AND o.agent_id = 'branch-reviewer');
UPDATE agent_overrides SET agent_id = 'lens-reviewer' WHERE agent_id = 'reviewer'
    AND NOT EXISTS (SELECT 1 FROM agent_overrides o WHERE o.project_id = agent_overrides.project_id AND o.agent_id = 'lens-reviewer');
UPDATE agent_overrides SET agent_id = 'pr-reviewer' WHERE agent_id = 'ticket-reviewer'
    AND NOT EXISTS (SELECT 1 FROM agent_overrides o WHERE o.project_id = agent_overrides.project_id AND o.agent_id = 'pr-reviewer');
DELETE FROM agent_overrides WHERE agent_id IN ('ac-reviewer', 'code-reviewer', 'reviewer', 'ticket-reviewer');

-- Skill assignments ({"agents": [...], "when": ..., "enabled": ...}): the agent names in the list. A name appears only as
-- a quoted JSON string, so the quoted old name is replaced; a list that ends up naming an agent twice is read once.
UPDATE skill_assign SET json = replace(json, '"ac-reviewer"', '"criterion-reviewer"') WHERE json LIKE '%"ac-reviewer"%';
UPDATE skill_assign SET json = replace(json, '"code-reviewer"', '"branch-reviewer"') WHERE json LIKE '%"code-reviewer"%';
UPDATE skill_assign SET json = replace(json, '"reviewer"', '"lens-reviewer"') WHERE json LIKE '%"reviewer"%';
UPDATE skill_assign SET json = replace(json, '"ticket-reviewer"', '"pr-reviewer"') WHERE json LIKE '%"ticket-reviewer"%';
