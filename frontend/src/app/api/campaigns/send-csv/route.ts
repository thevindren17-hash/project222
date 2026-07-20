import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

type CampaignType = 'reminder' | 'feedback' | 'recall'

// How far back to look for an existing campaign before treating a contact as
// "already contacted" and skipping them. Recall uses the clinic's own
// configured interval_months instead of a fixed window.
const DEDUP_HOURS: Record<Exclude<CampaignType, 'recall'>, number> = {
  reminder: 6,
  feedback: 24,
}

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
  const digits = raw.replace(/[^\d+]/g, '').trim()
  const justDigits = digits.replace(/^\+/, '')
  if (justDigits.length < 8) return null
  return digits.startsWith('+') ? digits : `+${digits}`
}

function buildMessage(template: string, fields: Record<string, string>): string {
  let message = template
  for (const [key, value] of Object.entries(fields)) {
    if (value) message = message.replaceAll(`{${key}}`, value)
  }
  return message
}

type SendOutcome = { status: 'sent' | 'skipped' | 'failed'; reason?: string }

async function sendOneCampaignMessage(params: {
  tenant_id: string
  type: CampaignType
  contact: { name: string; phone: string; service?: string; date?: string; time?: string }
  phone_number_id: string
  access_token: string
  clinic_name: string
  message_template: string
  interval_months: number
}): Promise<SendOutcome> {
  const { tenant_id, type, contact, phone_number_id, access_token, clinic_name, message_template, interval_months } = params

  const phone = normalizePhone(contact.phone)
  if (!phone) return { status: 'failed', reason: `Invalid phone number: "${contact.phone}"` }

  const name = (contact.name || '').trim() || 'there'
  const message = buildMessage(message_template, {
    name,
    clinic: clinic_name,
    service: contact.service || '',
    date: contact.date || '',
    time: contact.time || '',
  })

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

    if (upsertErr || !contactRow) return { status: 'failed', reason: upsertErr?.message || 'Could not save contact record' }
    if (contactRow.opted_out) return { status: 'skipped', reason: 'This contact has opted out of messages' }

    const contact_id = contactRow.id

    // Deduplicate: skip if already contacted for this campaign type within the window
    const dedupHours = type === 'recall' ? interval_months * 30 * 24 : DEDUP_HOURS[type]
    const cutoff = new Date(Date.now() - dedupHours * 60 * 60 * 1000).toISOString()
    const { data: existing } = await supabaseAdmin
      .from('campaigns')
      .select('id')
      .eq('tenant_id', tenant_id)
      .eq('contact_id', contact_id)
      .eq('type', type)
      .gte('sent_at', cutoff)
      .limit(1)
      .maybeSingle()

    if (existing) return { status: 'skipped', reason: 'Already sent to this contact recently' }

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
      let reason = `Meta API error (${waRes.status})`
      try {
        const parsed = JSON.parse(errBody)
        if (parsed?.error?.message) reason = parsed.error.message
      } catch {}
      return { status: 'failed', reason }
    }

    // Record campaign — feedback campaigns created here also feed the
    // existing reply-handling flow in backend/api/campaigns.py, which keys
    // off (tenant_id, contact_id, type='feedback', status='sent').
    await supabaseAdmin.from('campaigns').insert({
      tenant_id,
      contact_id,
      type,
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

    return { status: 'sent' }
  } catch (e) {
    return { status: 'failed', reason: e instanceof Error ? e.message : 'Unknown error' }
  }
}

const DEFAULT_TEMPLATES: Record<CampaignType, string> = {
  reminder:
    'Hi {name}, this is a reminder that your {service} appointment is coming up. Reply CANCEL if you need to cancel.',
  feedback:
    'Hi {name}! 😊 Thank you for visiting us for your {service}. How was your experience? Please reply with a number 1–5.',
  recall:
    "Hi {name}! 👋 It's been a while since your last visit at {clinic}. We'd love to see you again! Just reply to book your next appointment. 😊",
}

export async function POST(req: NextRequest) {
  try {
    const { tenant_id, type, contacts, message_template, interval_months } = await req.json() as {
      tenant_id: string
      type: CampaignType
      contacts: { name: string; phone: string; service?: string; date?: string; time?: string }[]
      message_template?: string
      interval_months?: number
    }

    if (!tenant_id || !type || !Array.isArray(contacts) || contacts.length === 0) {
      return NextResponse.json({ error: 'tenant_id, type, and contacts are required' }, { status: 400 })
    }
    if (!['reminder', 'feedback', 'recall'].includes(type)) {
      return NextResponse.json({ error: 'Invalid campaign type' }, { status: 400 })
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

    const results = { sent: 0, skipped: 0, failed: 0 }
    const errors: string[] = []

    // Send in chunks of 5 to stay within rate limits without timing out
    const CHUNK = 5
    for (let i = 0; i < contacts.length; i += CHUNK) {
      const chunk = contacts.slice(i, i + CHUNK)
      const chunkResults = await Promise.allSettled(
        chunk.map((c) =>
          sendOneCampaignMessage({
            tenant_id,
            type,
            contact: c,
            phone_number_id: tenant.wa_phone_number_id!,
            access_token: tenant.wa_access_token!,
            clinic_name: tenant.name,
            message_template: message_template || DEFAULT_TEMPLATES[type],
            interval_months: interval_months || 6,
          })
        )
      )
      for (const r of chunkResults) {
        const outcome = r.status === 'fulfilled' ? r.value : { status: 'failed' as const, reason: r.reason?.message }
        results[outcome.status]++
        if (outcome.reason && (outcome.status === 'failed' || outcome.status === 'skipped')) {
          errors.push(outcome.reason)
        }
      }
    }

    return NextResponse.json({ ...results, errors })
  } catch (e) {
    console.error('send-csv error:', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
