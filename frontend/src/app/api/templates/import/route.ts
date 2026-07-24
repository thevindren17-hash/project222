import { NextRequest, NextResponse } from 'next/server'
import { verifyTenantAccess, internalSecretHeader } from '@/lib/server/verify-tenant-access'

const BACKEND = (process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || '').trim()

export async function POST(req: NextRequest) {
  if (!BACKEND) {
    return NextResponse.json({ error: 'BACKEND_URL is not configured' }, { status: 503 })
  }

  try {
    const body = await req.json()
    const { tenant_id } = body
    if (!tenant_id || !(await verifyTenantAccess(tenant_id))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    const upstream = await fetch(`${BACKEND.replace(/\/$/, '')}/api/templates/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...internalSecretHeader() },
      body: JSON.stringify(body),
    })
    const data = await upstream.json().catch(() => ({ error: `Backend error ${upstream.status}` }))
    return NextResponse.json(data, { status: upstream.ok ? 200 : upstream.status })
  } catch (err) {
    return NextResponse.json(
      { error: `Could not reach backend: ${err instanceof Error ? err.message : 'network error'}` },
      { status: 502 }
    )
  }
}
