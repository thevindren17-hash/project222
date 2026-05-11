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

  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('owner_id', user.id)
    .single()

  if (error) throw error
  return data
}
