import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function verifyTenantAccess(tenantId: string): Promise<boolean> {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(toSet) { try { toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options)) } catch {} },
      },
    }
  )
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false

  const { data: owned } = await supabaseAdmin
    .from('tenants').select('id').eq('id', tenantId).eq('owner_id', user.id).maybeSingle()
  if (owned) return true

  const { data: staff } = await supabaseAdmin
    .from('staff_profiles').select('id').eq('tenant_id', tenantId).eq('user_id', user.id).maybeSingle()
  return !!staff
}

// Only this tenant's own patient-record follow-up batches, with how many of
// the original contacts still have a follow-up pending -- shown on the
// Message Templates dashboard page so a clinic can see a batch is still
// running (and stop it) without digging through raw campaign rows.
export async function GET(req: NextRequest) {
  const tenantId = req.nextUrl.searchParams.get('tenant_id')
  if (!tenantId) return NextResponse.json({ error: 'tenant_id is required' }, { status: 400 })
  if (!await verifyTenantAccess(tenantId)) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  const { data: allBatches, error } = await supabaseAdmin
    .from('campaign_batches')
    .select('id, name, template_id, followup_template_id, followup_schedule_days, contact_count, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  // Filtered in JS rather than with a Postgrest array-equality query param --
  // simpler and avoids any array-literal encoding edge cases for '{}'.
  const batches = (allBatches || []).filter((b) => (b.followup_schedule_days || []).length > 0)
  if (!batches.length) return NextResponse.json([])

  const templateIds = Array.from(new Set(batches.flatMap((b) => [b.template_id, b.followup_template_id].filter(Boolean))))
  const { data: templates } = templateIds.length
    ? await supabaseAdmin.from('whatsapp_templates').select('id, name').in('id', templateIds)
    : { data: [] as { id: string; name: string }[] }
  const nameById = new Map((templates || []).map((t) => [t.id, t.name]))

  // Reasons that mean the clinic has something to fix (a deleted template, a
  // contact that no longer has a phone, etc.) -- as opposed to the sequence
  // just running its course (replied/booked/opted_out/completed/superseded).
  // See backend/api/campaigns.py send_campaign_followups() for where these get set.
  const ISSUE_REASONS = ['template_deleted', 'contact_invalid', 'batch_deleted', 'tenant_unavailable']

  const withProgress = await Promise.all(batches.map(async (b) => {
    const { count: pending } = await supabaseAdmin
      .from('campaigns')
      .select('id', { count: 'exact', head: true })
      .eq('batch_id', b.id)
      .not('next_followup_at', 'is', null)
    const { count: issues } = await supabaseAdmin
      .from('campaigns')
      .select('id', { count: 'exact', head: true })
      .eq('batch_id', b.id)
      .in('stopped_reason', ISSUE_REASONS)
    return {
      ...b,
      template_name: nameById.get(b.template_id) || null,
      followup_template_name: b.followup_template_id ? (nameById.get(b.followup_template_id) || null) : null,
      pending_followups: pending || 0,
      issue_count: issues || 0,
    }
  }))

  return NextResponse.json(withProgress)
}

// Stops a batch's remaining automatic follow-ups -- clears every
// still-pending row's next_followup_at so the scheduler (send_campaign_followups
// in backend/api/campaigns.py) has nothing left to pick up for it. Already-sent
// messages are untouched.
export async function PATCH(req: NextRequest) {
  const { tenant_id, batch_id } = await req.json() as { tenant_id: string; batch_id: string }
  if (!tenant_id || !batch_id) return NextResponse.json({ error: 'tenant_id and batch_id are required' }, { status: 400 })
  if (!await verifyTenantAccess(tenant_id)) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })

  const { data: batch } = await supabaseAdmin
    .from('campaign_batches').select('id').eq('id', batch_id).eq('tenant_id', tenant_id).maybeSingle()
  if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 })

  const { error } = await supabaseAdmin
    .from('campaigns')
    .update({ next_followup_at: null, stopped_reason: 'manually_stopped' })
    .eq('batch_id', batch_id)
    .eq('tenant_id', tenant_id)
    .not('next_followup_at', 'is', null)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
