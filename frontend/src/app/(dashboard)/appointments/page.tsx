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
import { format } from 'date-fns'
import BookingDetailModal from '@/components/calendar/booking-detail-modal'
import type { Booking } from '@/lib/types'

const statusColors: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'secondary', confirmed: 'default', cancelled: 'destructive', completed: 'outline',
}

export default function AppointmentsPage() {
  const [statusFilter, setStatusFilter] = useState('all')
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null)

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
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {bookings?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">No appointments found</TableCell>
                </TableRow>
              )}
              {bookings?.map((b: any) => (
                <TableRow key={b.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setSelectedBooking(b)}>
                  <TableCell>
                    <p className="font-medium">{b.contact?.name || 'Unknown'}</p>
                    <p className="text-xs text-muted-foreground">{b.contact?.phone}</p>
                  </TableCell>
                  <TableCell>{b.service_type}</TableCell>
                  <TableCell>{format(new Date(b.scheduled_at), 'MMM d, yyyy h:mm a')}</TableCell>
                  <TableCell className="capitalize">{b.source}</TableCell>
                  <TableCell><Badge variant={statusColors[b.status]}>{b.status}</Badge></TableCell>
                  <TableCell><Button variant="ghost" size="sm">View</Button></TableCell>
                </TableRow>
              ))}
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
