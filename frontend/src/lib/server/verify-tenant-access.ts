import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Service-role Supabase client — bypasses RLS entirely. Only ever use this
 * AFTER verifyTenantAccess() has confirmed the caller belongs to the tenant.
 */
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/** True if the currently logged-in user (via session cookie) owns or is staff on tenantId. */
export async function verifyTenantAccess(tenantId: string): Promise<boolean> {
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

/**
 * Header to attach when the Next.js server calls the FastAPI backend directly,
 * so the backend can tell the request came from our own trusted server (which
 * already ran verifyTenantAccess) rather than an arbitrary internet caller.
 */
export function internalSecretHeader(): Record<string, string> {
  const secret = process.env.INTERNAL_API_SECRET || ''
  return secret ? { 'X-Internal-Secret': secret } : {}
}
