-- Applied directly to the live project via Supabase MCP.
--
-- Lets a clinic point the patient-mirror at a SPECIFIC tab within a
-- spreadsheet (not just the spreadsheet itself) — needed since a clinic
-- using their own existing file may have multiple tabs (inventory, etc.)
-- and the row data now maps to whatever column headers already exist in
-- that tab by name, rather than a fixed layout we impose.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS google_sheets_tab text;
