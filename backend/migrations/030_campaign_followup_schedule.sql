-- Lets a clinic set a DIFFERENT gap per follow-up step (e.g. follow-up #1
-- one day after the initial send, follow-up #2 four days after THAT, ...)
-- instead of one fixed interval repeated for every step. Replaces
-- max_followups + followup_interval_days with a single ordered array:
-- followup_schedule_days[i] = days to wait after message i before sending
-- message i+1 (index 0 = gap between the initial send and follow-up #1).
-- The array's length IS the number of follow-ups -- no separate count to
-- keep in sync with it.
ALTER TABLE campaign_batches ADD COLUMN IF NOT EXISTS followup_schedule_days INT[] NOT NULL DEFAULT '{}';

-- Carry over any batches created before this migration (one fixed interval,
-- repeated max_followups times).
UPDATE campaign_batches
SET followup_schedule_days = (
    SELECT array_agg(followup_interval_days ORDER BY n)
    FROM generate_series(1, max_followups) AS n
)
WHERE max_followups > 0 AND followup_schedule_days = '{}';

ALTER TABLE campaign_batches ADD CONSTRAINT campaign_batches_schedule_length_check
    CHECK (array_length(followup_schedule_days, 1) IS NULL OR array_length(followup_schedule_days, 1) BETWEEN 1 AND 10);

ALTER TABLE campaign_batches DROP COLUMN IF EXISTS max_followups;
ALTER TABLE campaign_batches DROP COLUMN IF EXISTS followup_interval_days;
