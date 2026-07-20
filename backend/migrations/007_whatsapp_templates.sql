-- Config for sending real Meta-approved WhatsApp message templates instead
-- of plain text for reminder/feedback/recall campaigns (required outside
-- the 24-hour customer service window, which is effectively always for
-- these three proactive campaign types).
-- Run once in Supabase Dashboard → SQL Editor
--
-- recall_template_name is intentionally nullable with no default — the
-- recall template isn't approved yet, so recall keeps sending plain text
-- (still works within 24h, silently fails outside it) until this is set.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS whatsapp_template_language text NOT NULL DEFAULT 'en_US';
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS reminder_template_name text NOT NULL DEFAULT 'appointment_reminder';
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS feedback_template_name text NOT NULL DEFAULT 'feedback_request';
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS recall_template_name text;
