'use client'

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import { Loader2, UserRoundCheck, FlaskConical, AlertCircle, CheckCircle2 } from 'lucide-react'
import CsvCampaignUploader from '@/components/campaigns/csv-campaign-uploader'

export default function PatientRecallSystemPage() {
  const queryClient = useQueryClient()
  const [recallEnabled, setRecallEnabled] = useState(false)
  const [recallIntervalMonths, setRecallIntervalMonths] = useState(6)
  const [recallMsgTemplate, setRecallMsgTemplate] = useState('')
  const [testPhone, setTestPhone] = useState('')
  const [testSending, setTestSending] = useState(false)
  const [testResult, setTestResult] = useState<{ message: string; to: string } | null>(null)
  const [testError, setTestError] = useState('')

  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })
  const isConnected = !!tenant?.wa_phone_number_id

  const { data: settings } = useQuery({
    queryKey: ['tenant-settings', 'recall'],
    queryFn: async () => {
      if (!tenant) return null
      const { data } = await supabase.from('tenant_settings').select(
        'recall_enabled,recall_interval_months,recall_message_template'
      ).eq('tenant_id', tenant.id).maybeSingle()
      return data
    },
    enabled: !!tenant,
  })

  useEffect(() => {
    if (!settings) return
    setRecallEnabled(!!settings.recall_enabled)
    setRecallIntervalMonths(settings.recall_interval_months || 6)
    setRecallMsgTemplate(settings.recall_message_template || '')
  }, [settings])

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      const { error } = await supabase.from('tenant_settings').upsert({
        tenant_id: tenant.id,
        recall_enabled: recallEnabled,
        recall_interval_months: recallIntervalMonths,
        recall_message_template: recallMsgTemplate.trim() || null,
      }, { onConflict: 'tenant_id' })
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Recall settings saved')
      queryClient.invalidateQueries({ queryKey: ['tenant-settings', 'recall'] })
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
        body: JSON.stringify({ tenant_id: tenant.id, phone: testPhone.trim(), type: 'recall' }),
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
        <h1 className="text-3xl font-bold">Patient Recall System</h1>
        <p className="text-muted-foreground">Automatically reach out to patients who haven&apos;t visited in a while and invite them back</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <UserRoundCheck className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Automatic Recall</CardTitle>
              <CardDescription>Runs daily — sends one message per dormant patient per recall window</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Enable patient recall</p>
              <p className="text-xs text-muted-foreground">Runs daily — sends one message per dormant patient per recall window</p>
            </div>
            <Switch checked={recallEnabled} onCheckedChange={setRecallEnabled} />
          </div>

          {recallEnabled && (
            <div className="space-y-5">
              <div className="space-y-2">
                <p className="text-sm font-medium">Contact patients who haven&apos;t visited in</p>
                <div className="flex gap-2 flex-wrap">
                  {[3, 6, 12, 18, 24].map((m) => (
                    <button
                      key={m}
                      onClick={() => setRecallIntervalMonths(m)}
                      className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
                        recallIntervalMonths === m
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background border-input hover:bg-accent'
                      }`}
                    >
                      {m} months
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Patients with no visits in the last {recallIntervalMonths} months will receive one message per {recallIntervalMonths}-month window
                </p>
              </div>

              <div className="text-xs text-muted-foreground bg-muted/40 rounded-md p-3">
                Available placeholders: <code className="font-mono">{'{name}'}</code> <code className="font-mono">{'{clinic}'}</code> <code className="font-mono">{'{service}'}</code>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Re-engagement message</Label>
                <Textarea
                  rows={4}
                  placeholder={`Hi {name}! 👋 It's been a while since your last visit at {clinic}. We'd love to see you again! Just reply to book your next appointment. 😊`}
                  value={recallMsgTemplate}
                  onChange={(e) => setRecallMsgTemplate(e.target.value)}
                  className="text-sm resize-none"
                />
                <p className="text-[11px] text-muted-foreground">Leave blank to use the default message. The AI will handle any replies and book appointments normally.</p>
              </div>
            </div>
          )}

          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} size="sm">
            {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Recall Settings
          </Button>
        </CardContent>
      </Card>

      {/* Bulk CSV send */}
      <Card>
        <CardHeader>
          <CardTitle>Send Recall From a Spreadsheet</CardTitle>
          <CardDescription>
            Import contacts from your existing system and send recall messages immediately.
            Accepts <span className="font-mono">.csv</span>, <span className="font-mono">.xlsx</span>, or <span className="font-mono">.xls</span> files — max 500 contacts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CsvCampaignUploader
            type="recall"
            tenantId={tenant?.id || ''}
            isConnected={isConnected}
            messageTemplate={recallMsgTemplate}
            intervalMonths={recallIntervalMonths}
            extraColumns={[
              { key: 'service', label: 'Service', candidates: ['service', 'treatment'] },
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
              <CardDescription>Send a real test recall message to any WhatsApp number to verify it looks correct</CardDescription>
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
              : <><UserRoundCheck className="mr-2 h-3.5 w-3.5" />Send Test Recall</>}
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
              <p className="text-[11px] text-muted-foreground">
                Reply anything on WhatsApp — the AI will take over and offer to book an appointment.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
