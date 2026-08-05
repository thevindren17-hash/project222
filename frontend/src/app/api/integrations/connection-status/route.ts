import { NextRequest, NextResponse } from 'next/server'
import { verifyTenantAccess, supabaseAdmin } from '@/lib/server/verify-tenant-access'

// Whether Google and the AI provider are connected — as booleans only.
// Several client components previously queried tenant_settings directly
// for this (selecting google_access_token/google_refresh_token/
// provider_credentials just to compute a true/false badge), which put
// plaintext Google tokens and BYOK provider keys into browser memory and
// devtools for no reason. This route does the same lookup server-side and
// returns only the flags.
export async function GET(req: NextRequest) {
  const tenantId = new URL(req.url).searchParams.get('tenant_id')
  if (!tenantId || !(await verifyTenantAccess(tenantId))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const { data: settings } = await supabaseAdmin
    .from('tenant_settings')
    .select('llm_config,google_access_token,google_refresh_token,provider_credentials')
    .eq('tenant_id', tenantId)
    .maybeSingle()

  const llmProvider = settings?.llm_config?.provider
  const providerCreds = settings?.provider_credentials as Record<string, Record<string, string>> | undefined

  return NextResponse.json({
    google: !!(settings?.google_access_token || settings?.google_refresh_token),
    agent: !!(llmProvider && providerCreds?.[llmProvider]?.api_key),
  })
}
