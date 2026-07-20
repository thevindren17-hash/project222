-- BYOK provider API keys (LLM/STT/TTS) were stored in plaintext in
-- tenant_settings.provider_credentials / voice_provider_credentials.
-- Run once in Supabase Dashboard → SQL Editor
--
-- Adds app-callable symmetric encrypt/decrypt functions (pgcrypto). The
-- encryption key itself is supplied by the application at call time
-- (CREDENTIAL_ENCRYPTION_KEY env var, set in both Vercel and Railway) and is
-- never stored in the database.
--
-- Backward compatible: already-saved keys stay stored as plaintext and keep
-- working (backend/shared/tenant_config.py only decrypts values prefixed
-- "enc:v1:"). Each key gets upgraded to encrypted automatically the next
-- time it's re-saved from the dashboard.

create extension if not exists pgcrypto;

create or replace function encrypt_credential(plaintext text, key text)
returns text
language sql
as $$
  select encode(pgp_sym_encrypt(plaintext, key), 'base64');
$$;

create or replace function decrypt_credential(ciphertext text, key text)
returns text
language sql
as $$
  select pgp_sym_decrypt(decode(ciphertext, 'base64'), key);
$$;

-- Only our own authenticated app code (or the backend's service role) may
-- call these — not anonymous/public callers.
revoke execute on function encrypt_credential(text, text) from public, anon;
revoke execute on function decrypt_credential(text, text) from public, anon;
grant execute on function encrypt_credential(text, text) to authenticated, service_role;
grant execute on function decrypt_credential(text, text) to authenticated, service_role;
