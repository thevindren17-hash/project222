import { NextResponse } from 'next/server'
import { supabaseAdmin, verifyTenantAccess } from '@/lib/server/verify-tenant-access'

export async function POST(req: Request) {
  try {
    const { threadId, tenantId, message, contactId } = await req.json()
    if (!threadId || !tenantId || !message?.trim()) {
      return NextResponse.json({ error: 'threadId, tenantId, and message are required' }, { status: 400 })
    }

    if (!(await verifyTenantAccess(tenantId))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }

    // Load thread to get recipient number — must belong to this tenant
    const { data: thread, error: threadErr } = await supabaseAdmin
      .from('whatsapp_threads')
      .select('contact_number')
      .eq('id', threadId)
      .eq('tenant_id', tenantId)
      .single()
    if (threadErr || !thread) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 })
    }

    // Load tenant WA credentials
    const { data: tenant, error: tenantErr } = await supabaseAdmin
      .from('tenants')
      .select('wa_phone_number_id, wa_access_token')
      .eq('id', tenantId)
      .single()
    if (tenantErr || !tenant?.wa_phone_number_id || !tenant?.wa_access_token) {
      return NextResponse.json({ error: 'WhatsApp credentials not configured' }, { status: 400 })
    }

    // Send via Meta API
    const to = thread.contact_number.replace(/^\+/, '') // digits only
    const metaRes = await fetch(
      `https://graph.facebook.com/v21.0/${tenant.wa_phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenant.wa_access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: message.trim() },
        }),
      }
    )

    if (!metaRes.ok) {
      const errBody = await metaRes.text()
      return NextResponse.json({ error: `Meta API error: ${errBody}` }, { status: 502 })
    }

    // Save message to DB after successful send
    const { error: insertErr } = await supabaseAdmin.from('messages').insert({
      thread_id: threadId,
      tenant_id: tenantId,
      contact_id: contactId ?? null,
      role: 'assistant',
      handled_by: 'staff',
      body: message.trim(),
    })
    if (insertErr) throw insertErr

    // Keep thread last_message_at fresh
    await supabaseAdmin
      .from('whatsapp_threads')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', threadId)

    return NextResponse.json({ success: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
