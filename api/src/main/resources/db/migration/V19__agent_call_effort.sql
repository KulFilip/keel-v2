-- keel 0.18.9: the thinking effort an agent call ran with (low | medium | high | xhigh | max, the provider's own words),
-- so Jobs, Live agents and the history show it. NULL: the engine's own default, or a model with no effort setting.
ALTER TABLE agent_calls ADD COLUMN effort TEXT;
