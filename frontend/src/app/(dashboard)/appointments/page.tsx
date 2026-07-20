'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from 'sonner'
import { format, parseISO } from 'date-fns'
import { Bell, Star, Loader2 } from 'lucide-react'
import BookingDetailModal from '@/components/calendar/booking-detail-modal'
import type { Booking } from '@/lib/types'

const statusColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'secondary', confirmed: 'default', cancelled: 'destructive', completed: 'outline',
}

export default function AppointmentsPage() {
  const [statusFilter, setStatusFilter] = useState('all')
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null)
  const [sendingId, setSendingId] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const { data: bookings } = useQuery({
    queryKey: ['bookings', statusFilter],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) return []
      let query = supabase.from('bookings').select('*, contact:contacts(name,phone)')
        .eq('tenant_id', tenant.id).order('scheduled_at', { ascending: false })
      if (statusFilter !== 'all') query = query.eq('status', statusFilter)
      const { data } = await query
      return (data || []) as Booking[]
    },
  })

  const { data: templates } = useQuery({
    queryKey: ['tenant-settings', 'campaign-templates'],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) return null
      const { data } = await supabase.from('tenant_settings')
        .select('reminder_1d_template,feedback_message_template')
        .eq('tenant_id', tenant.id).maybeSingle()
      return data
    },
  })

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
          message_template: type === 'reminder' ? templates?.reminder_1d_template : templates?.feedback_message_template,
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
      else if (data.skipped > 0) toast.info(data.errors?.[0] || 'Already sent recently — skipped to avoid spamming this patient')
      else toast.error(data.errors?.[0] || 'Send failed')
      queryClient.invalidateQueries({ queryKey: ['bookings'] })
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Send failed')
    } finally {
      setSendingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Appointments</h1>
          <p className="text-muted-foreground">{bookings?.length || 0} total appointments</p>
        </div>
        <Select value={statusFilter} onValueChange={(v) => v && setStatusFilter(v)}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="confirmed">Confirmed</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
          </SelectContent>
        </Select>
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
              {bookings?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">No appointments found</TableCell>
                </TableRow>
              )}
              {bookings?.map((b: any) => {
                const isCancelled = b.status === 'cancelled'
                const isPast = new Date(b.scheduled_at) < new Date()
                const reminderKey = `${b.id}:reminder`
                const feedbackKey = `${b.id}:feedback`
                return (
                <TableRow key={b.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setSelectedBooking(b)}>
                  <TableCell>
                    <p className="font-medium">{b.contact?.name || 'Unknown'}</p>
                    <p className="text-xs text-muted-foreground">{b.contact?.phone}</p>
                  </TableCell>
                  <TableCell>{b.service_type}</TableCell>
                  <TableCell>{format(parseISO(b.scheduled_at.slice(0, 19)), 'MMM d, yyyy h:mm a')}</TableCell>
                  <TableCell className="capitalize">{b.source}</TableCell>
                  <TableCell><Badge variant={statusColors[b.status]}>{b.status}</Badge></TableCell>
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
                  <TableCell><Button variant="ghost" size="sm">View</Button></TableCell>
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
