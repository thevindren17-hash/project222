import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const { data: invite, error } = await supabaseAdmin
    .from('staff_invites')
    .select('id, email, role, expires_at, accepted_at, tenant_id, tenants(name)')
    .eq('token', token)
    .maybeSingle()

  if (error || !invite) {
    return NextResponse.json({ error: 'Invalid invite link' }, { status: 404 })
  }
  if (invite.accepted_at) {
    return NextResponse.json({ error: 'This invite has already been used' }, { status: 410 })
  }
  if (new Date(invite.expires_at) < new Date()) {
    return NextResponse.json({ error: 'This invite has expired' }, { status: 410 })
  }

  const tenant = invite.tenants as { name: string } | null

  return NextResponse.json({
    email: invite.email,
    role: invite.role,
    clinicName: tenant?.name ?? 'Unknown Clinic',
  })
}
