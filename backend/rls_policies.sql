-- ============================================================================
-- RLS Policies — Row Level Security
-- Run this once in Supabase: Project → SQL Editor → paste → Run
--
-- Strategy:
--   • Each clinic owner can only read/write their own rows.
--   • The backend uses the service-role key, which bypasses RLS entirely —
--     no changes needed there.
--   • Policies are idempotent (DROP IF EXISTS before CREATE).
-- ============================================================================

-- ── Helper: drop all existing policies so this script is safe to re-run ──────

DO $$ DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT policyname, tablename
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'tenants','tenant_settings','contacts','bookings',
        'whatsapp_threads','messages','call_logs','escalations'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.policyname, r.tablename);
  END LOOP;
END $$;

-- ── tenants ────────────────────────────────────────────────────────────────────
-- Each row belongs to the user who created it (owner_id = auth.uid()).

CREATE POLICY "tenants_select"
  ON tenants FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

CREATE POLICY "tenants_insert"
  ON tenants FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "tenants_update"
  ON tenants FOR UPDATE TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "tenants_delete"
  ON tenants FOR DELETE TO authenticated
  USING (owner_id = auth.uid());


-- ── Reusable pattern for all child tables ─────────────────────────────────────
-- Child tables store tenant_id. We join back to tenants to verify ownership.

-- ── tenant_settings ───────────────────────────────────────────────────────────

CREATE POLICY "tenant_settings_select"
  ON tenant_settings FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = tenant_settings.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "tenant_settings_insert"
  ON tenant_settings FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = tenant_settings.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "tenant_settings_update"
  ON tenant_settings FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = tenant_settings.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "tenant_settings_delete"
  ON tenant_settings FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = tenant_settings.tenant_id
      AND tenants.owner_id = auth.uid()
  ));


-- ── contacts ──────────────────────────────────────────────────────────────────

CREATE POLICY "contacts_select"
  ON contacts FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = contacts.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "contacts_insert"
  ON contacts FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = contacts.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "contacts_update"
  ON contacts FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = contacts.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "contacts_delete"
  ON contacts FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = contacts.tenant_id
      AND tenants.owner_id = auth.uid()
  ));


-- ── bookings ──────────────────────────────────────────────────────────────────

CREATE POLICY "bookings_select"
  ON bookings FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = bookings.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "bookings_insert"
  ON bookings FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = bookings.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "bookings_update"
  ON bookings FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = bookings.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "bookings_delete"
  ON bookings FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = bookings.tenant_id
      AND tenants.owner_id = auth.uid()
  ));


-- ── whatsapp_threads ──────────────────────────────────────────────────────────

CREATE POLICY "whatsapp_threads_select"
  ON whatsapp_threads FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = whatsapp_threads.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "whatsapp_threads_insert"
  ON whatsapp_threads FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = whatsapp_threads.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "whatsapp_threads_update"
  ON whatsapp_threads FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = whatsapp_threads.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "whatsapp_threads_delete"
  ON whatsapp_threads FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = whatsapp_threads.tenant_id
      AND tenants.owner_id = auth.uid()
  ));


-- ── messages ──────────────────────────────────────────────────────────────────

CREATE POLICY "messages_select"
  ON messages FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = messages.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "messages_insert"
  ON messages FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = messages.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "messages_update"
  ON messages FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = messages.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "messages_delete"
  ON messages FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = messages.tenant_id
      AND tenants.owner_id = auth.uid()
  ));


-- ── call_logs ─────────────────────────────────────────────────────────────────

CREATE POLICY "call_logs_select"
  ON call_logs FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = call_logs.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "call_logs_insert"
  ON call_logs FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = call_logs.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "call_logs_update"
  ON call_logs FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = call_logs.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "call_logs_delete"
  ON call_logs FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = call_logs.tenant_id
      AND tenants.owner_id = auth.uid()
  ));


-- ── escalations ───────────────────────────────────────────────────────────────

CREATE POLICY "escalations_select"
  ON escalations FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = escalations.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "escalations_insert"
  ON escalations FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = escalations.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "escalations_update"
  ON escalations FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = escalations.tenant_id
      AND tenants.owner_id = auth.uid()
  ));

CREATE POLICY "escalations_delete"
  ON escalations FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM tenants
    WHERE tenants.id = escalations.tenant_id
      AND tenants.owner_id = auth.uid()
  ));
