-- Applied directly to the live project via Supabase MCP during a security
-- premortem — recorded here for history/disaster-recovery, not something
-- that still needs to be run.
--
-- 1. voice_sessions had an "anon read: true" SELECT policy left over from
--    earlier LiveKit voice work — any unauthenticated request with the
--    public anon key could read every tenant's call-session rows
--    (tenant_id, contact_id, livekit_room_id). Replaced with the same
--    owner/staff tenant-scoping used on every other table.
DROP POLICY IF EXISTS "anon read" ON voice_sessions;

CREATE POLICY "Owner can view voice sessions" ON voice_sessions
  FOR SELECT
  USING (tenant_id IN (SELECT tenants.id FROM tenants WHERE tenants.owner_id = auth.uid()));

CREATE POLICY "Staff can view own voice sessions" ON voice_sessions
  FOR SELECT
  USING (tenant_id IN (SELECT staff_profiles.tenant_id FROM staff_profiles WHERE staff_profiles.user_id = auth.uid()));

-- 2. Pin search_path on functions the Supabase security advisor flagged as
--    mutable-search-path (schema-hijacking hardening) — includes the two
--    functions that encrypt/decrypt BYOK provider credentials at rest.
ALTER FUNCTION public.update_updated_at_column() SET search_path = 'public';
ALTER FUNCTION public.check_booking_slot_available(uuid, timestamptz, uuid) SET search_path = 'public';
ALTER FUNCTION public.reset_daily_booking_count() SET search_path = 'public';
ALTER FUNCTION public.purge_old_rate_limit_entries() SET search_path = 'public';
ALTER FUNCTION public.encrypt_credential(text, text) SET search_path = 'public';
ALTER FUNCTION public.decrypt_credential(text, text) SET search_path = 'public';

-- NOT done here (needs the Supabase Dashboard, not SQL):
-- Authentication -> Policies -> enable "Leaked password protection"
-- (checks new passwords against HaveIBeenPwned at signup/change time).
