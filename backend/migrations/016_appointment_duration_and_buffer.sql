-- Per-clinic control over appointment length and the gap required between
-- back-to-back bookings. Both previously hardcoded to 30 minutes / no gap
-- throughout check_slots and book_appointment.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS appointment_duration_minutes INT NOT NULL DEFAULT 30;
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS booking_buffer_minutes INT NOT NULL DEFAULT 0;

-- The race-condition safety net (migration 009) used a fixed 15-min-before/
-- 45-min-after window sized only for the old hardcoded 30-minute
-- appointment. Widen it to a generous fixed ceiling that comfortably covers
-- any reasonable per-tenant duration+buffer combination -- this is a strict
-- superset of the old window, so it can only become MORE protective, never
-- less; no new double-booking risk is introduced. The application-level
-- pre-check in book_appointment (and check_slots' slot spacing) is what
-- actually enforces the tenant's own configured duration/buffer precisely;
-- this function only needs to be at least as wide as that, so it isn't
-- read dynamically from tenant_settings inside the IMMUTABLE function.
--
-- Note: CREATE OR REPLACE FUNCTION does not retroactively recompute the
-- GIST index entries for rows inserted under the old function body. This
-- is safe here since the new window is strictly wider (old exclusions
-- remain valid, some additional overlaps become newly excluded going
-- forward) -- but if you want the widened window enforced retroactively
-- against pre-existing rows too, run REINDEX on bookings_no_overlap after
-- applying this migration.
CREATE OR REPLACE FUNCTION public.booking_exclusion_range(ts timestamptz)
RETURNS tstzrange
LANGUAGE sql
IMMUTABLE
SET search_path = 'public'
AS $$
  SELECT tstzrange(ts - interval '15 minutes', ts + interval '3 hours')
$$;
