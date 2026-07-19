-- WhatsApp voice-note TTS: provider choice + per-language voice map
-- Run once in Supabase Dashboard → SQL Editor
-- Lets a clinic pick ElevenLabs (or OpenAI) for voice-note replies, with a
-- separate voice per language, instead of one OpenAI voice for everyone.
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS voice_tts_provider text NOT NULL DEFAULT 'openai';
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS voice_tts_voice_map jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Defensive: widen these in case a CHECK constraint from an earlier setup
-- limits voice_stt_provider/voice_tts_provider to a fixed old list.
ALTER TABLE tenant_settings DROP CONSTRAINT IF EXISTS tenant_settings_voice_stt_provider_check;
ALTER TABLE tenant_settings DROP CONSTRAINT IF EXISTS tenant_settings_voice_tts_provider_check;
