export const LLM_PROVIDERS = [
  {
    provider: 'groq',
    name: 'Groq (Free)',
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B — Best quality' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B — Fastest' },
      { id: 'llama-3.2-90b-vision-preview', name: 'Llama 3.2 90B Vision' },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B' },
      { id: 'gemma2-9b-it', name: 'Gemma 2 9B' },
    ],
    description: 'Free and fast. Best for real-time conversations.',
    recommended: true,
    estimatedCostPerCall: 'Free',
  },
  {
    provider: 'openai',
    name: 'OpenAI',
    models: [
      { id: 'gpt-4.1', name: 'GPT-4.1 — Latest' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini — Fast & affordable' },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano — Cheapest' },
      { id: 'gpt-4o', name: 'GPT-4o — Vision capable' },
      { id: 'o4-mini', name: 'o4 Mini — Advanced reasoning' },
      { id: 'o3', name: 'o3 — Most capable reasoning' },
    ],
    description: 'Most accurate, best for complex conversations.',
    recommended: false,
    estimatedCostPerCall: '$0.002–$0.01',
  },
  {
    provider: 'anthropic',
    name: 'Anthropic Claude',
    models: [
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 — Fastest' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 — Balanced' },
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7 — Most capable' },
    ],
    description: 'Excellent at following instructions and nuanced conversations.',
    recommended: false,
    estimatedCostPerCall: '$0.001–$0.015',
  },
  {
    provider: 'google',
    name: 'Google Gemini',
    models: [
      { id: 'gemini-2.5-flash-preview-04-17', name: 'Gemini 2.5 Flash — Latest' },
      { id: 'gemini-2.5-pro-exp-03-25', name: 'Gemini 2.5 Pro — Most capable' },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash — Stable' },
      { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite — Fastest' },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash' },
    ],
    description: 'Best for multilingual support. Free tier available.',
    recommended: false,
    estimatedCostPerCall: 'Free–$0.002',
  },
  {
    provider: 'mistral',
    name: 'Mistral AI',
    models: [
      { id: 'mistral-large-latest', name: 'Mistral Large — Best quality' },
      { id: 'mistral-small-latest', name: 'Mistral Small — Affordable' },
      { id: 'open-mistral-nemo', name: 'Mistral Nemo — Free' },
      { id: 'codestral-latest', name: 'Codestral — Code focused' },
    ],
    description: 'European AI, strong multilingual capabilities. Free tier available.',
    recommended: false,
    estimatedCostPerCall: 'Free–$0.003',
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
    { id: 'openai', name: 'OpenAI TTS' },
  ],
  zh: [
    { id: 'elevenlabs', name: 'ElevenLabs', recommended: true },
    { id: 'cartesia', name: 'Cartesia' },
  ],
}

export const OPENAI_TTS_VOICES = [
  { id: 'nova', name: 'Nova — Friendly female' },
  { id: 'alloy', name: 'Alloy — Neutral' },
  { id: 'echo', name: 'Echo — Male' },
  { id: 'fable', name: 'Fable — Expressive' },
  { id: 'onyx', name: 'Onyx — Deep male' },
  { id: 'shimmer', name: 'Shimmer — Soft female' },
]

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ms', name: 'Bahasa Melayu' },
  { code: 'zh', name: 'Mandarin' },
]
