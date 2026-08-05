-- Two RLS gaps found by a live-policy audit (pg_policies), not visible from
-- the tracked schema files alone since these tables' policies had drifted
-- from what's committed:
--
-- 1. escalations had a SELECT policy (owner-or-staff) but no UPDATE policy.
--    The dashboard's "Resolve" button does
--    supabase.from('escalations').update({resolved:true}) directly from the
--    browser (authenticated role) -- with RLS on and no UPDATE policy, that
--    silently matches zero rows. Not a data leak, but the Resolve button
--    has never actually worked in production.
--
-- 2. campaigns' SELECT policy only checked tenant owner_id, not
--    staff_profiles -- unlike every other shared table (bookings, contacts,
--    whatsapp_threads, etc). A staff (non-owner) login sees the dashboard
--    Overview page's rating/recall stats as always zero, since the
--    campaigns read is silently filtered to nothing for them.

CREATE POLICY "escalations_update"
  ON escalations FOR UPDATE TO authenticated
  USING (
    tenant_id IN (SELECT tenants.id FROM tenants WHERE tenants.owner_id = (SELECT auth.uid()))
    OR tenant_id IN (SELECT staff_profiles.tenant_id FROM staff_profiles WHERE staff_profiles.user_id = (SELECT auth.uid()))
  )
  WITH CHECK (
    tenant_id IN (SELECT tenants.id FROM tenants WHERE tenants.owner_id = (SELECT auth.uid()))
    OR tenant_id IN (SELECT staff_profiles.tenant_id FROM staff_profiles WHERE staff_profiles.user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "tenant_campaigns_select" ON campaigns;

CREATE POLICY "tenant_campaigns_select"
  ON campaigns FOR SELECT TO authenticated
  USING (
    tenant_id IN (SELECT tenants.id FROM tenants WHERE tenants.owner_id = (SELECT auth.uid()))
    OR tenant_id IN (SELECT staff_profiles.tenant_id FROM staff_profiles WHERE staff_profiles.user_id = (SELECT auth.uid()))
  );
