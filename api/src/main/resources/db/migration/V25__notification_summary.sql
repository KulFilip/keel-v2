-- keel 0.18.55 readable notifications: a few short lines (a JSON array of text) beside the full body. The toast and the
-- bell list show them; the Inbox and an opened notification keep the full body.
ALTER TABLE notifications ADD COLUMN summary TEXT;
