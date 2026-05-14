import { NextRequest, NextResponse } from 'next/server'

const BACKEND = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || ''

export async function GET(req: NextRequest) {
  const { searchParams, origin } = new URL(req.url)
  const calendarPage = `${origin}/settings/plugins/calendar`

  const error = searchParams.get('error')
  if (error) {
    const messages: Record<string, string> = {
      access_denied: 'access_denied',
    }
    return NextResponse.redirect(`${calendarPage}?error=${messages[error] ?? error}`)
  }

  const code = searchParams.get('code')
  const state = searchParams.get('state')

  if (!code || !state) {
    return NextResponse.redirect(`${calendarPage}?error=missing_params`)
  }

  if (!BACKEND) {
    return NextResponse.redirect(`${calendarPage}?error=backend_not_configured`)
  }

  try {
    // Ask Railway to exchange the code and store the tokens
    const res = await fetch(`${BACKEND}/api/integrations/google/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    })

    const data = await res.json().catch(() => ({ success: false }))

    if (!res.ok || !data.success) {
      const detail = data.detail || data.error || 'token_exchange_failed'
      return NextResponse.redirect(`${calendarPage}?error=${encodeURIComponent(detail)}`)
    }

    return NextResponse.redirect(`${calendarPage}?success=true`)
  } catch {
    return NextResponse.redirect(`${calendarPage}?error=network_error`)
  }
}
