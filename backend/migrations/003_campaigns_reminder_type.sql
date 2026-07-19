-- Widen campaigns.type to also accept 'reminder'
-- Run once in Supabase Dashboard → SQL Editor
-- Needed for the new CSV bulk-send on the Appointment Reminder System page —
-- campaigns.type previously only ever received 'feedback' or 'recall'.
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_type_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_type_check CHECK (type IN ('feedback','recall','reminder'));
