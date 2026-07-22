'use client'

import { useState, useRef, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin from '@fullcalendar/interaction'
import { Calendar } from '@/components/ui/calendar'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import AddBookingModal from '@/components/calendar/add-booking-modal'
import BookingDetailModal from '@/components/calendar/booking-detail-modal'
import { fetchGoogleCalendarEvents } from '@/lib/api'
import { BOOKING_STATUS } from '@/lib/booking-status'
import type { Booking } from '@/lib/types'
import { Plus, Link2, CheckCircle2 } from 'lucide-react'

const STATUS = BOOKING_STATUS

export default function CalendarPage() {
  const calRef = useRef<FullCalendar>(null)
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)
  const [miniDate, setMiniDate] = useState<Date | undefined>(new Date())

  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })

  const { data: settings } = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: async () => {
      if (!tenant) return null
      const { data } = await supabase
        .from('tenant_settings')
        .select('google_access_token,google_refresh_token,google_calendar_id')
        .eq('tenant_id', tenant.id)
        .maybeSingle()
      return data
    },
    enabled: !!tenant,
  })

  const { data: bookings } = useQuery({
    queryKey: ['bookings'],
    queryFn: async () => {
      const t = await getCurrentTenant()
      if (!t) throw new Error('No tenant')
      const { data, error } = await supabase
        .from('bookings')
        .select('*, contact:contacts(*)')
        .eq('tenant_id', t.id)
        .order('scheduled_at', { ascending: true })
      if (error) throw error
      return data as Booking[]
    },
  })

  const isConnected = !!(settings?.google_access_token || settings?.google_refresh_token)

  const { data: googleEvents } = useQuery({
    queryKey: ['google-calendar-events', tenant?.id],
    queryFn: () => fetchGoogleCalendarEvents(tenant!.id),
    enabled: isConnected && !!tenant,
    staleTime: 5 * 60 * 1000,
  })

  const bookingEvents = bookings?.map((b) => {
    // Strip timezone suffix so FullCalendar treats the stored time as local (no UTC conversion).
    // Stored times are naive local-time values; without this, UTC+8 browsers shift 10am → 6pm.
    const startLocal = b.scheduled_at.slice(0, 19)
    const endBase = new Date(startLocal + 'Z')
    endBase.setUTCMinutes(endBase.getUTCMinutes() + 30)
    const endLocal = endBase.toISOString().slice(0, 19)
    const style = STATUS[b.status as keyof typeof STATUS] ?? STATUS.completed
    return ({
    id: b.id,
    title: b.contact?.name ? `${b.service_type} · ${b.contact.name}` : b.service_type,
    start: startLocal,
    end: endLocal,
    backgroundColor: style.bg,
    borderColor: style.dot,
    textColor: style.text,
    extendedProps: { booking: b },
  })}) ?? []

  const gcalEvents = googleEvents?.map((e) => ({
    id: `gcal-${e.id}`,
    title: e.summary ?? '(no title)',
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
    backgroundColor: '#4285F4',
    borderColor: 'transparent',
    textColor: '#fff',
    extendedProps: { gcal: true },
  })) ?? []

  const handleMiniSelect = useCallback((date: Date | undefined) => {
    if (!date) return
    setMiniDate(date)
    calRef.current?.getApi().gotoDate(date)
  }, [])

  return (
    <>
      <div
        className="-mx-6 -mt-6 -mb-6 flex overflow-hidden"
        style={{ height: 'calc(100vh - 4rem)' }}
      >
        {/* ── SIDEBAR ─────────────────────────────────────────── */}
        <aside className="w-[220px] shrink-0 flex flex-col gap-5 border-r border-border bg-card overflow-y-auto p-4">
          <Button
            onClick={() => { setSelectedDate(null); setShowAddModal(true) }}
            className="w-full rounded-full gap-2 justify-start pl-5 shadow-md"
          >
            <Plus className="h-4 w-4" />
            New Booking
          </Button>

          {/* Mini month calendar */}
          <div style={{ '--cell-size': '1.6rem' } as React.CSSProperties}>
            <Calendar
              mode="single"
              selected={miniDate}
              onSelect={handleMiniSelect}
              showOutsideDays
              captionLayout="label"
              className="p-0 w-full"
            />
          </div>

          {/* My Calendars */}
          <div>
            <p className="text-[0.62rem] font-semibold text-muted-foreground uppercase tracking-widest mb-1.5 px-1">
              My Calendars
            </p>
            <div className="space-y-0.5">
              {Object.entries(STATUS).map(([key, { dot, label }]) => (
                <label
                  key={key}
                  className="flex items-center gap-2.5 px-1 py-1 rounded-md hover:bg-muted cursor-pointer transition-colors"
                >
                  <div className="h-3 w-3 rounded-sm shrink-0" style={{ backgroundColor: dot }} />
                  <span className="text-sm">{label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Other Calendars */}
          <div>
            <p className="text-[0.62rem] font-semibold text-muted-foreground uppercase tracking-widest mb-1.5 px-1">
              Other Calendars
            </p>
            {isConnected ? (
              <div className="flex items-center gap-2.5 px-1 py-1 rounded-md">
                <GoogleIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="text-sm">Google Calendar</span>
                <CheckCircle2 className="ml-auto h-3.5 w-3.5 text-green-500 shrink-0" />
              </div>
            ) : (
              <button
                className="flex items-center gap-2.5 px-1 py-1 rounded-md hover:bg-muted w-full text-left transition-colors group"
                onClick={() => { window.location.href = '/settings/plugins/google' }}
              >
                <GoogleIcon className="h-3.5 w-3.5 shrink-0 opacity-40 group-hover:opacity-70 transition-opacity" />
                <span className="text-sm text-muted-foreground">Connect Google</span>
                <Link2 className="ml-auto h-3 w-3 text-muted-foreground shrink-0" />
              </button>
            )}
          </div>
        </aside>

        {/* ── MAIN CALENDAR ───────────────────────────────────── */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <FullCalendar
            ref={calRef}
            plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
            initialView="timeGridWeek"
            headerToolbar={{
              left: 'prev,next today',
              center: 'title',
              right: 'dayGridMonth,timeGridWeek,timeGridDay',
            }}
            events={[...bookingEvents, ...gcalEvents]}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            eventClick={(info: any) => {
              if (!info.event.extendedProps.gcal) {
                setSelectedBooking(info.event.extendedProps.booking)
              }
            }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            dateClick={(info: any) => {
              setSelectedDate(new Date(info.dateStr))
              setShowAddModal(true)
            }}
            height="100%"
            slotMinTime="08:00:00"
            slotMaxTime="20:00:00"
            allDaySlot={false}
            nowIndicator
            editable
            selectable
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            dayHeaderContent={(args: any) => {
              const dayAbbr = args.date.toLocaleDateString('en', { weekday: 'short' }).toUpperCase()
              const dayNum = args.date.getDate()
              return (
                <div className="flex flex-col items-center gap-0.5 py-1.5">
                  <span className={cn(
                    'text-[0.6rem] font-semibold tracking-widest',
                    args.isToday ? 'text-primary' : 'text-muted-foreground'
                  )}>
                    {dayAbbr}
                  </span>
                  <span className={cn(
                    'h-7 w-7 flex items-center justify-center rounded-full text-[0.82rem] font-medium transition-colors',
                    args.isToday
                      ? 'bg-primary text-white font-bold'
                      : 'text-foreground hover:bg-muted'
                  )}>
                    {dayNum}
                  </span>
                </div>
              )
            }}
          />
        </div>
      </div>

      {selectedBooking && (
        <BookingDetailModal
          booking={selectedBooking}
          open={!!selectedBooking}
          onClose={() => setSelectedBooking(null)}
        />
      )}
      {showAddModal && (
        <AddBookingModal
          open={showAddModal}
          onClose={() => { setShowAddModal(false); setSelectedDate(null) }}
          defaultDate={selectedDate}
        />
      )}
    </>
  )
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  )
}
