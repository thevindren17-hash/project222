-- Lets each clinic define their own extra data fields for the AI to collect
-- during booking (e.g. insurance provider, referral source, preferred doctor)
-- on top of the fixed baseline (name, phone, service, date, time, notes).
-- Stored as a JSON array of {key, label, instruction}. Values captured land
-- in bookings.details (already a flexible JSONB column) alongside notes.
-- Run once in Supabase Dashboard → SQL Editor
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS custom_booking_fields jsonb NOT NULL DEFAULT '[]'::jsonb;
