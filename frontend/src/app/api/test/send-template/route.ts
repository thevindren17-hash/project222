import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Best-effort per-tenant limiter (in-memory — resets on cold start / across
// instances, but still blocks the obvious "spam the test button" abuse case).
const _testSendCalls = new Map<string, number[]>()
const _TEST_SEND_WINDOW_MS = 5 * 60_000
const _TEST_SEND_MAX_CALLS = 10

function isTestSendRateLimited(tenantId: string): boolean {
  const now = Date.now()
  const calls = (_testSendCalls.get(tenantId) ?? []).filter((t) => now - t < _TEST_SEND_WINDOW_MS)
  if (calls.length >= _TEST_SEND_MAX_CALLS) {
    _testSendCalls.set(tenantId, calls)
    return true
  }
  calls.push(now)
  _testSendCalls.set(tenantId, calls)
  return false
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

// Mirrors the actual approved Meta template wording — this is what's
// really sent for reminder/feedback, so the display text should match it
// exactly rather than a made-up "TEST" message.
const DEFAULT_REMINDER =
  'Hi {name},\n\nThis is a reminder that you have a {service} appointment on {date} at {time}.\n\nReply CANCEL if you need to reschedule.'

const DEFAULT_FEEDBACK =
  "Hi {name},\n\nThank you for visiting us for your {service}!\n\nWe'd love to hear your feedback — please reply with a number from 1 to 5, where 5 means excellent.\n\nReply STOP to opt out"

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

    if (!await verifyTenantAccess(tenant_id)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }
    if (isTestSendRateLimited(tenant_id)) {
      return NextResponse.json(
        { error: 'Too many test sends in a short time — please wait a few minutes and try again.' },
        { status: 429 }
      )
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

    // Load message templates from settings. reminder/feedback intentionally
    // don't read a custom column here — the real send always uses the fixed,
    // Meta-approved template text (DEFAULT_REMINDER/DEFAULT_FEEDBACK below),
    // so the preview must match that exactly rather than a stale unused
    // column. recall is still genuinely free text, so its column is real.
    const { data: settings } = await supabaseAdmin
      .from('tenant_settings')
      .select('recall_message_template, reminder_template_name, feedback_template_name, whatsapp_template_language')
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
      message = DEFAULT_REMINDER
        .replace('{name}', name)
        .replace('{service}', 'Test Appointment')
        .replace('{date}', formatDate(tomorrow))
        .replace('{time}', formatTime(tomorrow))
    } else if (type === 'feedback') {
      message = DEFAULT_FEEDBACK.replace('{name}', name).replace('{service}', 'Test Appointment')
    } else if (type === 'recall') {
      const tmpl = settings?.recall_message_template || DEFAULT_RECALL
      message = tmpl.replace('{name}', name).replace('{clinic}', tenant.name)
    }

    // Reminder + feedback are always outside the 24h customer service window,
    // so the test send must use the real approved template too — otherwise
    // this button would "succeed" in a way production sends never can.
    // Recall stays on free text until its template is approved.
    const languageCode = settings?.whatsapp_template_language || 'en'
    let waBody: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      to: phone.replace(/^\+/, ''),
      type: 'text',
      text: { body: message },
    }

    if (type === 'reminder' || type === 'feedback') {
      const templateName =
        type === 'reminder'
          ? settings?.reminder_template_name || 'appointment_reminder'
          : settings?.feedback_template_name || 'feedback_request'
      const templateParams =
        type === 'reminder'
          ? [name, 'Test Appointment', formatDate(tomorrow), formatTime(tomorrow)]
          : [name, 'Test Appointment']

      waBody = {
        messaging_product: 'whatsapp',
        to: phone.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          components: [
            {
              type: 'body',
              parameters: templateParams.map((p) => ({ type: 'text', text: String(p) })),
            },
          ],
        },
      }
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
        body: JSON.stringify(waBody),
      }
    )

    if (!waRes.ok) {
      const err = await waRes.text()
      return NextResponse.json({ error: `Meta API error: ${err}` }, { status: 502 })
    }

    // For feedback + recall: create a campaign record so replies are handled by the backend.
    // Reminder is logged too, purely for send-history consistency with the other two.
    if (contactId) {
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
