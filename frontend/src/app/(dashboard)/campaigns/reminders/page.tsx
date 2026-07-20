'use client'

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import { Loader2, Bell, FlaskConical, AlertCircle, CheckCircle2, ShieldCheck } from 'lucide-react'
import CsvCampaignUploader from '@/components/campaigns/csv-campaign-uploader'

const REMINDER_1D_PREVIEW =
  'Hi {name}, this is a reminder that your {service} appointment is tomorrow, {date} at {time}. Reply CANCEL if you need to cancel. See you then!'
const REMINDER_3H_PREVIEW =
  'Hi {name}, your {service} appointment is in about 3 hours at {time} today. We look forward to seeing you!'

function fillPreview(tmpl: string) {
  return tmpl
    .replace('{name}', 'Sarah')
    .replace('{service}', 'Dental Checkup')
    .replace('{date}', '22 Jul 2026')
    .replace('{time}', '10:00 AM')
}

export default function AppointmentReminderSystemPage() {
  const queryClient = useQueryClient()
  const [reminder1dEnabled, setReminder1dEnabled] = useState(false)
  const [reminder3hEnabled, setReminder3hEnabled] = useState(false)
  const [testPhone, setTestPhone] = useState('')
  const [testSending, setTestSending] = useState(false)
  const [testResult, setTestResult] = useState<{ message: string; to: string } | null>(null)
  const [testError, setTestError] = useState('')

  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })
  const isConnected = !!tenant?.wa_phone_number_id

  const { data: settings } = useQuery({
    queryKey: ['tenant-settings', 'reminders'],
    queryFn: async () => {
      if (!tenant) return null
      const { data } = await supabase.from('tenant_settings').select(
        'reminder_1d_enabled,reminder_3h_enabled'
      ).eq('tenant_id', tenant.id).maybeSingle()
      return data
    },
    enabled: !!tenant,
  })

  useEffect(() => {
    if (!settings) return
    setReminder1dEnabled(!!settings.reminder_1d_enabled)
    setReminder3hEnabled(!!settings.reminder_3h_enabled)
  }, [settings])

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      const { error } = await supabase.from('tenant_settings').upsert({
        tenant_id: tenant.id,
        reminder_1d_enabled: reminder1dEnabled,
        reminder_3h_enabled: reminder3hEnabled,
      }, { onConflict: 'tenant_id' })
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Reminder settings saved')
      queryClient.invalidateQueries({ queryKey: ['tenant-settings', 'reminders'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  async function sendTestMessage() {
    if (!tenant || !testPhone.trim()) {
      setTestError('Enter a WhatsApp number first')
      return
    }
    setTestSending(true)
    setTestResult(null)
    setTestError('')
    try {
      const res = await fetch('/api/test/send-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenant.id, phone: testPhone.trim(), type: 'reminder' }),
      })
      const data = await res.json()
      if (!res.ok) { setTestError(data.error || 'Send failed'); return }
      setTestResult({ message: data.message, to: data.to })
    } catch {
      setTestError('Network error')
    } finally {
      setTestSending(false)
    }
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Appointment Reminder System</h1>
        <p className="text-muted-foreground">Automatically send WhatsApp reminders to patients before their appointment</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Automatic Reminders</CardTitle>
              <CardDescription>Sent based on each patient&apos;s booked appointment time</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/40 rounded-md p-3">
            <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
            <span>
              Reminders are sent as Meta-approved WhatsApp message templates (required outside the 24-hour
              customer service window). The wording below is fixed once approved and can&apos;t be edited here —
              only the name, service, date, and time change per patient.
            </span>
          </div>

          {/* 1-day reminder */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">1-day reminder</p>
                <p className="text-xs text-muted-foreground">Sent ~24 hours before the appointment</p>
              </div>
              <Switch checked={reminder1dEnabled} onCheckedChange={setReminder1dEnabled} />
            </div>
            {reminder1dEnabled && (
              <div className="space-y-1.5">
                <Label className="text-xs">Approved template preview</Label>
                <div className="rounded-md bg-muted/50 border p-3 text-sm leading-relaxed">
                  {fillPreview(REMINDER_1D_PREVIEW)}
                </div>
              </div>
            )}
          </div>

          {/* 3-hour reminder */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">3-hour reminder</p>
                <p className="text-xs text-muted-foreground">Sent ~3 hours before the appointment</p>
              </div>
              <Switch checked={reminder3hEnabled} onCheckedChange={setReminder3hEnabled} />
            </div>
            {reminder3hEnabled && (
              <div className="space-y-1.5">
                <Label className="text-xs">Approved template preview</Label>
                <div className="rounded-md bg-muted/50 border p-3 text-sm leading-relaxed">
                  {fillPreview(REMINDER_3H_PREVIEW)}
                </div>
              </div>
            )}
          </div>

          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} size="sm">
            {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Reminder Settings
          </Button>
        </CardContent>
      </Card>

      {/* Bulk CSV send */}
      <Card>
        <CardHeader>
          <CardTitle>Send Reminders From a Spreadsheet</CardTitle>
          <CardDescription>
            Import contacts from your existing system (name, phone, service, and optionally date/time) and send reminders immediately.
            Accepts <span className="font-mono">.csv</span>, <span className="font-mono">.xlsx</span>, or <span className="font-mono">.xls</span> files — max 500 contacts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CsvCampaignUploader
            type="reminder"
            tenantId={tenant?.id || ''}
            isConnected={isConnected}
            messageTemplate={REMINDER_1D_PREVIEW}
            extraColumns={[
              { key: 'service', label: 'Service', candidates: ['service', 'treatment'] },
              { key: 'date', label: 'Date', candidates: ['date', 'appointment date'] },
              { key: 'time', label: 'Time', candidates: ['time', 'appointment time'] },
            ]}
          />
        </CardContent>
      </Card>

      {/* Test message */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <FlaskConical className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Test Message</CardTitle>
              <CardDescription>Send a real test reminder to any WhatsApp number to verify it looks correct</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">WhatsApp number to send test to</Label>
            <Input
              placeholder="+60123456789"
              value={testPhone}
              onChange={(e) => { setTestPhone(e.target.value); setTestResult(null); setTestError('') }}
              className="font-mono"
            />
            <p className="text-[11px] text-muted-foreground">Include country code, e.g. +60 for Malaysia</p>
          </div>

          <Button variant="outline" size="sm" disabled={testSending || !isConnected} onClick={sendTestMessage}>
            {testSending
              ? <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />Sending…</>
              : <><Bell className="mr-2 h-3.5 w-3.5" />Send Test Reminder</>}
          </Button>

          {!isConnected && (
            <p className="text-xs text-destructive">Connect WhatsApp first before testing.</p>
          )}
          {testError && (
            <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 rounded-md p-3">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              {testError}
            </div>
          )}
          {testResult && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>Test message sent to <span className="font-mono">{testResult.to}</span></span>
              </div>
              <div className="rounded-md bg-muted/50 border p-3 text-xs whitespace-pre-wrap font-mono leading-relaxed">
                {testResult.message}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
