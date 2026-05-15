-- ============================================================================
-- AI Receptionist — Supabase Schema
-- Run this in Supabase SQL Editor (Project → SQL Editor → New Query)
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Tenants ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id            UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    agent_name          TEXT NOT NULL DEFAULT 'Maya',
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    sip_number          TEXT UNIQUE,                    -- e.g. +60321234567
    wa_phone_number_id      TEXT UNIQUE,                -- Meta phone_number_id
    wa_business_account_id  TEXT,                       -- Meta WhatsApp Business Account ID
    wa_access_token         TEXT,
    wa_verify_token         TEXT,
    escalation_number   TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Tenant settings (configurable per-clinic) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_settings (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id                UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    system_prompt            TEXT,
    default_language         TEXT NOT NULL DEFAULT 'en',
    stt_config               JSONB NOT NULL DEFAULT '{"en":"deepgram","ms":"openai","zh":"openai"}'::jsonb,
    llm_config               JSONB NOT NULL DEFAULT '{"provider":"openai","model":"gpt-4o"}'::jsonb,
    tts_config               JSONB NOT NULL DEFAULT '{"en":"cartesia","ms":"cartesia","zh":"cartesia"}'::jsonb,
    business_hours           JSONB NOT NULL DEFAULT '{
        "mon":{"open":"09:00","close":"18:00"},
        "tue":{"open":"09:00","close":"18:00"},
        "wed":{"open":"09:00","close":"18:00"},
        "thu":{"open":"09:00","close":"18:00"},
        "fri":{"open":"09:00","close":"18:00"},
        "sat":{"open":"09:00","close":"13:00"},
        "sun":{"closed":true}
    }'::jsonb,
    faq                      JSONB NOT NULL DEFAULT '[]'::jsonb,
    tool_config              JSONB NOT NULL DEFAULT '{
        "book_appointment":true,
        "check_slots":true,
        "cancel_appointment":true,
        "reschedule_appointment":true,
        "get_faq":true,
        "escalate_to_human":true
    }'::jsonb,
    -- Per-tenant provider API keys (set by clinic in dashboard, never exposed to frontend)
    -- Structure: {"openai":{"api_key":"sk-..."},"deepgram":{"api_key":"..."},"cartesia":{"api_key":"...","voice_id":"..."},...}
    provider_credentials     JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Google integrations
    google_calendar_token    TEXT,
    google_calendar_refresh  TEXT,
    google_calendar_id       TEXT,
    google_sheets_token      TEXT,
    google_sheets_refresh    TEXT,
    google_sheets_id         TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id)
);

-- ── Contacts (patients) ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contacts (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    phone               TEXT NOT NULL,
    name                TEXT,
    language_preference TEXT DEFAULT 'en',
    last_contact_at     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, phone)
);

-- ── Bookings ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookings (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    contact_id          UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    scheduled_at        TIMESTAMPTZ NOT NULL,
    service_type        TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','confirmed','cancelled','completed')),
    source              TEXT NOT NULL DEFAULT 'voice'
                            CHECK (source IN ('voice','whatsapp','manual')),
    details             JSONB DEFAULT '{}'::jsonb,
    notes               TEXT,
    calendar_event_id   TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── WhatsApp threads ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_threads (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    contact_id          UUID REFERENCES contacts(id) ON DELETE SET NULL,
    contact_number      TEXT NOT NULL,
    contact_name        TEXT,
    language            TEXT DEFAULT 'en',
    status              TEXT NOT NULL DEFAULT 'ai'
                            CHECK (status IN ('ai','human_takeover','resolved')),
    last_message_at     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, contact_number)
);

