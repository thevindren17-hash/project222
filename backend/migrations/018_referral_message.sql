-- Referral generation: a second WhatsApp message sent right after the
-- Google review invite, only to patients who rated 4-5 stars. No
-- attribution/tracking — just a configurable incentive message.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS referral_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS referral_message_template text;
