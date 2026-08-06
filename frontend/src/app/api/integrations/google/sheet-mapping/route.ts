import { NextRequest, NextResponse } from 'next/server'
import { verifyTenantAccess, internalSecretHeader } from '@/lib/server/verify-tenant-access'

const BACKEND = (process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || '').trim()

export async function GET(req: NextRequest) {
  const tenantId = new URL(req.url).searchParams.get('tenant_id')
  if (!tenantId || !(await verifyTenantAccess(tenantId))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }
  if (!BACKEND) {
    return NextResponse.json({ error: 'BACKEND_URL is not configured' }, { status: 503 })
  }

  try {
    const upstream = await fetch(
      `${BACKEND.replace(/\/$/, '')}/api/integrations/google/sheet-mapping?tenant_id=${encodeURIComponent(tenantId)}`,
      { headers: { ...internalSecretHeader() } }
    )
    const data = await upstream.json().catch(() => ({ detail: `Backend error ${upstream.status}` }))
    return NextResponse.json(data, { status: upstream.status })
  } catch (err) {
    return NextResponse.json(
      { error: `Could not reach backend: ${err instanceof Error ? err.message : 'network error'}` },
      { status: 502 }
    )
  }
}
