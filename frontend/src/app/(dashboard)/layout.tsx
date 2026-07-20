import { redirect } from 'next/navigation'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import Sidebar from '@/components/dashboard/sidebar'
import Navbar from '@/components/dashboard/navbar'
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
      <div className="h-screen overflow-hidden bg-background p-3">
        <div className="h-full flex overflow-hidden rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.06)]">
          <Sidebar />
          <div className="flex-1 flex flex-col overflow-hidden">
            <Navbar />
            <main className="flex-1 overflow-y-auto p-6 bg-card">{children}</main>
          </div>
        </div>
      </div>
      <Toaster position="top-right" />
    </QueryProvider>
  )
}
