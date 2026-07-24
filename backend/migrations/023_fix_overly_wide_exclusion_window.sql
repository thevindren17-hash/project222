-- migration 019 widened the race-condition safety-net exclusion window
-- (migration 009) from 45 minutes to a fixed 3 HOURS after each booking,
-- reasoning that being wider could only be "more protective, never less."
-- That reasoning missed a real consequence: the DB-level constraint is
-- IMMUTABLE and can't read a tenant's actual configured
-- appointment_duration_minutes/booking_buffer_minutes (that's a real
-- Postgres/GiST limitation, not an oversight -- an index expression has
-- to stay valid even if tenant_settings changes later). For a typical
-- clinic running 30-minute slots, this made the DB reject brand new
-- bookings up to 3 hours away from ANY existing one on the same day, even
-- though the app's own pre-flight check (book_appointment) and
-- check_slots both correctly computed that exact time as free using the
-- tenant's real duration/buffer -- reproduced live: check_slots and the
-- app-level pre-check agree a time is open, the clinic confirms it, and
-- the INSERT itself still fails with "that time slot was just taken,"
-- because this constraint's 3-hour blast radius caught a same-tenant
-- booking hours away that was never actually a real conflict.
--
-- 15 minutes before / 90 minutes after comfortably covers realistic
-- clinic use (e.g. a 60-minute appointment plus a 30-minute buffer) as a
-- genuine safety margin for the rare simultaneous-booking race this
-- constraint exists to catch, without being so wide it rejects legitimate,
-- actually-available bookings elsewhere in the same day. There is no
-- enforced maximum on appointment_duration_minutes/booking_buffer_minutes
-- in the dashboard today (confirmed), so this is a considered ceiling
-- for realistic use, not a value derived from a hard app-level limit --
-- a clinic configuring something unusually long (well beyond typical
-- appointment lengths) should keep that in mind.
CREATE OR REPLACE FUNCTION public.booking_exclusion_range(ts timestamptz)
RETURNS tstzrange
LANGUAGE sql
IMMUTABLE
SET search_path = 'public'
AS $$
  SELECT tstzrange(ts - interval '15 minutes', ts + interval '90 minutes')
$$;

-- CREATE OR REPLACE FUNCTION does not retroactively recompute GIST index
-- entries for rows inserted under the old (wider) function body -- run
-- REINDEX if you want the narrower window enforced against pre-existing
-- rows too. Not required for this fix: narrowing the window can only
-- reduce false conflicts, never introduce a real double-booking risk that
-- wasn't already possible before migration 009 existed.
