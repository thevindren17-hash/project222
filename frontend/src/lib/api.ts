const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL

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
