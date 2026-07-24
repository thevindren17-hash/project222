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

    // reminder/feedback resolve to a specific clinic-created, Meta-approved
    // whatsapp_templates row (same one the real scheduled job uses) rather
    // than a fixed hardcoded string — so this test button behaves exactly
    // like production instead of silently drifting from it.
    const { data: settings } = await supabaseAdmin
      .from('tenant_settings')
      .select('recall_message_template, reminder_whatsapp_template_id, feedback_whatsapp_template_id')
      .eq('tenant_id', tenant_id)
      .maybeSingle()

    let approvedTemplate: { name: string; language: string; variables: string[]; header_media_id: string | null } | null = null
    if (type === 'reminder' || type === 'feedback') {
      const templateId = type === 'reminder' ? settings?.reminder_whatsapp_template_id : settings?.feedback_whatsapp_template_id
      if (templateId) {
        const { data: tpl } = await supabaseAdmin
          .from('whatsapp_templates')
          .select('name, language, variables, header_media_id, status')
          .eq('id', templateId)
          .maybeSingle()
        if (tpl && tpl.status === 'approved') approvedTemplate = tpl
      }
      if (!approvedTemplate) {
        return NextResponse.json(
          { error: `No approved ${type} template linked yet — set one up on the Message Templates page first.` },
          { status: 400 }
        )
      }
    }

    // Upsert test contact
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .upsert({ tenant_id, phone }, { onConflict: 'tenant_id,phone' })
      .select('id, name')
      .single()

    const name = contact?.name?.trim() || 'there'
    const contactId = contact?.id

    // Build the message
    let message = ''
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const availableValues: Record<string, string> = {
      name, service: 'Test Appointment', date: formatDate(tomorrow), time: formatTime(tomorrow), clinic: tenant.name,
    }

    if (type === 'recall') {
      const tmpl = settings?.recall_message_template || DEFAULT_RECALL
      message = tmpl.replace('{name}', name).replace('{clinic}', tenant.name)
    } else if (approvedTemplate) {
      message = approvedTemplate.variables.map((v) => availableValues[v] || `{${v}}`).join(' / ')
    }

    // Reminder + feedback are always outside the 24h customer service window,
    // so the test send must use the real approved template too — otherwise
    // this button would "succeed" in a way production sends never can.
    // Recall stays on free text until its template is approved.
    let waBody: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      to: phone.replace(/^\+/, ''),
      type: 'text',
      text: { body: message },
    }

    if (approvedTemplate) {
      const templateParams = approvedTemplate.variables.map((v) => availableValues[v] || '')
      waBody = {
        messaging_product: 'whatsapp',
        to: phone.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: approvedTemplate.name,
          language: { code: approvedTemplate.language || 'en' },
          components: [
            ...(approvedTemplate.header_media_id
              ? [{ type: 'header', parameters: [{ type: 'image', image: { id: approvedTemplate.header_media_id } }] }]
              : []),
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
