import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: Request) {
  const { token, userId } = await req.json()

  if (!token || !userId) {
    return NextResponse.json({ error: 'Missing token or userId' }, { status: 400 })
  }

  const { data: invite, error: fetchError } = await supabaseAdmin
    .from('staff_invites')
    .select('id, tenant_id, email, role, expires_at, accepted_at')
    .eq('token', token)
    .maybeSingle()

  if (fetchError || !invite) {
    return NextResponse.json({ error: 'Invalid invite link' }, { status: 404 })
  }
  if (invite.accepted_at) {
    return NextResponse.json({ error: 'This invite has already been used' }, { status: 410 })
  }
  if (new Date(invite.expires_at) < new Date()) {
    return NextResponse.json({ error: 'This invite has expired' }, { status: 410 })
  }

  // Insert into staff_profiles
  const { error: insertError } = await supabaseAdmin
    .from('staff_profiles')
    .upsert({ user_id: userId, tenant_id: invite.tenant_id, role: invite.role })

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  // Mark invite as accepted
  await supabaseAdmin
    .from('staff_invites')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', invite.id)

  return NextResponse.json({ ok: true })
}
