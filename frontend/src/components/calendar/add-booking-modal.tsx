'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { format } from 'date-fns'

interface Props {
  open: boolean
  onClose: () => void
  defaultDate?: Date | null
}

const SERVICES = ['Scaling & Cleaning', 'Dental Checkup', 'Teeth Whitening', 'Tooth Extraction',
  'Braces & Orthodontics', 'Root Canal', 'Dental Crown', 'Dental Implant']

export default function AddBookingModal({ open, onClose, defaultDate }: Props) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [service, setService] = useState('')
  const [date, setDate] = useState(defaultDate ? format(defaultDate, 'yyyy-MM-dd') : '')
  const [time, setTime] = useState('09:00')
  const [notes, setNotes] = useState('')

  const addMutation = useMutation({
    mutationFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) throw new Error('No tenant')

      let contactId: string
      const { data: existing } = await supabase.from('contacts').select('id')
        .eq('tenant_id', tenant.id).eq('phone', phone).single()

      if (existing) {
        contactId = existing.id
      } else {
        const { data: newContact, error } = await supabase.from('contacts').insert({
          tenant_id: tenant.id, name, phone,
        }).select('id').single()
        if (error) throw error
        contactId = newContact.id
      }

      const { error } = await supabase.from('bookings').insert({
        tenant_id: tenant.id,
        contact_id: contactId,
        service_type: service,
        scheduled_at: new Date(`${date}T${time}`).toISOString(),
        status: 'pending',
        source: 'whatsapp',
        details: notes ? { notes } : {},
      })
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Booking added')
      queryClient.invalidateQueries({ queryKey: ['bookings'] })
      onClose()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Booking</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Patient Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
            </div>
            <div className="space-y-1">
              <Label>Phone</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+60..." />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Service</Label>
            <Select value={service} onValueChange={(v) => v && setService(v)}>
              <SelectTrigger><SelectValue placeholder="Select service" /></SelectTrigger>
              <SelectContent>
                {SERVICES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Date</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Time</Label>
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Notes (optional)</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={() => addMutation.mutate()}
              disabled={addMutation.isPending || !name || !phone || !service || !date}>
              {addMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Booking
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
