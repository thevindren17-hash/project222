-- Structured registry for clinic-authored WhatsApp marketing templates.
-- Distinct from 007_whatsapp_templates.sql, which only added plain-text
-- "which already-approved Meta template name to use" pointer columns on
-- tenant_settings for the reminder/feedback/recall jobs. This table is the
-- actual template content + Meta submission/approval lifecycle, self-served
-- per-clinic through the dashboard instead of manual founder setup.

CREATE TABLE IF NOT EXISTS whatsapp_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,                     -- Meta-safe slug, e.g. endofmonth_scaling_promo
    language TEXT NOT NULL DEFAULT 'en',
    category TEXT NOT NULL DEFAULT 'MARKETING',
    header_type TEXT,                       -- NULL | 'IMAGE'
    header_handle TEXT,                     -- Meta resumable-upload handle used at submission time (template creation only)
    header_media_id TEXT,                   -- Meta /{phone_number_id}/media id, used every actual campaign send
    body_text TEXT NOT NULL,                -- clinic-authored, with {{1}} {{2}}... placeholders
    variables TEXT[] NOT NULL DEFAULT '{}', -- friendly names in order, e.g. ['name','offer'] -- maps CSV columns to {{n}}
    example_values TEXT[] NOT NULL DEFAULT '{}',
    footer_text TEXT,
    meta_template_id TEXT,                  -- Meta's own template id, once submitted
    status TEXT NOT NULL DEFAULT 'draft',   -- draft | pending | approved | rejected | paused | disabled
    rejected_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_tenant ON whatsapp_templates(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_templates_status ON whatsapp_templates(status) WHERE status = 'pending';

ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "whatsapp_templates_select" ON whatsapp_templates FOR SELECT TO authenticated
        USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = whatsapp_templates.tenant_id AND tenants.owner_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "whatsapp_templates_insert" ON whatsapp_templates FOR INSERT TO authenticated
        WITH CHECK (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = whatsapp_templates.tenant_id AND tenants.owner_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "whatsapp_templates_update" ON whatsapp_templates FOR UPDATE TO authenticated
        USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = whatsapp_templates.tenant_id AND tenants.owner_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "whatsapp_templates_delete" ON whatsapp_templates FOR DELETE TO authenticated
        USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = whatsapp_templates.tenant_id AND tenants.owner_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Let a recall segment point at a real, approved marketing template instead
-- of only the free-text message_template column (which stays as-is, used
-- purely for the readable thread-history log same as before).
ALTER TABLE recall_segments ADD COLUMN IF NOT EXISTS whatsapp_template_id UUID REFERENCES whatsapp_templates(id) ON DELETE SET NULL;

-- campaigns.type previously only accepted feedback/recall/reminder (migration
-- 003) -- CSV bulk-sends using a self-serve marketing template need a new value.
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_type_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_type_check CHECK (type IN ('feedback','recall','reminder','marketing'));
