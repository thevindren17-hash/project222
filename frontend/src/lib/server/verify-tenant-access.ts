import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import crypto from 'crypto'

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

/**
 * Stamps a short-lived, tenant-bound proof that verifyTenantAccess already
 * passed for tenantId — for flows (Google OAuth) that redirect the browser
 * through a third party and land back on a backend endpoint with nothing
 * but a URL, so the backend can't otherwise tell a legitimate request from
 * anyone who just knows/guesses a tenant_id. Mirrored in
 * backend/shared/security.py (sign_tenant_action / verify_tenant_action)
 * using the same INTERNAL_API_SECRET.
 */
export function signTenantAction(tenantId: string, ttlSeconds = 300): { exp: number; sig: string } {
  const secret = process.env.INTERNAL_API_SECRET || ''
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const sig = crypto.createHmac('sha256', secret).update(`${tenantId}:${exp}`).digest('hex')
  return { exp, sig }
}

const _ENC_PREFIX = 'enc:v1:'

/**
 * Decrypts a credential column written by /api/whatsapp/save-credentials or
 * /api/credentials (both prefix ciphertext with "enc:v1:" -- see
 * backend/migrations/005_encrypt_credentials.sql for the pgcrypto RPCs).
 * Any route that reads wa_access_token (or another encrypted column)
 * straight off the tenants/tenant_settings row to actually call an outside
 * API (Meta, etc.) MUST decrypt it first with this -- using the raw column
 * value directly sends ciphertext as the bearer token and gets a 401 from
 * Meta for every tenant whose token was saved after encryption was turned
 * on. Values with no prefix are legacy plaintext and pass through
 * unchanged, same fallback behavior as the Python-side _decrypt_value.
 */
export async function decryptCredential(value: string | null | undefined): Promise<string | null> {
  if (!value) return value ?? null
  if (!value.startsWith(_ENC_PREFIX)) return value
  const encKey = process.env.CREDENTIAL_ENCRYPTION_KEY || ''
  if (!encKey) return value
  const ciphertext = value.slice(_ENC_PREFIX.length)
  const { data, error } = await supabaseAdmin.rpc('decrypt_credential', { ciphertext, key: encKey })
  if (error) {
    console.error('Failed to decrypt credential:', error.message)
    return null
  }
  return data as string
}
