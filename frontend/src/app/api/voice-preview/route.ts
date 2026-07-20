import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const DEMO_PHRASE: Record<string, string> = {
  en: 'Hi, this is how I sound.',
  ms: 'Hai, macam ini bunyi saya.',
  zh: '你好，我的声音是这样的。',
}

// Best-effort per-tenant limiter (in-memory — resets on cold start / across
// instances, but still blocks the obvious "click preview in a loop" abuse case).
const _previewCalls = new Map<string, number[]>()
const _PREVIEW_WINDOW_MS = 60_000
const _PREVIEW_MAX = 10

function isRateLimited(tenantId: string): boolean {
  const now = Date.now()
  const calls = (_previewCalls.get(tenantId) ?? []).filter((t) => now - t < _PREVIEW_WINDOW_MS)
  if (calls.length >= _PREVIEW_MAX) {
    _previewCalls.set(tenantId, calls)
    return true
  }
  calls.push(now)
  _previewCalls.set(tenantId, calls)
  return false
}

async function verifyTenantAccess(tenantId: string): Promise<boolean> {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(toSet) { try { toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options)) } catch {} },
      },
    }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false

  const { data: owned } = await supabaseAdmin
    .from('tenants').select('id').eq('id', tenantId).eq('owner_id', user.id).maybeSingle()
  if (owned) return true

  const { data: staff } = await supabaseAdmin
    .from('staff_profiles').select('id').eq('tenant_id', tenantId).eq('user_id', user.id).maybeSingle()
  return !!staff
}

export async function POST(req: NextRequest) {
  try {
    const { tenant_id, provider, voice_id, language } = await req.json() as {
      tenant_id: string
      provider: 'openai' | 'elevenlabs'
      voice_id: string
      language: string
    }

    if (!tenant_id || !provider || !voice_id) {
      return NextResponse.json({ error: 'tenant_id, provider, and voice_id are required' }, { status: 400 })
    }

    if (!await verifyTenantAccess(tenant_id)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    if (isRateLimited(tenant_id)) {
      return NextResponse.json({ error: 'Too many previews — please wait a moment' }, { status: 429 })
    }

    const { data: settings } = await supabaseAdmin
      .from('tenant_settings')
      .select('provider_credentials')
      .eq('tenant_id', tenant_id)
      .maybeSingle()

    const apiKey: string | undefined = settings?.provider_credentials?.[provider]?.api_key
    if (!apiKey) {
      return NextResponse.json({ error: `No ${provider} API key saved yet` }, { status: 400 })
    }

    const text = DEMO_PHRASE[language] || DEMO_PHRASE.en

    if (provider === 'elevenlabs') {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice_id}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
        }
      )
      if (!res.ok) {
        const err = await res.text()
        return NextResponse.json({ error: `ElevenLabs error: ${err}` }, { status: 502 })
      }
      const audio = await res.arrayBuffer()
      return new NextResponse(audio, { headers: { 'Content-Type': 'audio/mpeg' } })
    }

    // OpenAI
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', voice: voice_id, input: text, response_format: 'mp3' }),
    })
    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: `OpenAI error: ${err}` }, { status: 502 })
    }
    const audio = await res.arrayBuffer()
    return new NextResponse(audio, { headers: { 'Content-Type': 'audio/mpeg' } })
  } catch (e) {
    console.error('voice-preview error:', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
