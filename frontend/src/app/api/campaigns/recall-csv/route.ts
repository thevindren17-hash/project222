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

function normalizePhone(raw: string): string | null {
  // Keep digits and a leading +
  const digits = raw.replace(/[^\d+]/g, '').trim()
  // Strip the + for length check
  const justDigits = digits.replace(/^\+/, '')
  if (justDigits.length < 8) return null
  // Ensure it starts with + so Meta API receives an international number
  return digits.startsWith('+') ? digits : `+${digits}`
}

async function sendOneRecall(params: {
  tenant_id: string
  contact: { name: string; phone: string }
  phone_number_id: string
  access_token: string
  clinic_name: string
  message_template: string
  interval_months: number
}): Promise<'sent' | 'skipped' | 'failed'> {
  const { tenant_id, contact, phone_number_id, access_token, clinic_name, message_template, interval_months } = params

  const phone = normalizePhone(contact.phone)
  if (!phone) return 'failed'

  const name = (contact.name || '').trim() || 'there'
  const message = message_template.replace('{name}', name).replace('{clinic}', clinic_name)

  try {
    // Upsert contact — unique on (tenant_id, phone)
    const { data: contactRow, error: upsertErr } = await supabaseAdmin
      .from('contacts')
      .upsert(
        { tenant_id, phone, name, source: 'csv_import' },
        { onConflict: 'tenant_id,phone' }
      )
      .select('id, opted_out')
      .single()

    if (upsertErr || !contactRow) return 'failed'
    if (contactRow.opted_out) return 'skipped'

    const contact_id = contactRow.id

    // Deduplicate: skip if already recalled within the window
    const cutoff = new Date(Date.now() - interval_months * 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: existing } = await supabaseAdmin
      .from('campaigns')
      .select('id')
      .eq('tenant_id', tenant_id)
      .eq('contact_id', contact_id)
      .eq('type', 'recall')
      .gte('sent_at', cutoff)
      .limit(1)
      .maybeSingle()

    if (existing) return 'skipped'

    // Send via Meta API
    const waRes = await fetch(
      `https://graph.facebook.com/v21.0/${phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone.replace(/^\+/, ''),
          type: 'text',
          text: { body: message },
        }),
      }
    )

    if (!waRes.ok) {
      const errBody = await waRes.text()
      console.error(`WA send failed for ${phone}: ${errBody}`)
      return 'failed'
    }

    // Record campaign
    await supabaseAdmin.from('campaigns').insert({
      tenant_id,
      contact_id,
      type: 'recall',
      status: 'sent',
      sent_at: new Date().toISOString(),
    })

    // Save to thread if one exists
    const { data: thread } = await supabaseAdmin
      .from('whatsapp_threads')
      .select('id')
      .eq('tenant_id', tenant_id)
      .eq('contact_number', phone)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (thread) {
      await supabaseAdmin.from('messages').insert({
        thread_id: thread.id,
        tenant_id,
        contact_id,
        role: 'assistant',
        body: message,
        handled_by: 'ai',
      })
      await supabaseAdmin
        .from('whatsapp_threads')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', thread.id)
    }

    return 'sent'
  } catch {
    return 'failed'
  }
}

export async function POST(req: NextRequest) {
  try {
    const { tenant_id, contacts, message_template, interval_months } = await req.json() as {
      tenant_id: string
      contacts: { name: string; phone: string }[]
      message_template?: string
      interval_months?: number
    }

    if (!tenant_id || !Array.isArray(contacts) || contacts.length === 0) {
      return NextResponse.json({ error: 'tenant_id and contacts are required' }, { status: 400 })
    }

    if (!await verifyTenantAccess(tenant_id)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }
    if (contacts.length > 500) {
      return NextResponse.json({ error: 'Maximum 500 contacts per upload' }, { status: 400 })
    }

    // Load tenant credentials
    const { data: tenant } = await supabaseAdmin
      .from('tenants')
      .select('name, wa_phone_number_id, wa_access_token')
      .eq('id', tenant_id)
      .eq('is_active', true)
      .maybeSingle()

    if (!tenant?.wa_phone_number_id || !tenant?.wa_access_token) {
      return NextResponse.json({ error: 'WhatsApp credentials not configured' }, { status: 400 })
    }

    const defaultMsg =
      "Hi {name}! 👋 It's been a while since your last visit at {clinic}. " +
      "We'd love to see you again! Just reply to book your next appointment. 😊"

    const results = { sent: 0, skipped: 0, failed: 0 }

    // Send in chunks of 5 to stay within rate limits without timing out
    const CHUNK = 5
    for (let i = 0; i < contacts.length; i += CHUNK) {
      const chunk = contacts.slice(i, i + CHUNK)
      const chunkResults = await Promise.allSettled(
        chunk.map((c) =>
          sendOneRecall({
            tenant_id,
            contact: c,
            phone_number_id: tenant.wa_phone_number_id!,
            access_token: tenant.wa_access_token!,
            clinic_name: tenant.name,
            message_template: message_template || defaultMsg,
            interval_months: interval_months || 6,
          })
        )
      )
      for (const r of chunkResults) {
        const outcome = r.status === 'fulfilled' ? r.value : 'failed'
        results[outcome]++
      }
    }

    return NextResponse.json(results)
  } catch (e) {
    console.error('recall-csv error:', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
