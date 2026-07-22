/**
 * Credentials API — API keys are written and read exclusively server-side.
 * The browser never receives actual key values — only boolean existence flags.
 *
 * GET  /api/credentials?type=voice|agent  → { groq: true, openai: false, ... }
 * POST /api/credentials                   → save one provider's credential(s).
 *   Legacy single-value shape:  { provider, api_key, type }
 *   Multi-field shape (e.g. an OAuth client_id + client_secret pair):
 *                                { provider, fields: { client_id, client_secret }, type }
 * DELETE /api/credentials?provider=groq&type=agent → remove a credential
 */
import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

type CredType = 'agent' | 'voice'
const FIELD: Record<CredType, string> = {
  agent: 'provider_credentials',
  voice: 'voice_provider_credentials',
}

// Most providers just need `api_key` to count as "configured" — a few store
// multiple fields and need all of them present before they're usable.
const REQUIRED_FIELDS: Record<string, string[]> = {
  google: ['client_id', 'client_secret'],
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
    const required = REQUIRED_FIELDS[provider]
    existence[provider] = required ? required.every((f) => !!val?.[f]) : !!val?.api_key
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
  const type: CredType  = body?.type ?? 'agent'

  // Accept either the legacy single-value shape ({api_key}) or a generic
  // multi-field shape ({fields: {...}}) — an OAuth client_id/client_secret
  // pair needs two values, a plain API key needs one.
  const fieldsToStore: Record<string, string> =
    body?.fields && typeof body.fields === 'object'
      ? body.fields
      : body?.api_key ? { api_key: body.api_key } : {}

  if (!provider || Object.keys(fieldsToStore).length === 0) {
    return NextResponse.json({ error: 'provider and api_key (or fields) are required' }, { status: 400 })
  }
  const field = FIELD[type] ?? FIELD.agent

  // Encrypt each value at rest (pgcrypto, see migrations/005_encrypt_credentials.sql).
  // If no encryption key is configured yet, fall back to storing plaintext
  // rather than blocking key saves — this is only a temporary state until
  // CREDENTIAL_ENCRYPTION_KEY is set in the environment.
  const encKey = process.env.CREDENTIAL_ENCRYPTION_KEY || ''
  const storedFields: Record<string, string> = {}
  for (const [key, value] of Object.entries(fieldsToStore)) {
    if (!value) continue
    if (!encKey) { storedFields[key] = value; continue }
    const { data: ciphertext, error: encErr } = await supabase.rpc('encrypt_credential', {
      plaintext: value,
      key: encKey,
    })
    if (encErr || !ciphertext) {
      return NextResponse.json({ error: `Failed to encrypt ${key}` }, { status: 500 })
    }
    storedFields[key] = `enc:v1:${ciphertext}`
  }

  // Read current, merge, write back
  const { data: existing } = await supabase
    .from('tenant_settings').select(field).eq('tenant_id', tenantId).maybeSingle()
  const raw = existing?.[field as keyof typeof existing]
  const current = (raw && typeof raw === 'object' ? raw : {}) as Record<string, Record<string, string>>
  const updated = { ...current, [provider]: { ...(current[provider] || {}), ...storedFields } }

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
  const rawDel = existing?.[field as keyof typeof existing]
  const current = { ...(rawDel && typeof rawDel === 'object' ? rawDel : {}) } as Record<string, unknown>
  delete current[provider]

  await supabase.from('tenant_settings').upsert(
    { tenant_id: tenantId, [field]: current },
    { onConflict: 'tenant_id' }
  )
  return NextResponse.json({ success: true })
}
