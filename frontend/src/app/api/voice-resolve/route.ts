/**
 * GET /api/voice-resolve?voice_id=xxx
 * Resolves a single ElevenLabs voice ID to its name/category.
 * Works for any voice ID — own, premade, or community voices used directly.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

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

export async function GET(req: NextRequest) {
  const voiceId = req.nextUrl.searchParams.get('voice_id')?.trim()
  if (!voiceId) return NextResponse.json({ error: 'voice_id required' }, { status: 400 })

  const supabase = await getServerSupabase()
  const tenantId = await getVerifiedTenantId(supabase)
  if (!tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data } = await supabase
    .from('tenant_settings')
    .select('voice_provider_credentials')
    .eq('tenant_id', tenantId)
    .maybeSingle()

  const creds = (data?.voice_provider_credentials ?? {}) as Record<string, Record<string, string>>
  const apiKey = creds?.elevenlabs?.api_key
  if (!apiKey) return NextResponse.json({ error: 'no_key' }, { status: 404 })

  const res = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
    headers: { 'xi-api-key': apiKey },
  })

  if (!res.ok) {
    return NextResponse.json({ error: 'not_found', voice_id: voiceId }, { status: res.status })
  }

  const voice = await res.json()
  return NextResponse.json({
    voice_id: voice.voice_id,
    name: voice.name,
    category: voice.category,
    labels: voice.labels ?? {},
  })
}
