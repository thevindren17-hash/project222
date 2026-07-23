// ── WhatsApp text agent providers ──────────────────────────────────────────

// Model IDs below are periodically retired by each provider without
// warning (this is what broke Gemini's "2.5 Flash" option — Google pulled
// the dated preview snapshot it pointed to). Prefer stable, non-versioned
// IDs; avoid "-preview"/"-exp-"-suffixed snapshots where a stable
// equivalent exists, since those are the ones providers retire fastest.
export const LLM_PROVIDERS = [
  {
    provider: 'groq',
    name: 'Groq (Free)',
    models: [
      { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B — Cheapest & Fastest (Free)' },
      { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B — Recommended (Free)' },
    ],
    description: 'Free and fast. Best for real-time conversations.',
    recommended: true,
    estimatedCostPerCall: 'Free',
  },
  {
    provider: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano — Cheapest' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini — Fast & Affordable' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna — Latest' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol — Most Powerful' },
    ],
    description: 'Most accurate, best for complex conversations.',
    recommended: false,
    estimatedCostPerCall: '$0.001–$0.02',
  },
  {
    provider: 'anthropic',
    name: 'Anthropic Claude',
    models: [
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 — Cheapest & Fastest' },
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5 — Latest & Balanced' },
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8 — Most Powerful' },
    ],
    description: 'Excellent at following instructions and nuanced conversations.',
    recommended: false,
    estimatedCostPerCall: '$0.001–$0.02',
  },
  {
    provider: 'google',
    name: 'Google Gemini',
    models: [
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite — Cheapest' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash — Fast & Stable' },
      { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash — Latest' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro — Most Powerful' },
    ],
    description: 'Best for multilingual support. Free tier available.',
    recommended: false,
    estimatedCostPerCall: 'Free–$0.01',
  },
  {
    provider: 'mistral',
    name: 'Mistral AI',
    models: [
      { id: 'mistral-small-latest', name: 'Mistral Small — Affordable' },
      { id: 'mistral-large-latest', name: 'Mistral Large — Latest & Best' },
      { id: 'codestral-latest', name: 'Codestral — Specialized (Code)' },
    ],
    description: 'European AI, strong multilingual capabilities. "-latest" aliases auto-track the current model generation.',
    recommended: false,
    estimatedCostPerCall: 'Free–$0.003',
  },
]

export const OPENAI_TTS_VOICES = [
  { id: 'nova', name: 'Nova — Friendly female' },
  { id: 'alloy', name: 'Alloy — Neutral' },
  { id: 'echo', name: 'Echo — Male' },
  { id: 'fable', name: 'Fable — Expressive' },
  { id: 'onyx', name: 'Onyx — Deep male' },
  { id: 'shimmer', name: 'Shimmer — Soft female' },
]

// ── WhatsApp Voice Messages — STT (speech-to-text) providers ──────────────────
// Bring-your-own-key, same pattern as LLM_PROVIDERS above.

export const VOICE_STT_PROVIDERS = [
  {
    provider: 'groq',
    name: 'Groq Whisper',
    badge: 'Free',
    description: 'Whisper large-v3-turbo — free, fast, and covers Malay & Tamil better than Deepgram.',
    recommended: true,
    keyPlaceholder: 'gsk_...',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    provider: 'openai',
    name: 'OpenAI Whisper',
    badge: null,
    description: 'Whisper-1 — reliable, widely used, ~$0.006/minute.',
    recommended: false,
    keyPlaceholder: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    provider: 'deepgram',
    name: 'Deepgram Nova-2',
    badge: null,
    description: 'Fast, tuned for real-time transcription. English-focused.',
    recommended: false,
    keyPlaceholder: 'Deepgram API key',
    keyUrl: 'https://console.deepgram.com',
  },
]

// ── WhatsApp Voice Messages — TTS (text-to-speech) providers ──────────────────
// One voice per language (English / Bahasa Melayu / Mandarin — matching the
// languages the agent's Language Settings tab supports as reply languages).
//
// OpenAI voices work for any language (same 6 named voices offered per
// language). ElevenLabs voice IDs are account-agnostic "premade" voices from
// the ElevenLabs Voice Library — these three IDs are verified working, taken
// from a proven multilingual voice-agent build, not guessed. A custom voice
// ID can also be pasted in per language for clinics with their own cloned
// ElevenLabs voice.

export type VoiceOption = { id: string; name: string }

export const VOICE_TTS_PROVIDERS: {
  provider: string
  name: string
  badge: string | null
  keyPlaceholder: string
  keyUrl: string
  voicesByLanguage: Record<'en' | 'ms' | 'zh', VoiceOption[]>
}[] = [
  {
    provider: 'elevenlabs',
    name: 'ElevenLabs',
    badge: 'Recommended for voice notes',
    keyPlaceholder: 'ElevenLabs API key',
    keyUrl: 'https://elevenlabs.io/app/settings/api-keys',
    voicesByLanguage: {
      en: [{ id: 'cgSgspJ2msm6clMCkdW9', name: 'English voice' }],
      ms: [{ id: 'qAJVXEQ6QgjOQ25KuoU8', name: 'Bahasa Melayu voice' }],
      zh: [{ id: 'tOuLUAIdXShmWH7PEUrU', name: 'Mandarin voice' }],
    },
  },
  {
    provider: 'openai',
    name: 'OpenAI TTS',
    badge: null,
    keyPlaceholder: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
    voicesByLanguage: {
      en: OPENAI_TTS_VOICES,
      ms: OPENAI_TTS_VOICES,
      zh: OPENAI_TTS_VOICES,
    },
  },
]

export const VOICE_LANGUAGES: { code: 'en' | 'ms' | 'zh'; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'ms', name: 'Bahasa Melayu' },
  { code: 'zh', name: 'Mandarin' },
]
