-- Lets each clinic relabel the 5 fixed base booking fields (name, phone,
-- service, date, time) with their own wording — e.g. a lawyer's office
-- calling service_type "Case Type" instead of "Service" — without changing
-- the underlying contact_name/contact_phone/service_type/date/time argument
-- keys that book_appointment() and the bookings table actually use.
-- Stored as {contact_name?, contact_phone?, service_type?, date?, time?};
-- any key left out falls back to the default English label.
-- Run once in Supabase Dashboard → SQL Editor
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS base_field_labels jsonb NOT NULL DEFAULT '{}'::jsonb;
