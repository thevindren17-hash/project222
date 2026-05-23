'use client'

import { useQuery } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'
import { subDays, format, differenceInSeconds } from 'date-fns'
import StatCard from '@/components/dashboard/stat-card'

export default function AnalyticsPage() {
  const { data: stats } = useQuery({
    queryKey: ['analytics'],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) return null

      const last30 = subDays(new Date(), 30).toISOString()

      const [callsRes, bookingsRes, threadsRes] = await Promise.all([
        supabase.from('call_logs').select('started_at,duration_seconds,auto_escalated,language_detected')
          .eq('tenant_id', tenant.id).gte('started_at', last30),
        supabase.from('bookings').select('created_at,status,service_type')
          .eq('tenant_id', tenant.id).gte('created_at', last30),
        supabase.from('whatsapp_threads').select('status')
          .eq('tenant_id', tenant.id),
      ])

      const calls = callsRes.data || []
      const bookings = bookingsRes.data || []
      const threads = threadsRes.data || []

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

      // Language breakdown for calls
      const langMap: Record<string, number> = {}
      calls.forEach((c) => { langMap[c.language_detected] = (langMap[c.language_detected] || 0) + 1 })
      const langData = Object.entries(langMap).map(([name, value]) => ({ name: name.toUpperCase(), value }))

      const avgDuration = calls.length > 0
        ? Math.round(calls.reduce((s, c) => s + (c.duration_seconds || 0), 0) / calls.length)
        : 0
      const escalationRate = calls.length > 0
        ? Math.round((calls.filter((c) => c.auto_escalated).length / calls.length) * 100)
        : 0
      const aiHandleRate = threads.length > 0
        ? Math.round((threads.filter((t) => t.status === 'ai').length / threads.length) * 100)
        : 0

      return { dailyBookings, serviceData, langData, avgDuration, escalationRate, aiHandleRate, totalCalls: calls.length, totalBookings: bookings.length }
    },
  })

  const { data: voiceStats } = useQuery({
    queryKey: ['voice-analytics'],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) return null

      const last30 = subDays(new Date(), 30).toISOString()
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)

      const { data: sessions } = await supabase
        .from('voice_sessions')
        .select('id, status, started_at, ended_at')
        .eq('tenant_id', tenant.id)
        .gte('started_at', last30)
        .order('started_at', { ascending: false })

      const all = sessions || []
      const ended = all.filter((s) => s.status === 'ended' && s.ended_at)
      const todaySessions = all.filter((s) => new Date(s.started_at) >= todayStart)
      const active = all.filter((s) => s.status === 'active')

      const avgDurationSec = ended.length > 0
        ? Math.round(ended.reduce((sum, s) => sum + differenceInSeconds(new Date(s.ended_at), new Date(s.started_at)), 0) / ended.length)
        : 0

      // Daily voice sessions (last 7 days)
      const dailyVoice = Array.from({ length: 7 }, (_, i) => {
        const day = subDays(new Date(), 6 - i)
        const dayStr = format(day, 'MMM d')
        const count = all.filter((s) => format(new Date(s.started_at), 'MMM d') === dayStr).length
        return { date: dayStr, calls: count }
      })

      return { all, todaySessions, active, avgDurationSec, dailyVoice, total: all.length }
    },
  })

  const COLORS = ['oklch(0.58 0.22 255)', 'oklch(0.64 0.17 145)', 'oklch(0.78 0.18 75)', 'oklch(0.62 0.22 25)', 'oklch(0.58 0.22 300)']

  const fmtDur = (s: number) => s > 0 ? `${Math.floor(s / 60)}m ${s % 60}s` : '—'

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Analytics</h1>
        <p className="text-muted-foreground">Last 30 days performance</p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard title="Total Calls" value={stats?.totalCalls ?? '—'} icon="phone" />
        <StatCard title="Total Bookings" value={stats?.totalBookings ?? '—'} icon="calendar" />
        <StatCard title="Avg Call Duration" value={stats ? `${Math.floor(stats.avgDuration / 60)}m ${stats.avgDuration % 60}s` : '—'} icon="clock" />
        <StatCard title="Escalation Rate" value={`${stats?.escalationRate ?? 0}%`} icon="alert" />
      </div>

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
          <CardHeader><CardTitle>Language Distribution</CardTitle></CardHeader>
          <CardContent>
            {stats?.langData && stats.langData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={stats.langData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis type="number" className="text-xs" />
                  <YAxis dataKey="name" type="category" className="text-xs" />
                  <Tooltip />
                  <Bar dataKey="value" fill="oklch(0.64 0.17 145)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[220px] flex items-center justify-center text-muted-foreground text-sm">No call data yet</div>
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

      {/* ── Voice Sessions ── */}
      <div>
        <h2 className="text-xl font-semibold mb-4">Voice Sessions</h2>
        <div className="grid gap-4 md:grid-cols-4 mb-6">
          <StatCard title="Total Voice Calls" value={voiceStats?.total ?? '—'} subtitle="Last 30 days" icon="phone" />
          <StatCard title="Today's Calls" value={voiceStats?.todaySessions.length ?? '—'} icon="phone" />
          <StatCard title="Active Now" value={voiceStats?.active.length ?? 0} icon="phone" />
          <StatCard title="Avg Duration" value={fmtDur(voiceStats?.avgDurationSec ?? 0)} subtitle="Completed calls" icon="clock" />
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Daily Voice Calls (Last 7 Days)</CardTitle></CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={voiceStats?.dailyVoice}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="date" className="text-xs" />
                  <YAxis className="text-xs" allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="calls" fill="oklch(0.64 0.17 145)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Recent Voice Sessions</CardTitle></CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {!voiceStats?.all.length && (
                  <p className="text-sm text-muted-foreground text-center py-8">No voice sessions yet</p>
                )}
                {voiceStats?.all.slice(0, 6).map((s) => {
                  const dur = s.ended_at
                    ? fmtDur(differenceInSeconds(new Date(s.ended_at), new Date(s.started_at)))
                    : null
                  return (
                    <div key={s.id} className="flex items-center justify-between px-4 py-3 text-sm">
                      <div>
                        <p className="font-mono text-xs text-muted-foreground">{s.id.slice(0, 8)}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {format(new Date(s.started_at), 'MMM d, h:mm a')}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {dur && <span className="text-xs text-muted-foreground">{dur}</span>}
                        <Badge variant={
                          s.status === 'active' ? 'default' :
                          s.status === 'ended' ? 'secondary' : 'outline'
                        } className="text-xs capitalize">
                          {s.status}
                        </Badge>
                      </div>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
