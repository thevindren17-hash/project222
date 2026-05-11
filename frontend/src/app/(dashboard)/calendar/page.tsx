'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin from '@fullcalendar/interaction'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import AddBookingModal from '@/components/calendar/add-booking-modal'
import BookingDetailModal from '@/components/calendar/booking-detail-modal'
import type { Booking } from '@/lib/types'

export default function CalendarPage() {
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)

  const { data: bookings } = useQuery({
    queryKey: ['bookings'],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) throw new Error('No tenant')
      const { data, error } = await supabase
        .from('bookings')
        .select('*, contact:contacts(*)')
        .eq('tenant_id', tenant.id)
        .order('scheduled_at', { ascending: true })
      if (error) throw error
      return data as Booking[]
    },
  })

  const events = bookings?.map((b) => ({
    id: b.id,
    title: `${b.service_type} — ${(b as any).contact?.name || 'Unknown'}`,
    start: b.scheduled_at,
    end: new Date(new Date(b.scheduled_at).getTime() + 30 * 60000).toISOString(),
    backgroundColor:
      b.status === 'confirmed' ? 'oklch(0.64 0.17 145)' :
      b.status === 'pending' ? 'oklch(0.78 0.18 75)' :
      b.status === 'cancelled' ? 'oklch(0.62 0.22 25)' : 'oklch(0.58 0.22 255)',
    borderColor: 'transparent',
    extendedProps: { booking: b },
  }))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Calendar</h1>
          <p className="text-muted-foreground">Manage appointments and bookings</p>
        </div>
        <Button onClick={() => setShowAddModal(true)}>+ Add Booking</Button>
      </div>

      <div className="flex gap-3 text-xs">
        {[['Confirmed', 'bg-[oklch(0.64_0.17_145)]'], ['Pending', 'bg-[oklch(0.78_0.18_75)]'],
          ['Cancelled', 'bg-[oklch(0.62_0.22_25)]'], ['Other', 'bg-[oklch(0.58_0.22_255)]']].map(([label, cls]) => (
          <div key={label} className="flex items-center gap-1">
            <div className={`h-3 w-3 rounded-sm ${cls}`} />
            <span className="text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>

      <Card className="p-4">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="timeGridWeek"
          headerToolbar={{ left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' }}
          events={events}
          eventClick={(info) => setSelectedBooking(info.event.extendedProps.booking)}
          dateClick={(info) => { setSelectedDate(new Date(info.dateStr)); setShowAddModal(true) }}
          height="auto"
          slotMinTime="08:00:00"
          slotMaxTime="20:00:00"
          allDaySlot={false}
          nowIndicator
          editable
          selectable
        />
      </Card>

      {selectedBooking && (
        <BookingDetailModal booking={selectedBooking} open={!!selectedBooking} onClose={() => setSelectedBooking(null)} />
      )}
      {showAddModal && (
        <AddBookingModal open={showAddModal} onClose={() => { setShowAddModal(false); setSelectedDate(null) }} defaultDate={selectedDate} />
      )}
    </div>
  )
}