-- ── Messages (WhatsApp) ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    thread_id           UUID NOT NULL REFERENCES whatsapp_threads(id) ON DELETE CASCADE,
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    contact_id          UUID REFERENCES contacts(id) ON DELETE SET NULL,
    wa_message_id       TEXT,
    role                TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
    body                TEXT NOT NULL,
    language            TEXT DEFAULT 'en',
    handled_by          TEXT DEFAULT 'ai' CHECK (handled_by IN ('ai','human')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Call logs ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS call_logs (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    contact_id          UUID REFERENCES contacts(id) ON DELETE SET NULL,
    caller_number       TEXT,
    duration_seconds    INTEGER DEFAULT 0,
    language_detected   TEXT DEFAULT 'en',
    transcript          TEXT,
    summary             TEXT,
    outcome             TEXT DEFAULT 'unknown'
                            CHECK (outcome IN ('booked','cancelled','rescheduled','faq','escalated','unknown')),
    turn_count          INTEGER DEFAULT 0,
    quality_flags       TEXT[] DEFAULT '{}',
    stt_provider        TEXT,
    llm_provider        TEXT,
    tts_provider        TEXT,
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Escalations ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS escalations (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    reason              TEXT NOT NULL,
    context             TEXT,
    source              TEXT NOT NULL DEFAULT 'voice'
                            CHECK (source IN ('voice','whatsapp')),
    resolved            BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- Indexes for common query patterns
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_contacts_tenant_phone     ON contacts(tenant_id, phone);
CREATE INDEX IF NOT EXISTS idx_bookings_tenant_status    ON bookings(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_scheduled_at     ON bookings(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_bookings_contact          ON bookings(contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_thread           ON messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wa_threads_tenant_number  ON whatsapp_threads(tenant_id, contact_number);
CREATE INDEX IF NOT EXISTS idx_call_logs_tenant          ON call_logs(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_escalations_tenant        ON escalations(tenant_id, created_at);

-- ============================================================================
-- Row Level Security (RLS) — tenants can only see their own data
-- ============================================================================

ALTER TABLE tenants          ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages         ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalations      ENABLE ROW LEVEL SECURITY;

-- Service-role bypasses RLS (backend uses service role key — no restrictions needed).
-- Dashboard uses authenticated role — policies below enforce per-clinic isolation.

-- ── tenants ────────────────────────────────────────────────────────────────────
CREATE POLICY "tenants_select" ON tenants FOR SELECT TO authenticated USING (owner_id = auth.uid());
CREATE POLICY "tenants_insert" ON tenants FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY "tenants_update" ON tenants FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
CREATE POLICY "tenants_delete" ON tenants FOR DELETE TO authenticated USING (owner_id = auth.uid());

-- ── tenant_settings ────────────────────────────────────────────────────────────
CREATE POLICY "tenant_settings_select" ON tenant_settings FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = tenant_settings.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "tenant_settings_insert" ON tenant_settings FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = tenant_settings.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "tenant_settings_update" ON tenant_settings FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = tenant_settings.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "tenant_settings_delete" ON tenant_settings FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = tenant_settings.tenant_id AND tenants.owner_id = auth.uid()));

-- ── contacts ───────────────────────────────────────────────────────────────────
CREATE POLICY "contacts_select" ON contacts FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = contacts.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "contacts_insert" ON contacts FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = contacts.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "contacts_update" ON contacts FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = contacts.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "contacts_delete" ON contacts FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = contacts.tenant_id AND tenants.owner_id = auth.uid()));

-- ── bookings ───────────────────────────────────────────────────────────────────
CREATE POLICY "bookings_select" ON bookings FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = bookings.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "bookings_insert" ON bookings FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = bookings.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "bookings_update" ON bookings FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = bookings.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "bookings_delete" ON bookings FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = bookings.tenant_id AND tenants.owner_id = auth.uid()));

-- ── whatsapp_threads ───────────────────────────────────────────────────────────
CREATE POLICY "whatsapp_threads_select" ON whatsapp_threads FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = whatsapp_threads.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "whatsapp_threads_insert" ON whatsapp_threads FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = whatsapp_threads.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "whatsapp_threads_update" ON whatsapp_threads FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = whatsapp_threads.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "whatsapp_threads_delete" ON whatsapp_threads FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = whatsapp_threads.tenant_id AND tenants.owner_id = auth.uid()));

-- ── messages ───────────────────────────────────────────────────────────────────
CREATE POLICY "messages_select" ON messages FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = messages.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "messages_insert" ON messages FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = messages.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "messages_update" ON messages FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = messages.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "messages_delete" ON messages FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = messages.tenant_id AND tenants.owner_id = auth.uid()));

-- ── call_logs ──────────────────────────────────────────────────────────────────
CREATE POLICY "call_logs_select" ON call_logs FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = call_logs.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "call_logs_insert" ON call_logs FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = call_logs.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "call_logs_update" ON call_logs FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = call_logs.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "call_logs_delete" ON call_logs FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = call_logs.tenant_id AND tenants.owner_id = auth.uid()));

-- ── escalations ────────────────────────────────────────────────────────────────
CREATE POLICY "escalations_select" ON escalations FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = escalations.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "escalations_insert" ON escalations FOR INSERT TO authenticated WITH CHECK (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = escalations.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "escalations_update" ON escalations FOR UPDATE TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = escalations.tenant_id AND tenants.owner_id = auth.uid()));
CREATE POLICY "escalations_delete" ON escalations FOR DELETE TO authenticated USING (EXISTS (SELECT 1 FROM tenants WHERE tenants.id = escalations.tenant_id AND tenants.owner_id = auth.uid()));

-- ============================================================================
-- Demo seed data (optional — remove before production)
-- ============================================================================

-- INSERT INTO tenants (name, agent_name, sip_number, wa_phone_number_id, wa_verify_token)
-- VALUES ('Bright Smile Dental', 'Maya', '+60321234567', '123456789', 'my_verify_token_123');

-- INSERT INTO tenant_settings (tenant_id)
-- SELECT id FROM tenants WHERE name = 'Bright Smile Dental';
