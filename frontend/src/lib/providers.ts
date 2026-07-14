// ── Voice-agent specific providers ───────────────────────────────────────────

export const VOICE_LLM_PROVIDERS = [
  {
    provider: 'groq',
    name: 'Groq',
    badge: 'Free',
    models: [
      { id: 'llama-3.3-70b-versatile',  name: 'Llama 3.3 70B — Best Quality' },
      { id: 'llama-3.1-8b-instant',     name: 'Llama 3.1 8B — Lowest Latency' },
      { id: 'mixtral-8x7b-32768',       name: 'Mixtral 8x7B — Versatile' },
      { id: 'gemma2-9b-it',             name: 'Gemma 2 9B — Compact' },
    ],
    description: 'Ultra-low latency inference. Best for real-time voice conversations.',
    recommended: true,
    estimatedCostPerCall: 'Free',
    keyPlaceholder: 'gsk_...',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    provider: 'nvidia',
    name: 'NVIDIA NIM',
    badge: 'Free credits',
    models: [
      { id: 'meta/llama-3.3-70b-instruct',             name: 'Llama 3.3 70B — Powerful' },
      { id: 'meta/llama-3.1-8b-instruct',              name: 'Llama 3.1 8B — Fast' },
      { id: 'mistralai/mixtral-8x22b-instruct-v0.1',   name: 'Mixtral 8x22B — Versatile' },
      { id: 'mistralai/mixtral-8x7b-instruct-v0.1',    name: 'Mixtral 8x7B — Compact' },
      { id: 'microsoft/phi-4',                          name: 'Phi-4 — Compact & Smart' },
      { id: 'microsoft/phi-3-medium-128k-instruct',    name: 'Phi-3 Medium 128K — Long context' },
      { id: 'qwen/qwen2.5-72b-instruct',               name: 'Qwen 2.5 72B — Multilingual' },
      { id: 'qwen/qwen2.5-7b-instruct',                name: 'Qwen 2.5 7B — Fast multilingual' },
      { id: 'deepseek-ai/deepseek-r1',                 name: 'DeepSeek R1 — Reasoning' },
      { id: 'deepseek-ai/deepseek-r1-distill-llama-8b', name: 'DeepSeek R1 8B — Fast Reasoning' },
      { id: 'nvidia/llama-3.1-nemotron-70b-instruct',  name: 'Nemotron 70B — NVIDIA Fine-tuned' },
      { id: 'google/gemma-3-27b-it',                   name: 'Gemma 3 27B — Google' },
    ],
    description: 'NVIDIA-hosted models via OpenAI-compatible API. 1,000 free API calls/month on build.nvidia.com.',
    recommended: false,
    estimatedCostPerCall: 'Free credits',
    keyPlaceholder: 'nvapi-...',
    keyUrl: 'https://build.nvidia.com',
  },
  {
    provider: 'openai',
    name: 'OpenAI',
    badge: null,
    models: [
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini — Affordable' },
      { id: 'gpt-4.1',      name: 'GPT-4.1 — Best Accuracy' },
    ],
    description: 'Most accurate. Great for complex multi-turn voice conversations.',
    recommended: false,
    estimatedCostPerCall: '$0.002–$0.01',
    keyPlaceholder: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    provider: 'anthropic',
    name: 'Anthropic Claude',
    badge: null,
    models: [
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5 — Fastest' },
      { id: 'claude-sonnet-4-6',         name: 'Claude Sonnet 4.6 — Balanced' },
    ],
    description: 'Excellent instruction-following. Smooth, natural conversation style.',
    recommended: false,
    estimatedCostPerCall: '$0.001–$0.015',
    keyPlaceholder: 'sk-ant-...',
    keyUrl: 'https://console.anthropic.com',
  },
  {
    provider: 'google',
    name: 'Google Gemini',
    badge: 'Free tier',
    models: [
      { id: 'gemini-2.0-flash-lite',           name: 'Gemini 2.0 Flash Lite — Cheapest' },
      { id: 'gemini-2.0-flash',                name: 'Gemini 2.0 Flash — Balanced' },
      { id: 'gemini-2.5-flash-preview-04-17',  name: 'Gemini 2.5 Flash — Best Multilingual' },
    ],
    description: 'Best multilingual support. Free tier available for low-volume use.',
    recommended: false,
    estimatedCostPerCall: 'Free–$0.002',
    keyPlaceholder: 'AIza...',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
]

// ── STT (Speech-to-Text) ─────────────────────────────────────────────────────
// Hardcoded to Groq Whisper — not tenant-selectable. A clinic owner can't
// judge which provider actually covers Malay/Tamil, and picking wrong
// silently breaks the core multilingual value prop (this bit VoiceAI once
// already, when a tenant's saved provider was an English-only engine).
// Tenants can still BYOK their own Groq key; they just can't swap the engine.

export const VOICE_STT_FIXED = {
  id: 'groq',
  name: 'Groq Whisper',
  badge: 'Free · Multilingual',
  description: 'Whisper Large v3 Turbo via Groq. Free, <300 ms, and supports all 4 Malaysian languages — English, Bahasa Melayu, Mandarin, Tamil.',
  keyPlaceholder: 'gsk_...',
  keyUrl: 'https://console.groq.com/keys',
  supportsLanguages: ['English', 'Bahasa Melayu', 'Mandarin', 'Tamil', '90+ languages'],
}

// ── TTS (Text-to-Speech) ──────────────────────────────────────────────────────
// Hardcoded to ElevenLabs, with one fixed voice per language — not
// tenant-configurable. See VoiceAI/config.py VOICE_MAP for the actual IDs.
// eleven_turbo_v2_5 auto-detects language — do NOT pass language= to avoid WS disconnect

export const VOICE_TTS_FIXED = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  badge: 'Multilingual',
  description: 'eleven_turbo_v2_5 with one fixed voice per language (English, Bahasa Melayu, Mandarin, Tamil) — same for every clinic, nothing to configure.',
}

// ── WhatsApp / text agent providers (unchanged) ────────────────────────────

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
