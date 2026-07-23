-- Clinic-defined custom tool functions, fully separate from the fixed
-- book_appointment/cancel_appointment/reschedule_appointment flows. Each
-- entry is a generic "collect these fields, then log them" tool the AI can
-- call by its own clinic-chosen name.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS custom_tools jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Durable record of every custom-tool call, independent of whether Google
-- Sheets is connected — mirrors how `bookings` is the real record and
-- Sheets is just a one-way convenience copy on top of it.
CREATE TABLE IF NOT EXISTS custom_tool_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
    tool_key TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_custom_tool_submissions_tenant ON custom_tool_submissions(tenant_id, created_at DESC);

ALTER TABLE custom_tool_submissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "custom_tool_submissions_select" ON custom_tool_submissions FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = custom_tool_submissions.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "custom_tool_submissions_insert" ON custom_tool_submissions FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = custom_tool_submissions.tenant_id AND tenants.owner_id = auth.uid()));
