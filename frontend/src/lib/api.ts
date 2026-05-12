const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL

export interface GoogleCalendarEvent {
  id: string
  summary?: string
  start?: { dateTime?: string; date?: string }
  end?:   { dateTime?: string; date?: string }
  colorId?: string
}

export async function fetchGoogleCalendarEvents(tenantId: string): Promise<GoogleCalendarEvent[]> {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()
  const end   = new Date(now.getFullYear(), now.getMonth() + 3, 0).toISOString()
  try {
    const res = await fetch(
      `${BACKEND_URL}/api/integrations/google/events?tenant_id=${tenantId}&time_min=${encodeURIComponent(start)}&time_max=${encodeURIComponent(end)}`
    )
    if (!res.ok) return []
    const json = await res.json()
    return (json.items ?? json) as GoogleCalendarEvent[]
  } catch {
    return []
  }
}

export async function testWhatsAppConnection(tenantId: string) {
  const res = await fetch(`${BACKEND_URL}/api/whatsapp/test/${tenantId}`, { method: 'POST' })
  if (!res.ok) throw new Error('Test failed')
  return res.json()
}

export async function initiateGoogleCalendarOAuth(tenantId: string) {
  window.location.href = `${BACKEND_URL}/api/integrations/google/auth?tenant_id=${tenantId}&service=calendar`
}

export async function disconnectGoogleCalendar(tenantId: string) {
  const res = await fetch(`${BACKEND_URL}/api/integrations/google/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_id: tenantId, service: 'calendar' }),
  })
  if (!res.ok) throw new Error('Disconnect failed')
  return res.json()
}
