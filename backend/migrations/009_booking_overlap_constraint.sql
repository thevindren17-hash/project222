-- Applied directly to the live project via Supabase MCP during an adversarial
-- security pass — recorded here for history/disaster-recovery.
--
-- book_appointment() (backend/shared/tools.py) checked for a conflicting slot
-- with a SELECT, then did a separate INSERT — a classic check-then-insert
-- race: two near-simultaneous WhatsApp messages booking the same slot could
-- both pass the SELECT before either INSERT landed, producing two confirmed
-- bookings for one slot. This constraint makes Postgres itself atomically
-- reject any insert/update that would create two overlapping (non-cancelled,
-- non-no_show) bookings for the same tenant, no matter how close the race.
--
-- The 15-min-before/45-min-after window matches the existing application
-- pre-check's buffer exactly (kept as a fast, friendly early-error path in
-- app code; this constraint is the actual atomic guarantee).
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE OR REPLACE FUNCTION public.booking_exclusion_range(ts timestamptz)
RETURNS tstzrange
LANGUAGE sql
IMMUTABLE
SET search_path = 'public'
AS $$
  SELECT tstzrange(ts - interval '15 minutes', ts + interval '45 minutes')
$$;

-- Safe to re-run: verified no existing overlapping bookings before adding.
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    booking_exclusion_range(scheduled_at) WITH &&
  )
  WHERE (status NOT IN ('cancelled', 'no_show'));
