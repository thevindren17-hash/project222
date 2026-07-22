-- Applied directly to the live project via Supabase MCP.
--
-- Previously Calendar and Sheets were two separate OAuth connections, each
-- with their own token pair (google_calendar_token/refresh,
-- google_sheets_token/refresh) and their own "Connect" button — even though
-- both go through the same Google account and can share one OAuth grant.
-- Consolidated to a single connection: one Google OAuth client (now
-- tenant-owned BYOK, see provider_credentials.google in tenant_settings),
-- one "Connect Google" action requesting Calendar + Sheets + Drive scopes
-- together, one token pair. google_calendar_id/google_sheets_id remain
-- separate since those identify specific resources, not authorization.
--
-- The old google_calendar_token/refresh and google_sheets_token/refresh
-- columns are left in place (harmless, unused) rather than dropped — no
-- real clinic had connected yet, so there's no data to migrate.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS google_access_token text;
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS google_refresh_token text;
