-- Part A: lets an inbound reply be recognized as "responding to a specific
-- campaign send" instead of a context-free message -- stores the exact
-- personalized text sent, read back by get_pending_campaign_context()
-- (backend/api/campaigns.py) and injected into the AI's system prompt via
-- _build_date_context(campaign_context=...) (backend/api/whatsapp.py).
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS context JSONB;

-- Part B: extends the self-serve template builder (015/020) to cover
-- reminder and feedback templates, not just marketing/recall. "purpose"
-- distinguishes which fixed variable shape + Meta category applies;
-- "buttons" lets a feedback template carry a real clickable WhatsApp URL
-- button (e.g. "Leave a Review") instead of a plain link pasted into text.
ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'marketing';
ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS buttons JSONB;

-- Reminder/feedback jobs currently resolve which Meta template to use via
-- tenant_settings.reminder_template_name / feedback_template_name -- plain
-- text columns with no dashboard UI anywhere (confirmed: no settings page
-- reads or writes them), so every clinic silently depends on a template
-- name that must already exist and be approved on their own WABA, with zero
-- visibility into whether that's true. These FKs let a clinic pick one of
-- their own *approved* templates instead, same pattern already used for
-- recall_segments.whatsapp_template_id (020). The old text columns are left
-- in place, unused once this ships, rather than dropped.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS reminder_whatsapp_template_id UUID REFERENCES whatsapp_templates(id) ON DELETE SET NULL;
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS feedback_whatsapp_template_id UUID REFERENCES whatsapp_templates(id) ON DELETE SET NULL;
