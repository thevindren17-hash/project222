'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { format, parseISO } from 'date-fns'
import type { Booking } from '@/lib/types'

interface Props {
  booking: Booking
  open: boolean
  onClose: () => void
}

const statusColors: Record<string, string> = {
  pending: 'secondary', confirmed: 'default', cancelled: 'destructive', completed: 'outline',
}

export default function BookingDetailModal({ booking, open, onClose }: Props) {
  const queryClient = useQueryClient()

  const updateStatus = useMutation({
    mutationFn: async (status: string) => {
      const { error } = await supabase.from('bookings').update({ status }).eq('id', booking.id)
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Booking updated')
      queryClient.invalidateQueries({ queryKey: ['bookings'] })
      onClose()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Booking Details</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-muted-foreground">Patient</p>
              <p className="font-medium">{(booking as any).contact?.name || 'Unknown'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Phone</p>
              <p className="font-medium">{(booking as any).contact?.phone || '—'}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Service</p>
              <p className="font-medium">{booking.service_type}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Status</p>
              <Badge variant={statusColors[booking.status] as any}>{booking.status}</Badge>
            </div>
            <div>
              <p className="text-muted-foreground">Date & Time</p>
              <p className="font-medium">{format(parseISO(booking.scheduled_at.slice(0, 19)), 'MMM d, yyyy h:mm a')}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Source</p>
              <p className="font-medium capitalize">{booking.source}</p>
            </div>
          </div>
          {booking.notes && (
            <>
              <Separator />
              <div>
                <p className="text-muted-foreground text-sm">Notes</p>
                <p className="text-sm mt-1">{booking.notes}</p>
              </div>
            </>
          )}
          <Separator />
          <div className="flex gap-2 justify-end">
            {booking.status === 'pending' && (
              <Button size="sm" onClick={() => updateStatus.mutate('confirmed')}>Confirm</Button>
            )}
            {booking.status !== 'cancelled' && (
              <Button size="sm" variant="destructive" onClick={() => updateStatus.mutate('cancelled')}>Cancel</Button>
            )}
            <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
