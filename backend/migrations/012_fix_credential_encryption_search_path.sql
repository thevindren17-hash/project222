-- Applied directly to the live project via Supabase MCP.
--
-- Regression from migration 008: pinning encrypt_credential/decrypt_credential
-- to search_path='public' broke them, since pgcrypto (pgp_sym_encrypt/decrypt)
-- is installed in the `extensions` schema on this project, not `public`.
-- Every credential save (LLM keys, the new Google OAuth client_id/secret)
-- started failing with "Failed to encrypt ..." as soon as 008 was applied.
--
-- Fix: search_path needs both schemas. Corrected in 008's own file too so a
-- fresh run doesn't reintroduce this.
ALTER FUNCTION public.encrypt_credential(text, text) SET search_path TO public, extensions;
ALTER FUNCTION public.decrypt_credential(text, text) SET search_path TO public, extensions;
