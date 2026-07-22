const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL || '').trim()

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

// One unified Google connection covers Calendar + Sheets + Drive together —
// a clinic connects once, using their own Google OAuth client (BYOK).
export async function initiateGoogleOAuth(tenantId: string) {
  window.location.href = `/api/integrations/google/auth?tenant_id=${tenantId}`
}

export async function disconnectGoogle(tenantId: string) {
  // Routed through our own Next.js server (not Railway directly) so the
  // caller's session/tenant ownership gets verified before disconnecting.
  const res = await fetch(`/api/integrations/google/disconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_id: tenantId }),
  })
  if (!res.ok) throw new Error('Disconnect failed')
  return res.json()
}
