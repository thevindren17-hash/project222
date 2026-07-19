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
