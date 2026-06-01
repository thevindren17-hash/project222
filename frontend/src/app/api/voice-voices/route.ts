/**
 * GET /api/voice-voices
 * Fetches the authenticated user's ElevenLabs voice list server-side.
 * Returns all voices (premade + cloned) sorted: cloned first, then premade A-Z.
 * The browser never sees the API key — only the resolved voice list.
 */
import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export interface ElevenLabsVoice {
  voice_id: string
  name: string
  category: 'cloned' | 'premade' | 'professional' | 'generated' | string
  labels: Record<string, string>
  preview_url?: string
}

async function getServerSupabase() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )
}

async function getVerifiedTenantId(supabase: ReturnType<typeof createServerClient>) {
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  const { data: tenant } = await supabase
    .from('tenants').select('id').eq('owner_id', user.id).maybeSingle()
  if (tenant) return tenant.id
  const { data: profile } = await supabase
    .from('staff_profiles').select('tenant_id').eq('user_id', user.id).maybeSingle()
  return profile?.tenant_id ?? null
}

export async function GET() {
  const supabase = await getServerSupabase()
  const tenantId = await getVerifiedTenantId(supabase)
  if (!tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Read ElevenLabs key from voice_provider_credentials (service role via RLS)
  const { data } = await supabase
    .from('tenant_settings')
    .select('voice_provider_credentials')
    .eq('tenant_id', tenantId)
    .maybeSingle()

  const creds = (data?.voice_provider_credentials ?? {}) as Record<string, Record<string, string>>
  const apiKey = creds?.elevenlabs?.api_key

  if (!apiKey) {
    return NextResponse.json({ error: 'no_key', message: 'ElevenLabs API key not configured' }, { status: 404 })
  }

  // Fetch all voices from ElevenLabs
  const res = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': apiKey },
    next: { revalidate: 60 }, // cache 60s so rapid re-renders don't hammer the API
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return NextResponse.json(
      { error: 'elevenlabs_error', message: `ElevenLabs returned ${res.status}: ${body.slice(0, 200)}` },
      { status: res.status }
    )
  }

  const json = await res.json()
  const voices: ElevenLabsVoice[] = json.voices ?? []

  // Sort: user's own voices (cloned/generated/professional) first, then premade A-Z
  const own = voices.filter((v) => v.category !== 'premade').sort((a, b) => a.name.localeCompare(b.name))
  const premade = voices.filter((v) => v.category === 'premade').sort((a, b) => a.name.localeCompare(b.name))

  return NextResponse.json({ voices: [...own, ...premade] })
}
