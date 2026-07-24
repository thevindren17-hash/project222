import { NextRequest, NextResponse } from 'next/server'
import { verifyTenantAccess, supabaseAdmin } from '@/lib/server/verify-tenant-access'

// Saves WhatsApp connection credentials server-side (instead of a direct
// client-side table update) specifically so the access token can be
// encrypted before it ever touches the database -- the browser never sees
// CREDENTIAL_ENCRYPTION_KEY, so encryption can only happen here.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { tenant_id, phone_number, phone_number_id, business_account_id, access_token } = body
    if (!tenant_id || !(await verifyTenantAccess(tenant_id))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
    }
    if (!phone_number_id || !business_account_id || !access_token) {
      return NextResponse.json(
        { error: 'phone_number_id, business_account_id, and access_token are required' },
        { status: 400 }
      )
    }

    const derivedToken = `wa_${String(tenant_id).replace(/-/g, '').slice(0, 16)}`

    // Encrypt at rest using the same generic pgcrypto RPC functions BYOK
    // LLM provider keys already use (migrations/005_encrypt_credentials.sql,
    // see /api/credentials) -- no new migration needed, wa_access_token is
    // already a plain TEXT column, this just changes what value goes into
    // it. Falls back to plaintext only if no encryption key is configured
    // yet, so saves never hard-fail mid-rollout. Existing clinics' already-
    // stored plaintext tokens keep working (shared/tenant_config.py only
    // decrypts values with the "enc:v1:" prefix) and get upgraded to
    // encrypted automatically the next time they reconnect/update here.
    const encKey = process.env.CREDENTIAL_ENCRYPTION_KEY || ''
    let storedToken: string = access_token
    if (encKey) {
      const { data: ciphertext, error: encErr } = await supabaseAdmin.rpc('encrypt_credential', {
        plaintext: access_token,
        key: encKey,
      })
      if (encErr || !ciphertext) {
        return NextResponse.json({ error: 'Failed to encrypt access token' }, { status: 500 })
      }
      storedToken = `enc:v1:${ciphertext}`
    }

    const { error } = await supabaseAdmin.from('tenants').update({
      wa_phone_number: phone_number || null,
      wa_phone_number_id: phone_number_id,
      wa_business_account_id: business_account_id,
      wa_access_token: storedToken,
      wa_verify_token: derivedToken,
    }).eq('id', tenant_id)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
