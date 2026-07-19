'use client'

import { useQuery } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import StatCard from '@/components/dashboard/stat-card'
import PluginStatusBar from '@/components/dashboard/plugin-status-bar'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import Link from 'next/link'
import { format } from 'date-fns'

export default function OverviewPage() {
  const { data: metrics } = useQuery({
    queryKey: ['overview-metrics'],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) throw new Error('No tenant found')

      const startOfWeek = new Date()
      startOfWeek.setDate(startOfWeek.getDate() - 7)

      const start30d = new Date()
      start30d.setDate(start30d.getDate() - 30)

      const [bookingsRes, threadsRes, feedbackRes, recallRes] = await Promise.all([
        supabase.from('bookings').select('*', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id).gte('created_at', startOfWeek.toISOString()),
        supabase.from('whatsapp_threads').select('status')
          .eq('tenant_id', tenant.id),
        supabase.from('campaigns').select('rating,status')
          .eq('tenant_id', tenant.id).eq('type', 'feedback')
          .gte('sent_at', start30d.toISOString())
          .not('rating', 'is', null),
        supabase.from('campaigns').select('*', { count: 'exact', head: true })
          .eq('tenant_id', tenant.id).eq('type', 'recall')
          .gte('sent_at', start30d.toISOString()),
      ])

      const threads = threadsRes.data || []
      const feedback = feedbackRes.data || []
      const aiThreads = threads.filter((t) => t.status === 'ai').length
      const avgRating = feedback.length > 0
        ? (feedback.reduce((s, f) => s + (f.rating || 0), 0) / feedback.length).toFixed(1)
        : null
      const fiveStarCount = feedback.filter((f) => f.rating === 5).length
      const reviewsRequested = feedback.filter((f) => f.status === 'review_sent').length

      return {
        bookingsThisWeek: bookingsRes.count || 0,
        aiHandleRate: threads.length > 0 ? Math.round((aiThreads / threads.length) * 100) : 0,
        waMessages: threads.length,
        avgRating,
        fiveStarCount,
        reviewsRequested,
        recallSent: recallRes.count || 0,
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Overview</h1>
        <p className="text-muted-foreground">Welcome back! Here&apos;s what&apos;s happening.</p>
      </div>

      <PluginStatusBar />

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        <StatCard title="Appointments Booked" value={metrics?.bookingsThisWeek ?? '—'} subtitle="This week" icon="calendar" />
        <StatCard title="WA Threads" value={metrics?.waMessages ?? '—'} subtitle="All time" icon="message" />
        <StatCard title="AI Handle Rate" value={`${metrics?.aiHandleRate ?? 0}%`} icon="bot" />
        <StatCard title="Avg Rating" value={metrics?.avgRating ? `${metrics.avgRating} ⭐` : '—'} subtitle="Last 30 days" icon="star" />
        <StatCard title="5-Star Reviews" value={metrics?.fiveStarCount ?? '—'} subtitle="Last 30 days" icon="star" />
        <StatCard title="Review Requests Sent" value={metrics?.reviewsRequested ?? '—'} subtitle="Last 30 days" icon="message" />
        <StatCard title="Recall Messages Sent" value={metrics?.recallSent ?? '—'} subtitle="Last 30 days" icon="star" />
      </div>

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
              <p className="text-sm text-muted-foreground">No bookings yet</p>
            )}
            {recentBookings?.map((b: any) => (
              <div key={b.id} className="flex items-center justify-between text-sm">
                <div>
                  <p className="font-medium">{b.contact?.name || 'Unknown'}</p>
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
