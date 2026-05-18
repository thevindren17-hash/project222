-- ── Opt-out flag on contacts ──────────────────────────────────────────────────
-- Lets patients unsubscribe from recall / feedback campaigns via a STOP reply.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS opted_out boolean NOT NULL DEFAULT false;

-- Index so campaign queries can efficiently skip opted-out contacts
CREATE INDEX IF NOT EXISTS idx_contacts_opted_out ON contacts (tenant_id, opted_out) WHERE opted_out = false;

-- ── Webhook dedup table ────────────────────────────────────────────────────────
-- Atomic duplicate-detection for inbound WhatsApp webhooks.
-- The webhook handler does INSERT (not SELECT); a unique conflict = duplicate.
-- Meta message IDs are unique globally, so a shared primary key is safe.
CREATE TABLE IF NOT EXISTS webhook_dedup (
    wa_message_id text        PRIMARY KEY,
    created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE webhook_dedup ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON webhook_dedup
    USING (auth.role() = 'service_role');

-- Auto-cleanup: remove entries older than 48 h to keep the table small.
-- Run periodically (e.g. via pg_cron or call manually from /admin/trigger).
-- CREATE EXTENSION IF NOT EXISTS pg_cron;
-- SELECT cron.schedule('dedup-cleanup', '0 3 * * *',
--   $$DELETE FROM webhook_dedup WHERE created_at < now() - interval '48 hours'$$);
