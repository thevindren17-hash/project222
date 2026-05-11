export const LLM_PROVIDERS = [
  {
    provider: 'groq',
    name: 'Groq',
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B' },
    ],
    description: 'Fastest inference, best for real-time voice',
    recommended: true,
    estimatedCostPerCall: '$0.001',
  },
  {
    provider: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    ],
    description: 'Most accurate, best for complex conversations',
    recommended: false,
    estimatedCostPerCall: '$0.005',
  },
  {
    provider: 'anthropic',
    name: 'Anthropic',
    models: [
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4' },
    ],
    description: 'Nuanced conversations, great at following instructions',
    recommended: false,
    estimatedCostPerCall: '$0.004',
  },
  {
    provider: 'google',
    name: 'Google',
    models: [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro' },
    ],
    description: 'Best for multilingual support',
    recommended: false,
    estimatedCostPerCall: '$0.002',
  },
]

export const STT_PROVIDERS: Record<string, Array<{ id: string; name: string; recommended?: boolean }>> = {
  en: [
    { id: 'deepgram', name: 'Deepgram Nova-2', recommended: true },
    { id: 'openai', name: 'Whisper (OpenAI)' },
  ],
  ms: [
    { id: 'openai', name: 'Whisper (OpenAI)', recommended: true },
    { id: 'deepgram', name: 'Deepgram' },
  ],
  zh: [
    { id: 'deepgram', name: 'Deepgram', recommended: true },
    { id: 'openai', name: 'Whisper (OpenAI)' },
  ],
}

export const TTS_PROVIDERS: Record<string, Array<{ id: string; name: string; recommended?: boolean }>> = {
  en: [
    { id: 'cartesia', name: 'Cartesia Sonic', recommended: true },
    { id: 'elevenlabs', name: 'ElevenLabs' },
    { id: 'openai', name: 'OpenAI TTS' },
  ],
  ms: [
    { id: 'elevenlabs', name: 'ElevenLabs', recommended: true },
    { id: 'cartesia', name: 'Cartesia' },
  ],
  zh: [
    { id: 'elevenlabs', name: 'ElevenLabs', recommended: true },
    { id: 'cartesia', name: 'Cartesia' },
  ],
}

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ms', name: 'Bahasa Melayu' },
  { code: 'zh', name: 'Mandarin' },
]
