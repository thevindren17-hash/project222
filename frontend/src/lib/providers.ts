// ── WhatsApp text agent providers ──────────────────────────────────────────

export const LLM_PROVIDERS = [
  {
    provider: 'groq',
    name: 'Groq (Free)',
    models: [
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B — Fastest (Free)' },
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B — Latest (Free)' },
      { id: 'llama-3.2-90b-vision-preview', name: 'Llama 3.2 90B — Most Powerful (Free)' },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B — Versatile (Free)' },
    ],
    description: 'Free and fast. Best for real-time conversations.',
    recommended: true,
    estimatedCostPerCall: 'Free',
  },
  {
    provider: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano — Cheapest' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini — Fast & Affordable' },
      { id: 'gpt-4.1', name: 'GPT-4.1 — Latest' },
      { id: 'o3', name: 'o3 — Most Powerful' },
    ],
    description: 'Most accurate, best for complex conversations.',
    recommended: false,
    estimatedCostPerCall: '$0.002–$0.01',
  },
  {
    provider: 'anthropic',
    name: 'Anthropic Claude',
    models: [
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 — Cheapest & Fastest' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 — Latest & Balanced' },
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7 — Most Powerful' },
    ],
    description: 'Excellent at following instructions and nuanced conversations.',
    recommended: false,
    estimatedCostPerCall: '$0.001–$0.015',
  },
  {
    provider: 'google',
    name: 'Google Gemini',
    models: [
      { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite — Cheapest' },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash — Fast & Stable' },
      { id: 'gemini-2.5-flash-preview-04-17', name: 'Gemini 2.5 Flash — Latest' },
      { id: 'gemini-2.5-pro-exp-03-25', name: 'Gemini 2.5 Pro — Most Powerful' },
    ],
    description: 'Best for multilingual support. Free tier available.',
    recommended: false,
    estimatedCostPerCall: 'Free–$0.002',
  },
  {
    provider: 'mistral',
    name: 'Mistral AI',
    models: [
      { id: 'open-mistral-nemo', name: 'Mistral Nemo — Free' },
      { id: 'mistral-small-latest', name: 'Mistral Small — Affordable' },
      { id: 'mistral-large-latest', name: 'Mistral Large — Latest & Best' },
      { id: 'codestral-latest', name: 'Codestral — Specialized (Code)' },
    ],
    description: 'European AI, strong multilingual capabilities. Free tier available.',
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
