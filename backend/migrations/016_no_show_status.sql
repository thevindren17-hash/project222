-- Widen bookings.status to add 'no_show'. Migration 009's exclusion
-- constraint already special-cases 'no_show' in its WHERE clause, but the
-- CHECK constraint on bookings.status was never updated, so writing
-- status='no_show' has always failed with a check-violation until now.
--
-- NOTE: verify the live constraint name before running — Postgres
-- auto-names an inline CHECK "<table>_<column>_check" only when the table
-- was created without an explicit constraint name, which matches how
-- bookings.status was defined in supabase_schema.sql. If the live name
-- differs, this DROP is a no-op (IF EXISTS) and the old constraint will
-- keep blocking 'no_show' until reconciled.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('pending','confirmed','cancelled','completed','no_show'));

-- Claim flag for the hourly auto-complete job (backend/api/no_show.py),
-- same atomic-claim pattern as reminder_1d_sent/reminder_3h_sent.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS auto_completed boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_bookings_tenant_status_scheduled
  ON bookings (tenant_id, status, scheduled_at);
