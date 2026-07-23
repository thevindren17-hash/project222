-- Multi-segment recall: replaces the single tenant_settings.recall_* fields
-- with per-service-type rows, so a clinic can send "whitening" patients a
-- different recall offer/interval than "general checkup" patients.
--
-- The old tenant_settings.recall_* columns are kept (not dropped) for
-- rollback safety — send_recall_messages() (backend/api/campaigns.py) stops
-- reading them and reads recall_segments instead.
CREATE TABLE IF NOT EXISTS recall_segments (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    service_type     text,              -- NULL = catch-all default segment
    is_default       boolean NOT NULL DEFAULT false,
    interval_months  int NOT NULL DEFAULT 6,
    message_template text,
    enabled          boolean NOT NULL DEFAULT true,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recall_segments_tenant ON recall_segments (tenant_id, enabled);

ALTER TABLE recall_segments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "recall_segments_select" ON recall_segments;
CREATE POLICY "recall_segments_select" ON recall_segments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = recall_segments.tenant_id AND tenants.owner_id = auth.uid()));

DROP POLICY IF EXISTS "recall_segments_insert" ON recall_segments;
CREATE POLICY "recall_segments_insert" ON recall_segments FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = recall_segments.tenant_id AND tenants.owner_id = auth.uid()));

DROP POLICY IF EXISTS "recall_segments_update" ON recall_segments;
CREATE POLICY "recall_segments_update" ON recall_segments FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = recall_segments.tenant_id AND tenants.owner_id = auth.uid()));

DROP POLICY IF EXISTS "recall_segments_delete" ON recall_segments;
CREATE POLICY "recall_segments_delete" ON recall_segments FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = recall_segments.tenant_id AND tenants.owner_id = auth.uid()));

-- Backfill: one 'default' segment per tenant currently using the old
-- single-config fields, carrying over their existing values.
INSERT INTO recall_segments (tenant_id, service_type, is_default, interval_months, message_template, enabled)
SELECT tenant_id, NULL, true,
       COALESCE(recall_interval_months, 6),
       recall_message_template,
       COALESCE(recall_enabled, false)
FROM tenant_settings
WHERE recall_enabled = true
  AND NOT EXISTS (
    SELECT 1 FROM recall_segments rs WHERE rs.tenant_id = tenant_settings.tenant_id AND rs.is_default = true
  );
