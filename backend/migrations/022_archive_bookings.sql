-- Lets a clinic clear old appointments out of the Appointments dashboard
-- view without deleting the underlying data (still needed for their own
-- CRM/Excel export later). NULL = active/visible, a timestamp = archived
-- (and when). The partial index keeps the default "active only" view cheap
-- regardless of how many archived rows accumulate over time.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_bookings_active ON bookings(tenant_id, scheduled_at DESC) WHERE archived_at IS NULL;
