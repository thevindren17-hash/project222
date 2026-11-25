import { createBrowserClient } from '@supabase/ssr'
import type { Tenant } from '@/lib/types'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey)

export type AccessibleTenant = Tenant & { role: string }

export async function getCurrentUser() {
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error) throw error
  return user
}

/**
 * Every clinic this login can get into — the ones it owns, plus any it was
 * added to as staff. A login can own/staff more than one (an agency managing
 * several clinics), so this is always the list to show in a workspace
 * switcher; getCurrentTenant() just picks one of these.
 */
export async function getAccessibleTenants(): Promise<AccessibleTenant[]> {
  const user = await getCurrentUser()
  if (!user) return []

  const [ownedRes, staffRowsRes] = await Promise.all([
    supabase.from('tenants').select('*').eq('owner_id', user.id),
    supabase.from('staff_profiles').select('tenant_id, role').eq('user_id', user.id),
  ])
  if (ownedRes.error) throw ownedRes.error
  if (staffRowsRes.error) throw staffRowsRes.error

  const tenants: AccessibleTenant[] = (ownedRes.data || []).map((t) => ({ ...t, role: 'owner' }))

  const staffRows = staffRowsRes.data || []
  if (staffRows.length > 0) {
    const { data: staffTenants, error: staffTenantsError } = await supabase
      .from('tenants')
      .select('*')
      .in('id', staffRows.map((r) => r.tenant_id))
    if (staffTenantsError) throw staffTenantsError

    const roleByTenantId = new Map(staffRows.map((r) => [r.tenant_id, r.role as string]))
    for (const t of staffTenants || []) {
      tenants.push({ ...t, role: roleByTenantId.get(t.id) || 'staff' })
    }
  }

  return tenants
}

const ACTIVE_TENANT_KEY = 'activeTenantId'

function getStoredActiveTenantId(): string | null {
  try { return localStorage.getItem(ACTIVE_TENANT_KEY) } catch { return null }
}

/** Remembers which clinic the workspace switcher should land on next. */
export function setActiveTenant(tenantId: string) {
  try { localStorage.setItem(ACTIVE_TENANT_KEY, tenantId) } catch {}
}

export async function getCurrentTenant(): Promise<AccessibleTenant | null> {
  const tenants = await getAccessibleTenants()
  if (tenants.length === 0) return null

  const activeId = getStoredActiveTenantId()
  const active = activeId ? tenants.find((t) => t.id === activeId) : undefined
  return active || tenants[0]
}

export async function isOwner(): Promise<boolean> {
  const tenant = await getCurrentTenant()
  return tenant?.role === 'owner'
}
