import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

const raw = (process.env.VOICEAI_URL || '').trim().replace(/\/$/, '')
const VOICEAI_URL = raw && !raw.startsWith('http') ? `https://${raw}` : raw
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || ''

export async function POST(req: NextRequest) {
  // ── 1. Verify the user is logged in ──────────────────────────────────────
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {},
      },
    }
  )

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  }

  // ── 2. Resolve tenant_id from the server — never trust the client ─────────
  const { data: tenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('owner_id', user.id)
    .maybeSingle()

  // Staff path: check staff_profiles if not owner
  let tenantId = tenant?.id
  if (!tenantId) {
    const { data: profile } = await supabase
      .from('staff_profiles')
      .select('tenant_id')
      .eq('user_id', user.id)
      .maybeSingle()
    tenantId = profile?.tenant_id
  }

  if (!tenantId) {
    return NextResponse.json({ detail: 'Tenant not found' }, { status: 404 })
  }

  // ── 3. Forward to VoiceAI backend with internal secret ───────────────────
  if (!VOICEAI_URL) {
    return NextResponse.json(
      { detail: 'VOICEAI_URL is not set. Add it to your Vercel environment variables.' },
      { status: 503 }
    )
  }

  try {
    const body = await req.json().catch(() => ({}))
    const upstream = await fetch(`${VOICEAI_URL}/api/voice-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_SECRET ? { 'X-Internal-Secret': INTERNAL_SECRET } : {}),
      },
      // Override tenant_id from the verified server session
      body: JSON.stringify({ ...body, tenant_id: tenantId }),
    })

    const data = await upstream.json().catch(() => ({ detail: `VoiceAI backend error ${upstream.status}` }))
    return NextResponse.json(data, { status: upstream.status })
  } catch (err) {
    return NextResponse.json(
      { detail: `Could not reach VoiceAI backend: ${err instanceof Error ? err.message : 'network error'}` },
      { status: 502 }
    )
  }
}
