import { NextRequest, NextResponse } from 'next/server'
import { verifyTenantAccess, internalSecretHeader } from '@/lib/server/verify-tenant-access'

const BACKEND = (process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || '').trim()

export async function POST(req: NextRequest) {
  if (!BACKEND) {
    return NextResponse.json({ error: 'BACKEND_URL is not configured' }, { status: 503 })
  }

  try {
    const incoming = await req.formData()
    const tenantId = incoming.get('tenant_id')
    const file = incoming.get('file')
    if (typeof tenantId !== 'string' || !tenantId || !(await verifyTenantAccess(tenantId))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: 'A document file is required' }, { status: 400 })
    }

    // Re-forward as multipart/form-data -- do NOT set Content-Type manually,
    // fetch derives the correct boundary from the FormData body itself.
    const outgoing = new FormData()
    outgoing.set('tenant_id', tenantId)
    outgoing.set('file', file, (file as File).name || 'document')

    const upstream = await fetch(`${BACKEND.replace(/\/$/, '')}/api/agent/extract-faq`, {
      method: 'POST',
      headers: { ...internalSecretHeader() },
      body: outgoing,
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
