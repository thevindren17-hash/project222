-- Distributed scheduler lock table
-- Run once in Supabase Dashboard → SQL Editor
-- Prevents duplicate job execution when Railway scales to multiple instances

CREATE TABLE IF NOT EXISTS scheduler_locks (
    job_name     text        PRIMARY KEY,
    locked_at    timestamptz NOT NULL DEFAULT now(),
    locked_until timestamptz NOT NULL DEFAULT now()
);

-- Only the backend service role needs access
ALTER TABLE scheduler_locks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role only" ON scheduler_locks
    USING (auth.role() = 'service_role');
