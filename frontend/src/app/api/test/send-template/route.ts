import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const DEFAULT_REMINDER =
  'Hi {name}, this is a TEST reminder that your {service} appointment is tomorrow, ' +
  '{date} at {time}. (This is a test message from your AI Receptionist dashboard.)'

const DEFAULT_FEEDBACK =
  'Hi {name}! 😊 This is a TEST feedback request.\n\n' +
  'How was your experience? Please reply with a number:\n' +
  '1 ⭐ – Poor\n2 ⭐⭐ – Fair\n3 ⭐⭐⭐ – Good\n' +
  '4 ⭐⭐⭐⭐ – Great\n5 ⭐⭐⭐⭐⭐ – Excellent\n\n' +
  '(Reply with 4 or 5 to test the Google review link. Reply 1–3 to test the escalation.)'

const DEFAULT_RECALL =
  'Hi {name}! 👋 This is a TEST recall message from {clinic}.\n\n' +
  "We'd love to see you again! Just reply to book your next appointment. 😊\n\n" +
  '(This is a test message from your AI Receptionist dashboard.)'

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '')
  const justDigits = digits.replace(/^\+/, '')
  if (justDigits.length < 8) return null
  return digits.startsWith('+') ? digits : `+${digits}`
}

function formatDate(d: Date) {
  return d.toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' })
}
function formatTime(d: Date) {
  return d.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', hour12: true })
}

export async function POST(req: NextRequest) {
  try {
    const { tenant_id, phone: rawPhone, type } = await req.json() as {
      tenant_id: string
      phone: string
      type: 'reminder' | 'feedback' | 'recall'
    }

    if (!tenant_id || !rawPhone || !type) {
      return NextResponse.json({ error: 'tenant_id, phone, and type are required' }, { status: 400 })
    }

    const phone = normalizePhone(rawPhone)
    if (!phone) {
      return NextResponse.json({ error: 'Invalid phone number — must be at least 8 digits' }, { status: 400 })
    }

    // Load tenant WA credentials + name
    const { data: tenant } = await supabaseAdmin
      .from('tenants')
      .select('name, wa_phone_number_id, wa_access_token')
      .eq('id', tenant_id)
      .eq('is_active', true)
      .maybeSingle()

    if (!tenant?.wa_phone_number_id || !tenant?.wa_access_token) {
      return NextResponse.json({ error: 'WhatsApp credentials not configured on this tenant' }, { status: 400 })
    }

    // Load message templates from settings
    const { data: settings } = await supabaseAdmin
      .from('tenant_settings')
      .select('feedback_message_template, recall_message_template, reminder_1d_template')
      .eq('tenant_id', tenant_id)
      .maybeSingle()

    // Upsert test contact
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .upsert({ tenant_id, phone, source: 'test' }, { onConflict: 'tenant_id,phone' })
      .select('id, name')
      .single()

    const name = contact?.name?.trim() || 'there'
    const contactId = contact?.id

    // Build the message
    let message = ''
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)

    if (type === 'reminder') {
      const tmpl = settings?.reminder_1d_template || DEFAULT_REMINDER
      message = tmpl
        .replace('{name}', name)
        .replace('{service}', 'Test Appointment')
        .replace('{date}', formatDate(tomorrow))
        .replace('{time}', formatTime(tomorrow))
    } else if (type === 'feedback') {
      const tmpl = settings?.feedback_message_template || DEFAULT_FEEDBACK
      message = tmpl.replace('{name}', name).replace('{service}', 'Test Appointment')
    } else if (type === 'recall') {
      const tmpl = settings?.recall_message_template || DEFAULT_RECALL
      message = tmpl.replace('{name}', name).replace('{clinic}', tenant.name)
    }

    // Send via Meta API
    const waRes = await fetch(
      `https://graph.facebook.com/v21.0/${tenant.wa_phone_number_id}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenant.wa_access_token}`,
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
      const err = await waRes.text()
      return NextResponse.json({ error: `Meta API error: ${err}` }, { status: 502 })
    }

    // For feedback + recall: create a campaign record so replies are handled by the backend
    if (contactId && (type === 'feedback' || type === 'recall')) {
      await supabaseAdmin.from('campaigns').insert({
        tenant_id,
        contact_id: contactId,
        type,
        status: 'sent',
        sent_at: new Date().toISOString(),
      })
    }

    return NextResponse.json({ sent: true, to: phone, message })
  } catch (e) {
    console.error('send-template error:', e)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
