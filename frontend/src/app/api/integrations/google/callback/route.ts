import { NextRequest, NextResponse } from 'next/server'
import { internalSecretHeader } from '@/lib/server/verify-tenant-access'

const BACKEND = (process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || '').trim()

export async function GET(req: NextRequest) {
  const { searchParams, origin } = new URL(req.url)

  const code = searchParams.get('code')
  const state = searchParams.get('state')

  // The service (calendar vs sheets) determines which settings page to send
  // the user back to — parse it from state before we know if anything else
  // succeeded, so even error redirects land on the right page.
  let servicePage = 'calendar'
  if (state) {
    try {
      const parsed = JSON.parse(state) as { service?: string }
      if (parsed.service === 'sheets') servicePage = 'sheets'
    } catch {}
  }
  const destPage = `${origin}/settings/plugins/${servicePage}`

  const error = searchParams.get('error')
  if (error) {
    const messages: Record<string, string> = {
      access_denied: 'access_denied',
    }
    return NextResponse.redirect(`${destPage}?error=${messages[error] ?? error}`)
  }

  if (!code || !state) {
    return NextResponse.redirect(`${destPage}?error=missing_params`)
  }

  if (!BACKEND) {
    return NextResponse.redirect(`${destPage}?error=backend_not_configured`)
  }

  // The `state` param carries which tenant this connection is for — confirm the
  // logged-in user actually owns/staffs that tenant before storing any tokens,
  // so a forged state can't attach an attacker's Google account to someone else's clinic.
  try {
    const { tenant_id } = JSON.parse(state) as { tenant_id?: string }
    const { verifyTenantAccess } = await import('@/lib/server/verify-tenant-access')
    if (!tenant_id || !(await verifyTenantAccess(tenant_id))) {
      return NextResponse.redirect(`${destPage}?error=unauthorized`)
    }
  } catch {
    return NextResponse.redirect(`${destPage}?error=invalid_state`)
  }

  try {
    // Ask Railway to exchange the code and store the tokens
    const res = await fetch(`${BACKEND}/api/integrations/google/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...internalSecretHeader() },
      body: JSON.stringify({ code, state }),
    })

    const data = await res.json().catch(() => ({ success: false }))

    if (!res.ok || !data.success) {
      const detail = data.detail || data.error || 'token_exchange_failed'
      return NextResponse.redirect(`${destPage}?error=${encodeURIComponent(detail)}`)
    }

    return NextResponse.redirect(`${destPage}?success=true`)
  } catch {
    return NextResponse.redirect(`${destPage}?error=network_error`)
  }
}
