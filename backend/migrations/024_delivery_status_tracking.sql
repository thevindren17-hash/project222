-- Track real WhatsApp delivery outcome, not just "Meta's API accepted the
-- send". Meta reports actual delivery via a separate webhook payload
-- (entry[].changes[].value.statuses[]) keyed by the message id it returned
-- at send time -- until now nothing captured that id, so there was no way
-- to match a later delivery/failure notification back to our own rows.
-- No CHECK constraint on delivery_status, consistent with campaigns.status
-- already being free text elsewhere in this schema.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_status TEXT DEFAULT 'sent';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_error TEXT;

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS wa_message_id TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS delivery_status TEXT DEFAULT 'sent';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS delivery_error TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_wa_message_id
    ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_campaigns_wa_message_id
    ON campaigns(wa_message_id) WHERE wa_message_id IS NOT NULL;
