import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/server/verify-tenant-access'

export async function POST(req: Request) {
  const { token } = await req.json()

  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 })
  }

  // Derive the user from the session cookie — never trust a client-supplied
  // userId, or a leaked/guessed invite link could add an attacker as staff
  // on someone else's tenant.
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} } }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'You must be logged in to accept an invite' }, { status: 401 })
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
  // A leaked/forwarded invite link must not let the wrong person join as
  // staff — only the account whose email matches the invite can accept it.
  if ((invite.email || '').trim().toLowerCase() !== (user.email || '').trim().toLowerCase()) {
    return NextResponse.json(
      { error: `This invite was sent to ${invite.email}. Please log in with that email to accept it.` },
      { status: 403 }
    )
  }

  // Insert into staff_profiles
  const { error: insertError } = await supabaseAdmin
    .from('staff_profiles')
    .upsert({ user_id: user.id, tenant_id: invite.tenant_id, role: invite.role })

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
