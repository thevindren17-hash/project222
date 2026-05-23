import { NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function POST(req: NextRequest) {
  try {
    // ── 1. Verify the user is logged in ────────────────────────────────────
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

    // ── 2. Resolve tenant_id server-side ───────────────────────────────────
    const { data: tenant } = await supabase
      .from('tenants')
      .select('id')
      .eq('owner_id', user.id)
      .maybeSingle()

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

    // ── 3. Validate VOICEAI_URL ────────────────────────────────────────────
    const rawUrl = (process.env.VOICEAI_URL || '').trim().replace(/\/$/, '')
    const voiceaiUrl = rawUrl && !rawUrl.startsWith('http') ? `https://${rawUrl}` : rawUrl

    if (!voiceaiUrl) {
      return NextResponse.json(
        { detail: 'VOICEAI_URL is not configured in Vercel environment variables.' },
        { status: 503 }
      )
    }

    // ── 4. Forward to VoiceAI backend ─────────────────────────────────────
    const internalSecret = process.env.INTERNAL_API_SECRET || ''
    const body = await req.json().catch(() => ({}))

    const upstream = await fetch(`${voiceaiUrl}/api/voice-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(internalSecret ? { 'X-Internal-Secret': internalSecret } : {}),
      },
      body: JSON.stringify({ ...body, tenant_id: tenantId }),
    })

    const data = await upstream.json().catch(() => ({
      detail: `VoiceAI backend returned ${upstream.status} (non-JSON response)`,
    }))
    return NextResponse.json(data, { status: upstream.status })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[voice-token] error:', message)
    return NextResponse.json(
      { detail: `voice-token error: ${message}` },
      { status: 500 }
    )
  }
}
