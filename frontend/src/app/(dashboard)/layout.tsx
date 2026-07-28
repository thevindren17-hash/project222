import { redirect } from 'next/navigation'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import DashboardShell from '@/components/dashboard/dashboard-shell'
import { Toaster } from 'sonner'
import QueryProvider from '@/components/providers/query-provider'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll() {}, // token refresh is handled by middleware
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <QueryProvider>
      <div className="h-screen overflow-hidden bg-background p-0 md:p-3">
        <DashboardShell>{children}</DashboardShell>
      </div>
      <Toaster position="top-right" />
    </QueryProvider>
  )
}
