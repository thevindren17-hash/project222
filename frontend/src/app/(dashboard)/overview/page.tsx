'use client'

import { useQuery } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import StatCard from '@/components/dashboard/stat-card'
import PluginStatusBar from '@/components/dashboard/plugin-status-bar'
import EmptyState from '@/components/dashboard/empty-state'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { AreaChart, Area, XAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'
import Link from 'next/link'
import { format, subDays } from 'date-fns'
import { ClipboardList } from 'lucide-react'

// % change vs. the prior period of the same length — 0 is reported as +100%
// when the prior period was literally zero, since "went from nothing to
// something" is the honest story and div-by-zero would otherwise hide it.
function pctChange(current: number, previous: number): number {
  if (previous > 0) return Math.round(((current - previous) / previous) * 100)
  return current > 0 ? 100 : 0
}

export default function OverviewPage() {
  const { data: metrics } = useQuery({
    queryKey: ['overview-metrics'],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) throw new Error('No tenant found')

      const now = new Date()
      const start14d = subDays(now, 14)
      const start30d = subDays(now, 30)
      const start60d = subDays(now, 60)

      // Counts only (never fetch-all) for anything that grows unboundedly
      // with patient volume -- a busy clinic can have thousands of
      // all-time WhatsApp threads, and PostgREST's default row cap would
      // silently under-count a plain .select() long before that.
      const [bookingsRes, threadsTotalRes, threadsAiRes, feedbackRes, recallRes] = await Promise.all([
        supabase.from('bookings').select('created_at')
          .eq('tenant_id', tenant.id).gte('created_at', start14d.toISOString()),
        supabase.from('whatsapp_threads').select('*', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id),
        supabase.from('whatsapp_threads').select('*', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id).eq('status', 'ai'),
        supabase.from('campaigns').select('rating,status,sent_at')
          .eq('tenant_id', tenant.id).eq('type', 'feedback')
          .gte('sent_at', start60d.toISOString())
          .not('rating', 'is', null),
        supabase.from('campaigns').select('sent_at')
          .eq('tenant_id', tenant.id).eq('type', 'recall')
          .gte('sent_at', start60d.toISOString()),
      ])

      const bookings = bookingsRes.data || []
      const totalThreads = threadsTotalRes.count || 0
      const aiThreads = threadsAiRes.count || 0
      const feedback = feedbackRes.data || []
      const recall = recallRes.data || []

      // 14 daily buckets, oldest first — doubles as the sparkline/trend
      // chart data and as the source for this-week-vs-last-week.
      const dailyBookings = Array.from({ length: 14 }, (_, i) => {
        const day = subDays(now, 13 - i)
        const dayKey = format(day, 'yyyy-MM-dd')
        const count = bookings.filter((b) => format(new Date(b.created_at), 'yyyy-MM-dd') === dayKey).length
        return { date: format(day, 'MMM d'), count }
      })
      const bookingsThisWeek = dailyBookings.slice(7).reduce((s, d) => s + d.count, 0)
      const bookingsPrevWeek = dailyBookings.slice(0, 7).reduce((s, d) => s + d.count, 0)

      const feedbackCurrent = feedback.filter((f) => new Date(f.sent_at) >= start30d)
      const feedbackPrevious = feedback.filter((f) => new Date(f.sent_at) < start30d)
      const recallCurrent = recall.filter((r) => new Date(r.sent_at) >= start30d)
      const recallPrevious = recall.filter((r) => new Date(r.sent_at) < start30d)

      const avgOf = (rows: typeof feedback) =>
        rows.length > 0 ? rows.reduce((s, f) => s + (f.rating || 0), 0) / rows.length : null

      const avgRating = avgOf(feedbackCurrent)
      const avgRatingPrev = avgOf(feedbackPrevious)
      const fiveStarCount = feedbackCurrent.filter((f) => f.rating === 5).length
      const fiveStarCountPrev = feedbackPrevious.filter((f) => f.rating === 5).length
      const reviewsRequested = feedbackCurrent.filter((f) => f.status === 'review_sent').length
      const reviewsRequestedPrev = feedbackPrevious.filter((f) => f.status === 'review_sent').length

      return {
        dailyBookings,
        bookingsThisWeek,
        bookingsChangePct: pctChange(bookingsThisWeek, bookingsPrevWeek),
        aiHandleRate: totalThreads > 0 ? Math.round((aiThreads / totalThreads) * 100) : 0,
        waMessages: totalThreads,
        avgRating: avgRating !== null ? avgRating.toFixed(1) : null,
        avgRatingChangePct: avgRating !== null && avgRatingPrev !== null
          ? pctChange(Math.round(avgRating * 10), Math.round(avgRatingPrev * 10))
          : null,
        fiveStarCount,
        fiveStarChangePct: pctChange(fiveStarCount, fiveStarCountPrev),
        reviewsRequested,
        reviewsRequestedChangePct: pctChange(reviewsRequested, reviewsRequestedPrev),
        recallSent: recallCurrent.length,
        recallChangePct: pctChange(recallCurrent.length, recallPrevious.length),
      }
    },
  })

  const { data: recentBookings } = useQuery({
    queryKey: ['recent-bookings'],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) return []
      const { data } = await supabase
        .from('bookings')
        .select('*, contact:contacts(name,phone)')
        .eq('tenant_id', tenant.id)
        .order('created_at', { ascending: false })
        .limit(5)
      return data || []
    },
  })

  const sparkline = metrics?.dailyBookings.map((d) => d.count)
  const changeStr = (pct: number) => `${pct > 0 ? '+' : ''}${pct}%`

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Overview</h1>
        <p className="text-muted-foreground">Welcome back! Here&apos;s what&apos;s happening.</p>
      </div>

      <PluginStatusBar />

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="Appointments Booked" value={metrics?.bookingsThisWeek ?? '—'} subtitle="This week" icon="calendar"
          tone="primary" sparkline={sparkline}
          change={metrics ? changeStr(metrics.bookingsChangePct) : undefined}
          trend={metrics && metrics.bookingsChangePct >= 0 ? 'up' : 'down'}
          changeLabel="vs last week"
        />
        <StatCard title="WA Threads" value={metrics?.waMessages ?? '—'} subtitle="All time" icon="message" tone="info" />
        <StatCard title="AI Handle Rate" value={`${metrics?.aiHandleRate ?? 0}%`} icon="bot" tone="info" />
        <StatCard
          title="Avg Rating" value={metrics?.avgRating ? `${metrics.avgRating} ⭐` : '—'} subtitle="Last 30 days" icon="star"
          tone="warning"
          change={metrics?.avgRatingChangePct !== null && metrics?.avgRatingChangePct !== undefined ? changeStr(metrics.avgRatingChangePct) : undefined}
          trend={metrics?.avgRatingChangePct !== null && metrics?.avgRatingChangePct !== undefined && metrics.avgRatingChangePct >= 0 ? 'up' : 'down'}
          changeLabel="vs prior 30 days"
        />
        <StatCard
          title="5-Star Reviews" value={metrics?.fiveStarCount ?? '—'} subtitle="Last 30 days" icon="star" tone="success"
          change={metrics ? changeStr(metrics.fiveStarChangePct) : undefined}
          trend={metrics && metrics.fiveStarChangePct >= 0 ? 'up' : 'down'}
          changeLabel="vs prior 30 days"
        />
        <StatCard
          title="Review Requests Sent" value={metrics?.reviewsRequested ?? '—'} subtitle="Last 30 days" icon="message" tone="info"
          change={metrics ? changeStr(metrics.reviewsRequestedChangePct) : undefined}
          trend={metrics && metrics.reviewsRequestedChangePct >= 0 ? 'up' : 'down'}
          changeLabel="vs prior 30 days"
        />
        <StatCard
          title="Recall Messages Sent" value={metrics?.recallSent ?? '—'} subtitle="Last 30 days" icon="star" tone="success"
          change={metrics ? changeStr(metrics.recallChangePct) : undefined}
          trend={metrics && metrics.recallChangePct >= 0 ? 'up' : 'down'}
          changeLabel="vs prior 30 days"
        />
      </div>

      <Card>
        <CardHeader><CardTitle>Bookings — Last 14 Days</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={metrics?.dailyBookings} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
              <defs>
                <linearGradient id="overview-bookings" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" vertical={false} />
              <XAxis dataKey="date" className="text-xs" tickLine={false} axisLine={false} />
              <Tooltip
                cursor={{ stroke: 'var(--color-border)', strokeWidth: 1 }}
                content={({ active, payload, label }) =>
                  active && payload?.length ? (
                    <div className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-sm">
                      <p className="font-medium">{label}</p>
                      <p className="text-muted-foreground">{payload[0].value} booking{payload[0].value === 1 ? '' : 's'}</p>
                    </div>
                  ) : null
                }
              />
              <Area type="monotone" dataKey="count" stroke="var(--color-primary)" strokeWidth={2} fill="url(#overview-bookings)" />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Recent Appointments</span>
              <Link href="/appointments"><Button variant="ghost" size="sm">View all</Button></Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {recentBookings?.length === 0 && (
              <EmptyState
                icon={ClipboardList}
                title="No bookings yet"
                description="New appointments booked through WhatsApp or the calendar will show up here."
                action={{ label: 'Go to calendar', href: '/calendar' }}
              />
            )}
            {recentBookings?.map((b: any) => (
              <div key={b.id} className="flex items-center justify-between text-sm">
                <div>
                  <p className="font-medium">{b.patient_name || b.contact?.name || 'Unknown'}</p>
                  <p className="text-muted-foreground">{b.service_type}</p>
                </div>
                <div className="text-right">
                  <p>{format(new Date(b.scheduled_at), 'MMM d, h:mm a')}</p>
                  <Badge variant={b.status === 'confirmed' ? 'default' : 'secondary'} className="text-xs">
                    {b.status}
                  </Badge>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>WhatsApp Inbox</span>
              <Link href="/whatsapp"><Button variant="ghost" size="sm">View inbox</Button></Link>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {metrics?.waMessages ? `${metrics.waMessages} total threads` : 'No threads yet'}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
