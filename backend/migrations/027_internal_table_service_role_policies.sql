-- availability_slots, conversation_states, livekit_events had RLS enabled
-- with zero policies (fail-closed: already denied all anon/authenticated
-- access; confirmed no frontend code queries them directly). This just adds
-- an explicit service_role policy to document that intent and silence the
-- Supabase linter's rls_enabled_no_policy warning -- no actual access change.

CREATE POLICY "service_role_only" ON availability_slots
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_only" ON conversation_states
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_only" ON livekit_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
