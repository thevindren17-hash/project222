-- Config for sending real Meta-approved WhatsApp message templates instead
-- of plain text for reminder/feedback/recall campaigns (required outside
-- the 24-hour customer service window, which is effectively always for
-- these three proactive campaign types).
-- Run once in Supabase Dashboard → SQL Editor
--
-- recall_template_name is intentionally nullable with no default — the
-- recall template isn't approved yet, so recall keeps sending plain text
-- (still works within 24h, silently fails outside it) until this is set.
-- Meta's WhatsApp Manager shows the approved templates' language as plain
-- "English" (not "English (US)"), which maps to language code 'en', not
-- 'en_US' — confirmed from the approved templates list. Using the wrong
-- code makes every send fail with a "template not found" error.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS whatsapp_template_language text NOT NULL DEFAULT 'en';
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS reminder_template_name text NOT NULL DEFAULT 'appointment_reminder';
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS feedback_template_name text NOT NULL DEFAULT 'feedback_request';
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS recall_template_name text;

-- Safe to run even if this migration was already applied with the old
-- 'en_US' default — normalizes any existing rows to the correct code.
UPDATE tenant_settings SET whatsapp_template_language = 'en' WHERE whatsapp_template_language = 'en_US';
