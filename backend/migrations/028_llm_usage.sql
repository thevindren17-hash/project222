-- Tracks token consumption per LLM provider call, so the dashboard can show
-- clinics how many tokens their AI is actually using -- per week, per
-- month, and broken down by what kind of turn it was (booking, reschedule,
-- cancellation, or plain conversation/FAQ). One row per LLM API call, not
-- per WhatsApp message -- a single patient message can trigger 1-4 calls
-- inside the tool-calling loop (check availability, then book, then
-- confirm), each with its own token count.

CREATE TABLE IF NOT EXISTS llm_usage (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    thread_id           UUID REFERENCES whatsapp_threads(id) ON DELETE SET NULL,
    contact_id          UUID REFERENCES contacts(id) ON DELETE SET NULL,
    provider            TEXT NOT NULL,
    model               TEXT NOT NULL,
    prompt_tokens       INTEGER NOT NULL DEFAULT 0,
    completion_tokens   INTEGER NOT NULL DEFAULT 0,
    total_tokens        INTEGER NOT NULL DEFAULT 0,
    -- Which tool(s), if any, this specific LLM call triggered -- e.g.
    -- {book_appointment}, {reschedule_appointment}, or {} for a turn that
    -- was just a chat reply / FAQ answer with no tool call at all. A single
    -- call can contain more than one tool call, hence an array not a
    -- single column.
    tools               TEXT[] NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_tenant_created ON llm_usage(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_thread         ON llm_usage(thread_id);

ALTER TABLE llm_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "llm_usage_select" ON llm_usage
  FOR SELECT TO authenticated
  USING (
    tenant_id IN (SELECT tenants.id FROM tenants WHERE tenants.owner_id = (SELECT auth.uid()))
    OR tenant_id IN (SELECT staff_profiles.tenant_id FROM staff_profiles WHERE staff_profiles.user_id = (SELECT auth.uid()))
  );

-- Written only by the backend (service role) -- never a client-side insert,
-- since this is derived from the provider API response, not user input.
CREATE POLICY "llm_usage_service_role" ON llm_usage
  FOR ALL TO service_role USING (true) WITH CHECK (true);
