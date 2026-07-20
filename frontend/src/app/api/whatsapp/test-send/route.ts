import { NextRequest, NextResponse } from 'next/server'
import { verifyTenantAccess, internalSecretHeader } from '@/lib/server/verify-tenant-access'

const BACKEND = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || ''

export async function POST(req: NextRequest) {
  if (!BACKEND) {
    return NextResponse.json(
      { success: false, error: 'BACKEND_URL is not configured' },
      { status: 503 }
    )
  }

  try {
    const body = await req.json()
    const { tenant_id, to_phone } = body
    if (!tenant_id || !(await verifyTenantAccess(tenant_id))) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
    }
    const upstream = await fetch(
      `${BACKEND.replace(/\/$/, '')}/webhook/whatsapp/test-send/${tenant_id}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...internalSecretHeader() },
        body: JSON.stringify({ to_phone }),
      }
    )
    const data = await upstream.json().catch(() => ({ success: false, error: `Backend error ${upstream.status}` }))
    return NextResponse.json(data, { status: upstream.ok ? 200 : upstream.status })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: `Could not reach backend: ${err instanceof Error ? err.message : 'network error'}` },
      { status: 502 }
    )
  }
}
