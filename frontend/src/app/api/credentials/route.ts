/**
 * Credentials API — API keys are written and read exclusively server-side.
 * The browser never receives actual key values — only boolean existence flags.
 *
 * GET  /api/credentials?type=voice|agent  → { groq: true, openai: false, ... }
 * POST /api/credentials                   → save one provider key
 * DELETE /api/credentials?provider=groq&type=agent → remove a key
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

type CredType = 'agent' | 'voice'
const FIELD: Record<CredType, string> = {
  agent: 'provider_credentials',
  voice: 'voice_provider_credentials',
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

// ── GET — return existence flags only (never actual values) ──────────────────
export async function GET(req: NextRequest) {
  const supabase = await getServerSupabase()
  const tenantId = await getVerifiedTenantId(supabase)
  if (!tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const type = (req.nextUrl.searchParams.get('type') ?? 'agent') as CredType
  const field = FIELD[type] ?? FIELD.agent

  const { data } = await supabase
    .from('tenant_settings')
    .select(field)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  const creds = (data?.[field as keyof typeof data] ?? {}) as Record<string, Record<string, string>>
  const existence: Record<string, boolean> = {}
  for (const [provider, val] of Object.entries(creds)) {
    existence[provider] = !!val?.api_key
  }
  return NextResponse.json(existence)
}

// ── POST — save a provider key (merge into existing JSONB) ───────────────────
export async function POST(req: NextRequest) {
  const supabase = await getServerSupabase()
  const tenantId = await getVerifiedTenantId(supabase)
  if (!tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const provider: string = body?.provider
  const apiKey: string  = body?.api_key
  const type: CredType  = body?.type ?? 'agent'

  if (!provider || !apiKey) {
    return NextResponse.json({ error: 'provider and api_key are required' }, { status: 400 })
  }
  const field = FIELD[type] ?? FIELD.agent

  // Read current, merge, write back
  const { data: existing } = await supabase
    .from('tenant_settings').select(field).eq('tenant_id', tenantId).maybeSingle()
  const current = (existing?.[field as keyof typeof existing] ?? {}) as Record<string, unknown>
  const updated = { ...current, [provider]: { api_key: apiKey } }

  const { error } = await supabase.from('tenant_settings').upsert(
    { tenant_id: tenantId, [field]: updated },
    { onConflict: 'tenant_id' }
  )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, provider, configured: true })
}

// ── DELETE — remove a provider key ──────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  const supabase = await getServerSupabase()
  const tenantId = await getVerifiedTenantId(supabase)
  if (!tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const provider = req.nextUrl.searchParams.get('provider')
  const type = (req.nextUrl.searchParams.get('type') ?? 'agent') as CredType
  if (!provider) return NextResponse.json({ error: 'provider param required' }, { status: 400 })

  const field = FIELD[type] ?? FIELD.agent
  const { data: existing } = await supabase
    .from('tenant_settings').select(field).eq('tenant_id', tenantId).maybeSingle()
  const current = { ...(existing?.[field as keyof typeof existing] ?? {}) } as Record<string, unknown>
  delete current[provider]

  await supabase.from('tenant_settings').upsert(
    { tenant_id: tenantId, [field]: current },
    { onConflict: 'tenant_id' }
  )
  return NextResponse.json({ success: true })
}
