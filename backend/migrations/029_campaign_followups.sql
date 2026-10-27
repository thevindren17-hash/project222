-- Patient Record Campaign follow-ups: lets a clinic send an initial bulk
-- WhatsApp blast (CsvCampaignUploader, type='marketing') to up to
-- MAX_CONTACTS_PER_UPLOAD contacts, then have the AI automatically re-send
-- a follow-up to whoever hasn't replied, N times, every X days -- both N
-- and X chosen per-batch by the clinic, instead of them having to
-- re-upload the same spreadsheet by hand on a timer.
--
-- One row per *upload* (not per contact) holding the follow-up schedule;
-- campaigns rows (one per contact per send) point back at it via batch_id.
CREATE TABLE IF NOT EXISTS campaign_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT,
    template_id UUID REFERENCES whatsapp_templates(id) ON DELETE SET NULL,
    -- Follow-up re-send reuses the initial template when left NULL --
    -- clinics shouldn't be forced to author a second template just to
    -- nudge non-responders with the exact same offer.
    followup_template_id UUID REFERENCES whatsapp_templates(id) ON DELETE SET NULL,
    followup_interval_days INT NOT NULL DEFAULT 3 CHECK (followup_interval_days BETWEEN 1 AND 90),
    -- 0 = one-off send, no follow-ups.
    max_followups INT NOT NULL DEFAULT 0 CHECK (max_followups BETWEEN 0 AND 10),
    contact_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaign_batches_tenant ON campaign_batches(tenant_id, created_at DESC);

ALTER TABLE campaign_batches ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    CREATE POLICY "campaign_batches_select" ON campaign_batches FOR SELECT TO authenticated
        USING (
            tenant_id IN (SELECT tenants.id FROM tenants WHERE tenants.owner_id = (SELECT auth.uid()))
            OR tenant_id IN (SELECT staff_profiles.tenant_id FROM staff_profiles WHERE staff_profiles.user_id = (SELECT auth.uid()))
        );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE POLICY "campaign_batches_update" ON campaign_batches FOR UPDATE TO authenticated
        USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = campaign_batches.tenant_id AND tenants.owner_id = auth.uid()))
        WITH CHECK (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = campaign_batches.tenant_id AND tenants.owner_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Inserts/sends always go through the backend service role (send-csv route,
-- scheduler job) -- no authenticated INSERT policy needed, same as campaigns.

-- Each campaigns row is one actual send (initial or one follow-up step).
-- followup_sequence=0 is always the initial send; 1..max_followups are the
-- automatic re-sends. next_followup_at is when THIS row's follow-up is due
-- -- the scheduler nulls it out once sent, replied to, booked, or
-- exhausted, so a row is only ever "due" once. A transient problem (e.g. a
-- newer follow-up template still pending Meta review, or WhatsApp
-- temporarily disconnected) instead pushes next_followup_at forward to
-- retry later, rather than nulling it -- see send_campaign_followups().
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES campaign_batches(id) ON DELETE SET NULL;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS followup_sequence INT NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS next_followup_at TIMESTAMPTZ;

-- Why a follow-up row stopped (or finished) -- without this, a sequence
-- that silently dies because its template got deleted, or because the
-- contact booked through voice (no WhatsApp reply to detect), is
-- indistinguishable from one still quietly running. NULL while still
-- in-flight. One of: replied | booked | opted_out | completed | superseded
-- (this row sent its message; a newer row now owns what's next) |
-- manually_stopped (clinic clicked "Stop Follow-Ups") | template_deleted |
-- contact_invalid | tenant_unavailable | batch_deleted.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS stopped_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_campaigns_next_followup ON campaigns(next_followup_at) WHERE next_followup_at IS NOT NULL;
