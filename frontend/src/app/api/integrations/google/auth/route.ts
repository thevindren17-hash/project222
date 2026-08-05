import { NextRequest, NextResponse } from 'next/server'
import { verifyTenantAccess, signTenantAction } from '@/lib/server/verify-tenant-access'

const BACKEND = (process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || '').trim()

export async function GET(req: NextRequest) {
  const { searchParams, origin } = new URL(req.url)
  const tenantId = searchParams.get('tenant_id')
  const googlePage = `${origin}/settings/plugins/google`

  if (!BACKEND) {
    return NextResponse.json(
      { detail: 'BACKEND_URL is not set. Add it to your Vercel environment variables.' },
      { status: 503 }
    )
  }

  // Confirm the logged-in user actually owns/staffs this tenant before ever
  // redirecting to Google — otherwise anyone who learns a tenant_id could
  // start (and complete) the OAuth flow and have their own Google account
  // attached to someone else's clinic.
  if (!tenantId || !(await verifyTenantAccess(tenantId))) {
    return NextResponse.redirect(`${googlePage}?error=unauthorized`)
  }

  const { exp, sig } = signTenantAction(tenantId)
  const upstream = `${BACKEND}/api/integrations/google/auth?tenant_id=${encodeURIComponent(tenantId)}&exp=${exp}&sig=${encodeURIComponent(sig)}`
  return NextResponse.redirect(upstream)
}
