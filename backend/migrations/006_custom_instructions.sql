-- Split the agent's system prompt into a mandatory core (booking flow,
-- escalation, safety rules — always sent, not clinic-editable) and an
-- optional per-clinic customization layer.
-- Run once in Supabase Dashboard → SQL Editor
--
-- NULL (not set) is meaningfully different from '' (explicitly cleared) here:
-- backend/shared/tenant_config.py treats NULL as "check the old system_prompt
-- column for a pre-migration custom prompt to fold in once", so existing
-- clinics don't lose anything they already wrote.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS custom_instructions text;
