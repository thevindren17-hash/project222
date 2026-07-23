'use client'

import { useQuery } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'
import { subDays, format } from 'date-fns'
import StatCard from '@/components/dashboard/stat-card'

export default function AnalyticsPage() {
  const { data: stats } = useQuery({
    queryKey: ['analytics'],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) return null

      const last30 = subDays(new Date(), 30).toISOString()

      const [bookingsRes, threadsRes, contactsRes] = await Promise.all([
        supabase.from('bookings').select('created_at,status,service_type,scheduled_at')
          .eq('tenant_id', tenant.id).gte('created_at', last30),
        supabase.from('whatsapp_threads').select('status')
          .eq('tenant_id', tenant.id),
        supabase.from('contacts').select('created_at')
          .eq('tenant_id', tenant.id).gte('created_at', last30),
      ])

      const bookings = bookingsRes.data || []
      const threads = threadsRes.data || []
      const contacts = contactsRes.data || []

      // Daily bookings chart (last 7 days)
      const dailyBookings = Array.from({ length: 7 }, (_, i) => {
        const day = subDays(new Date(), 6 - i)
        const dayStr = format(day, 'MMM d')
        const count = bookings.filter((b) =>
          format(new Date(b.created_at), 'MMM d') === dayStr
        ).length
        return { date: dayStr, bookings: count }
      })

      // Service breakdown
      const serviceMap: Record<string, number> = {}
      bookings.forEach((b) => { serviceMap[b.service_type] = (serviceMap[b.service_type] || 0) + 1 })
      const serviceData = Object.entries(serviceMap).map(([name, value]) => ({ name, value }))

      const aiHandleRate = threads.length > 0
        ? Math.round((threads.filter((t) => t.status === 'ai').length / threads.length) * 100)
        : 0

      const completedCount = bookings.filter((b) => b.status === 'completed').length
      const noShowCount = bookings.filter((b) => b.status === 'no_show').length
      const noShowRate = (completedCount + noShowCount) > 0
        ? Math.round((noShowCount / (completedCount + noShowCount)) * 100)
        : 0

      // Lead-capture funnel: inquiry (new contact) → booked → showed
      // (completed). "Showed" uses booked-in-period bookings only, so the
      // conversion % lines up with the "Booked" stage directly above it.
      const inquiries = contacts.length
      const booked = bookings.length
      const showed = bookings.filter((b) => b.status === 'completed').length
      const funnel = [
        { stage: 'Inquiries', count: inquiries, pct: null as number | null },
        { stage: 'Booked', count: booked, pct: inquiries > 0 ? Math.round((booked / inquiries) * 100) : 0 },
        { stage: 'Showed', count: showed, pct: booked > 0 ? Math.round((showed / booked) * 100) : 0 },
      ]

      return { dailyBookings, serviceData, aiHandleRate, totalBookings: bookings.length, noShowRate, funnel }
    },
  })

  const COLORS = ['oklch(0.58 0.22 255)', 'oklch(0.64 0.17 145)', 'oklch(0.78 0.18 75)', 'oklch(0.62 0.22 25)', 'oklch(0.58 0.22 300)']

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Analytics</h1>
        <p className="text-muted-foreground">Last 30 days performance</p>
      </div>

      <div className="grid gap-6 max-w-md grid-cols-2">
        <StatCard title="Total Bookings" value={stats?.totalBookings ?? '—'} icon="calendar" />
        <StatCard title="No-Show Rate" value={stats ? `${stats.noShowRate}%` : '—'} icon="alert" />
      </div>

      <Card>
        <CardHeader><CardTitle>Lead Capture Funnel (Last 30 Days)</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {stats?.funnel.map((step, i) => {
            const maxCount = stats.funnel[0]?.count || 1
            const widthPct = maxCount > 0 ? Math.max((step.count / maxCount) * 100, step.count > 0 ? 4 : 0) : 0
            return (
              <div key={step.stage} className="space-y-1.5">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{step.stage}</span>
                  <span className="text-muted-foreground">
                    {step.count}
                    {step.pct !== null && <span className="ml-2 text-xs">({step.pct}% of {stats.funnel[i - 1]?.stage.toLowerCase()})</span>}
                  </span>
                </div>
                <div className="h-3 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${widthPct}%`, backgroundColor: 'oklch(0.58 0.22 255)' }}
                  />
                </div>
              </div>
            )
          })}
          {stats && stats.funnel[2].count === 0 && stats.funnel[1].count > 0 && (
            <p className="text-xs text-muted-foreground">No completed visits yet — the &quot;Showed&quot; stage fills in once appointments pass and are marked completed.</p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Daily Bookings (Last 7 Days)</CardTitle></CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={stats?.dailyBookings}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" className="text-xs" />
                <YAxis className="text-xs" />
                <Tooltip />
                <Bar dataKey="bookings" fill="oklch(0.58 0.22 255)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Services Breakdown</CardTitle></CardHeader>
          <CardContent>
            {stats?.serviceData && stats.serviceData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={stats.serviceData} cx="50%" cy="50%" outerRadius={80} dataKey="value" label={(entry: { name?: string; percent?: number }) => `${entry.name ?? ''} ${Math.round((entry.percent ?? 0) * 100)}%`}>
                    {stats.serviceData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[220px] flex items-center justify-center text-muted-foreground text-sm">No data yet</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>AI vs Human Handle Rate</CardTitle></CardHeader>
          <CardContent>
            <div className="h-[220px] flex items-center justify-center">
              <div className="text-center">
                <p className="text-6xl font-bold text-primary">{stats?.aiHandleRate ?? 0}%</p>
                <p className="text-muted-foreground mt-2">Handled by AI</p>
                <p className="text-sm text-muted-foreground mt-1">({100 - (stats?.aiHandleRate ?? 0)}% escalated to staff)</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
