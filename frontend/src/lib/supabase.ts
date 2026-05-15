import { createBrowserClient } from '@supabase/ssr'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey)

export async function getCurrentUser() {
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error) throw error
  return user
}

export async function getCurrentTenant() {
  const user = await getCurrentUser()
  if (!user) return null

  // Owner path
  const { data: owned, error: ownerError } = await supabase
    .from('tenants')
    .select('*')
    .eq('owner_id', user.id)
    .maybeSingle()

  if (ownerError) throw ownerError
  if (owned) return { ...owned, role: 'owner' as const }

  // Staff path — look up which tenant this user belongs to
  const { data: profile, error: profileError } = await supabase
    .from('staff_profiles')
    .select('tenant_id, role')
    .eq('user_id', user.id)
    .maybeSingle()

  if (profileError) throw profileError
  if (!profile) return null

  const { data: tenant, error: tenantError } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', profile.tenant_id)
    .maybeSingle()

  if (tenantError) throw tenantError
  return tenant ? { ...tenant, role: profile.role as string } : null
}

export async function isOwner(): Promise<boolean> {
  const tenant = await getCurrentTenant()
  return tenant?.role === 'owner'
}
