'use client'

import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import { format, parseISO, subWeeks, subMonths } from 'date-fns'
import { Bell, Star, Loader2, MessageCircleWarning, Archive, ArchiveRestore } from 'lucide-react'
import BookingDetailModal from '@/components/calendar/booking-detail-modal'
import { BOOKING_STATUS } from '@/lib/booking-status'
import type { Booking } from '@/lib/types'

const CLEAR_OLDER_THAN_OPTIONS: { value: string; label: string; cutoff: () => Date }[] = [
  { value: '2w', label: '2 weeks', cutoff: () => subWeeks(new Date(), 2) },
  { value: '3w', label: '3 weeks', cutoff: () => subWeeks(new Date(), 3) },
  { value: '1m', label: '1 month', cutoff: () => subMonths(new Date(), 1) },
]

export default function AppointmentsPage() {
  const [statusFilter, setStatusFilter] = useState('all')
  const [awaitingReplyOnly, setAwaitingReplyOnly] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [clearOlderThan, setClearOlderThan] = useState('2w')
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null)
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [archivingId, setArchivingId] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const queryClient = useQueryClient()

  const { data: bookings } = useQuery({
    queryKey: ['bookings', statusFilter, showArchived],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) return []
      let query = supabase.from('bookings').select('*, contact:contacts(name,phone)')
        .eq('tenant_id', tenant.id).order('scheduled_at', { ascending: false })
      if (statusFilter !== 'all') query = query.eq('status', statusFilter)
      query = showArchived ? query.not('archived_at', 'is', null) : query.is('archived_at', null)
      const { data } = await query
      return (data || []) as Booking[]
    },
  })

  // "Did the patient reply since we last messaged them?" — derived from the
  // most recent message per contact (any kind: reminder, AI reply, etc.),
  // not just reminder-specific tracking. If the last message in their thread
  // was from us (role='assistant'), they haven't followed up yet.
  const contactIds = useMemo(
    () => [...new Set((bookings || []).map((b) => b.contact_id).filter(Boolean))],
    [bookings]
  )
  const { data: lastMessageByContact } = useQuery({
    queryKey: ['appointments-last-message', contactIds],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant || contactIds.length === 0) return {}
      const { data } = await supabase.from('messages')
        .select('contact_id, role, created_at')
        .eq('tenant_id', tenant.id)
        .in('contact_id', contactIds)
        .order('created_at', { ascending: false })
        .limit(1000)
      const map: Record<string, { role: string; created_at: string }> = {}
      for (const m of data || []) {
        if (!map[m.contact_id]) map[m.contact_id] = { role: m.role, created_at: m.created_at }
      }
      return map
    },
    enabled: contactIds.length > 0,
  })

  function isAwaitingReply(b: Booking): boolean {
    const last = lastMessageByContact?.[b.contact_id]
    return !!last && last.role === 'assistant'
  }

  const visibleBookings = awaitingReplyOnly ? (bookings || []).filter(isAwaitingReply) : bookings

  async function sendOneOff(booking: any, type: 'reminder' | 'feedback') {
    const tenant = await getCurrentTenant()
    if (!tenant || !booking.contact?.phone) return
    setSendingId(`${booking.id}:${type}`)
    try {
      const scheduled = parseISO(booking.scheduled_at.slice(0, 19))
      const res = await fetch('/api/campaigns/send-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: tenant.id,
          type,
          contacts: [{
            name: booking.contact?.name || '',
            phone: booking.contact.phone,
            service: booking.service_type,
            date: format(scheduled, 'MMM d, yyyy'),
            time: format(scheduled, 'h:mm a'),
          }],
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Send failed')
      if (data.sent > 0) toast.success(type === 'reminder' ? 'Reminder sent' : 'Feedback request sent')
      else if (data.skipped > 0) toast.info(data.details?.[0]?.reason || 'Already sent recently — skipped to avoid spamming this patient')
      else toast.error(data.details?.[0]?.reason || 'Send failed')
      queryClient.invalidateQueries({ queryKey: ['bookings'] })
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Send failed')
    } finally {
      setSendingId(null)
    }
  }

  async function toggleArchive(booking: any) {
    setArchivingId(booking.id)
    try {
      const { error } = await supabase.from('bookings')
        .update({ archived_at: showArchived ? null : new Date().toISOString() })
        .eq('id', booking.id)
      if (error) throw error
      toast.success(showArchived ? 'Appointment restored' : 'Appointment archived')
      queryClient.invalidateQueries({ queryKey: ['bookings'] })
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setArchivingId(null)
    }
  }

  async function clearOldAppointments() {
    const tenant = await getCurrentTenant()
    if (!tenant) return
    const option = CLEAR_OLDER_THAN_OPTIONS.find((o) => o.value === clearOlderThan)
    if (!option) return
    const cutoffDate = option.cutoff()
    // scheduled_at is stored as naive clinic-local wall-clock digits, never
    // UTC — the cutoff must be built the same way (not .toISOString(),
    // which would tag it as UTC and silently shift it by the clinic's
    // offset, same bug class fixed elsewhere in this app already).
    const cutoffLocal = format(cutoffDate, "yyyy-MM-dd'T'HH:mm:ss")
    if (!confirm(
      `Archive all appointments scheduled before ${format(cutoffDate, 'MMM d, yyyy')}? `
      + 'This only hides them from this list — nothing is deleted, and you can bring them back anytime under "Show archived".'
    )) return

    setClearing(true)
    try {
      const { data, error } = await supabase.from('bookings')
        .update({ archived_at: new Date().toISOString() })
        .eq('tenant_id', tenant.id)
        .is('archived_at', null)
        .lt('scheduled_at', cutoffLocal)
        .select('id')
      if (error) throw error
      toast.success(`Archived ${data?.length || 0} old appointment${data?.length === 1 ? '' : 's'}`)
      queryClient.invalidateQueries({ queryKey: ['bookings'] })
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Appointments</h1>
          <p className="text-muted-foreground">{visibleBookings?.length || 0} of {bookings?.length || 0} appointments</p>
        </div>
        <div className="flex items-center gap-4 flex-wrap justify-end">
          {!showArchived && (
            <div className="flex items-center gap-1.5">
              <Select value={clearOlderThan} onValueChange={(v) => v && setClearOlderThan(v)}>
                <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CLEAR_OLDER_THAN_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" className="gap-1.5" disabled={clearing} onClick={clearOldAppointments}>
                {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
                Clear older than
              </Button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Switch checked={showArchived} onCheckedChange={setShowArchived} />
            <span className="text-sm text-muted-foreground whitespace-nowrap">Show archived</span>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={awaitingReplyOnly} onCheckedChange={setAwaitingReplyOnly} />
            <span className="text-sm text-muted-foreground whitespace-nowrap">Awaiting reply only</span>
          </div>
          <Select value={statusFilter} onValueChange={(v) => v && setStatusFilter(v)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="no_show">No-Show</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Patient</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Date & Time</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleBookings?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    {awaitingReplyOnly ? 'No patients awaiting reply' : 'No appointments found'}
                  </TableCell>
                </TableRow>
              )}
              {visibleBookings?.map((b: any) => {
                const isCancelled = b.status === 'cancelled'
                const isPast = new Date(b.scheduled_at) < new Date()
                const reminderKey = `${b.id}:reminder`
                const feedbackKey = `${b.id}:feedback`
                const awaitingReply = isAwaitingReply(b)
                return (
                <TableRow key={b.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setSelectedBooking(b)}>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <p className="font-medium">{b.contact?.name || 'Unknown'}</p>
                      {awaitingReply && (
                        <span title="Patient hasn't replied since our last message">
                          <MessageCircleWarning className="h-3.5 w-3.5 text-amber-500" />
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{b.contact?.phone}</p>
                  </TableCell>
                  <TableCell>{b.service_type}</TableCell>
                  <TableCell>{format(parseISO(b.scheduled_at.slice(0, 19)), 'MMM d, yyyy h:mm a')}</TableCell>
                  <TableCell className="capitalize">{b.source}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={BOOKING_STATUS[b.status as keyof typeof BOOKING_STATUS]?.badgeClass}>
                      {BOOKING_STATUS[b.status as keyof typeof BOOKING_STATUS]?.label || b.status}
                    </Badge>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {!isCancelled && !isPast && (
                      <Button
                        variant="outline" size="sm" className="text-xs gap-1.5"
                        disabled={sendingId === reminderKey || !b.contact?.phone}
                        onClick={() => sendOneOff(b, 'reminder')}
                      >
                        {sendingId === reminderKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bell className="h-3.5 w-3.5" />}
                        Reminder
                      </Button>
                    )}
                    {!isCancelled && isPast && (
                      <Button
                        variant="outline" size="sm" className="text-xs gap-1.5"
                        disabled={sendingId === feedbackKey || !b.contact?.phone}
                        onClick={() => sendOneOff(b, 'feedback')}
                      >
                        {sendingId === feedbackKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Star className="h-3.5 w-3.5" />}
                        Feedback
                      </Button>
                    )}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()} className="whitespace-nowrap">
                    <Button variant="ghost" size="sm" onClick={() => setSelectedBooking(b)}>View</Button>
                    <Button
                      variant="ghost" size="sm" className="gap-1.5 text-muted-foreground"
                      disabled={archivingId === b.id}
                      onClick={() => toggleArchive(b)}
                      title={showArchived ? 'Restore to active list' : 'Archive (hide from list, data is kept)'}
                    >
                      {archivingId === b.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : showArchived ? (
                        <ArchiveRestore className="h-3.5 w-3.5" />
                      ) : (
                        <Archive className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {selectedBooking && (
        <BookingDetailModal booking={selectedBooking} open={!!selectedBooking} onClose={() => setSelectedBooking(null)} />
      )}
    </div>
  )
}
