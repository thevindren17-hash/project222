'use client'

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { Loader2, Plus, Trash2 } from 'lucide-react'

const DAYS = [
  { key: 'mon', label: 'Monday' }, { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' }, { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' }, { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
]

export default function ClinicInfoPage() {
  const queryClient = useQueryClient()
  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })
  const { data: settings } = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: async () => {
      if (!tenant) return null
      const { data } = await supabase.from('tenant_settings').select('*').eq('tenant_id', tenant.id).single()
      return data
    },
    enabled: !!tenant,
  })

  const defaultHours = { open: '09:00', close: '18:00', closed: false }
  const [hours, setHours] = useState<Record<string, { open: string; close: string; closed: boolean }>>({
    mon: { ...defaultHours }, tue: { ...defaultHours }, wed: { ...defaultHours },
    thu: { ...defaultHours }, fri: { ...defaultHours },
    sat: { open: '09:00', close: '13:00', closed: false },
    sun: { open: '09:00', close: '18:00', closed: true },
  })
  const [faq, setFaq] = useState<Array<{ q: string; a: string }>>([])

  useEffect(() => {
    if (settings?.business_hours) setHours(settings.business_hours)
    if (settings?.faq) setFaq(settings.faq)
  }, [settings])

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      const { error } = await supabase.from('tenant_settings').upsert({
        tenant_id: tenant.id,
        business_hours: hours,
        faq,
      }, { onConflict: 'tenant_id' })
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Clinic info saved')
      queryClient.invalidateQueries({ queryKey: ['tenant-settings'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  function updateHours(day: string, field: string, value: string | boolean) {
    setHours((prev) => ({ ...prev, [day]: { ...prev[day], [field]: value } }))
  }

  function addFaq() { setFaq((prev) => [...prev, { q: '', a: '' }]) }
  function removeFaq(i: number) { setFaq((prev) => prev.filter((_, idx) => idx !== i)) }
  function updateFaq(i: number, field: 'q' | 'a', value: string) {
    setFaq((prev) => prev.map((item, idx) => idx === i ? { ...item, [field]: value } : item))
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Clinic Info & Hours</h1>
        <p className="text-muted-foreground">Set your business hours and FAQ</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Business Hours</CardTitle><CardDescription>AI will not book outside these hours</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          {DAYS.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-4">
              <div className="w-24">
                <Label className="text-sm">{label}</Label>
              </div>
              <Switch checked={!hours[key]?.closed} onCheckedChange={(v) => updateHours(key, 'closed', !v)} />
              {!hours[key]?.closed ? (
                <div className="flex items-center gap-2">
                  <Input type="time" value={hours[key]?.open || '09:00'} className="w-32"
                    onChange={(e) => updateHours(key, 'open', e.target.value)} />
                  <span className="text-muted-foreground">to</span>
                  <Input type="time" value={hours[key]?.close || '18:00'} className="w-32"
                    onChange={(e) => updateHours(key, 'close', e.target.value)} />
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">Closed</span>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div><CardTitle>FAQ</CardTitle><CardDescription>Common questions your AI can answer</CardDescription></div>
            <Button variant="outline" size="sm" onClick={addFaq}><Plus className="h-4 w-4 mr-1" />Add</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {faq.length === 0 && <p className="text-sm text-muted-foreground">No FAQ entries. Add some common questions.</p>}
          {faq.map((item, i) => (
            <div key={i} className="space-y-2 p-4 border rounded-md relative">
              <Button variant="ghost" size="icon" className="absolute top-2 right-2 h-6 w-6" onClick={() => removeFaq(i)}>
                <Trash2 className="h-3 w-3" />
              </Button>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Question</Label>
                <Input value={item.q} onChange={(e) => updateFaq(i, 'q', e.target.value)} placeholder="E.g. What are your opening hours?" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Answer</Label>
                <Textarea value={item.a} onChange={(e) => updateFaq(i, 'a', e.target.value)} rows={2}
                  placeholder="E.g. We are open Monday to Friday, 9am to 6pm." />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Changes
        </Button>
      </div>
    </div>
  )
}
