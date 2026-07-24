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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'
import { Loader2, UserRoundCheck, FlaskConical, AlertCircle, CheckCircle2, Plus, Trash2 } from 'lucide-react'
import CsvCampaignUploader from '@/components/campaigns/csv-campaign-uploader'

interface RecallSegment {
  id: string
  tenant_id: string
  service_type: string | null
  is_default: boolean
  interval_months: number
  message_template: string | null
  enabled: boolean
  whatsapp_template_id: string | null
}

interface ApprovedTemplate { id: string; name: string }

const DEFAULT_RECALL_PREVIEW =
  "Hi {name}! 👋 It's been a while since your last visit at {clinic}. We'd love to see you again! Just reply to book your next appointment. 😊"

export default function PatientRecallSystemPage() {
  const queryClient = useQueryClient()
  const [segments, setSegments] = useState<RecallSegment[]>([])
  const [selectedCsvSegmentId, setSelectedCsvSegmentId] = useState<string>('')
  const [testPhone, setTestPhone] = useState('')
  const [testSending, setTestSending] = useState(false)
  const [testResult, setTestResult] = useState<{ message: string; to: string } | null>(null)
  const [testError, setTestError] = useState('')

  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })
  const isConnected = !!tenant?.wa_phone_number_id

  const { data: fetchedSegments } = useQuery({
    queryKey: ['recall-segments'],
    queryFn: async () => {
      if (!tenant) return []
      const { data } = await supabase.from('recall_segments').select('*')
        .eq('tenant_id', tenant.id).order('created_at', { ascending: true })
      return (data || []) as RecallSegment[]
    },
    enabled: !!tenant,
  })

  // Recall messages must use a Meta-approved template (recipients are, by
  // definition, dormant patients outside the 24h window) -- see Marketing
  // Templates page. Only approved ones are selectable here.
  const { data: approvedTemplates } = useQuery({
    queryKey: ['whatsapp-templates', tenant?.id, 'approved'],
    queryFn: async () => {
      if (!tenant) return []
      const res = await fetch(`/api/templates?tenant_id=${tenant.id}`)
      const data = await res.json()
      const list = (Array.isArray(data) ? data : []) as { id: string; name: string; status: string }[]
      return list.filter((t) => t.status === 'approved') as ApprovedTemplate[]
    },
    enabled: !!tenant,
  })

  useEffect(() => {
    if (!fetchedSegments) return
    // Pin the default (catch-all) segment first so it's always visible.
    const sorted = [...fetchedSegments].sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0))
    setSegments(sorted)
    if (!selectedCsvSegmentId && sorted.length > 0) {
      setSelectedCsvSegmentId((sorted.find((s) => s.is_default) || sorted[0]).id)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }
  }, [fetchedSegments])

  const saveSegmentMutation = useMutation({
    mutationFn: async (segment: RecallSegment) => {
      if (!tenant) throw new Error('No tenant')
      const { error } = await supabase.from('recall_segments').upsert({
        id: segment.id,
        tenant_id: tenant.id,
        service_type: segment.is_default ? null : (segment.service_type?.trim() || null),
        is_default: segment.is_default,
        interval_months: segment.interval_months,
        message_template: segment.message_template?.trim() || null,
        enabled: segment.enabled,
        whatsapp_template_id: segment.whatsapp_template_id || null,
      }, { onConflict: 'id' })
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Recall segment saved')
      queryClient.invalidateQueries({ queryKey: ['recall-segments'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const deleteSegmentMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('recall_segments').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Segment removed')
      queryClient.invalidateQueries({ queryKey: ['recall-segments'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  function addSegment() {
    const draft: RecallSegment = {
      id: crypto.randomUUID(),
      tenant_id: tenant?.id || '',
      service_type: '',
      is_default: false,
      interval_months: 6,
      message_template: '',
      enabled: false,
      whatsapp_template_id: null,
    }
    setSegments((prev) => [...prev, draft])
  }

  function addDefaultSegment() {
    const draft: RecallSegment = {
      id: crypto.randomUUID(),
      tenant_id: tenant?.id || '',
      service_type: null,
      is_default: true,
      interval_months: 6,
      message_template: '',
      enabled: false,
      whatsapp_template_id: null,
    }
    setSegments([draft])
  }

  function updateSegment(id: string, patch: Partial<RecallSegment>) {
    setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

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

  const csvSegment = segments.find((s) => s.id === selectedCsvSegmentId)

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Patient Recall System</h1>
        <p className="text-muted-foreground">Automatically reach out to patients who haven&apos;t visited in a while — segment by treatment so whitening patients get a different offer than checkup patients</p>
      </div>

      {segments.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center space-y-3">
            <p className="text-sm text-muted-foreground">No recall segment set up yet.</p>
            <Button size="sm" onClick={addDefaultSegment}>Set Up Patient Recall</Button>
          </CardContent>
        </Card>
      )}

      {segments.map((segment) => (
        <Card key={segment.id}>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <UserRoundCheck className="h-5 w-5 text-primary" />
                <div>
                  <CardTitle>{segment.is_default ? 'Default segment' : (segment.service_type || 'New segment')}</CardTitle>
                  <CardDescription>
                    {segment.is_default ? 'Applies to any patient whose recent treatment doesn’t match another segment' : 'Applies to patients whose most recent booking matches this treatment'}
                  </CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={segment.enabled} onCheckedChange={(v) => updateSegment(segment.id, { enabled: v })} />
                {!segment.is_default && (
                  <Button
                    size="icon" variant="ghost"
                    onClick={() => deleteSegmentMutation.mutate(segment.id)}
                    disabled={deleteSegmentMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {!segment.is_default && (
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Treatment / service type match</Label>
                <Input
                  placeholder="e.g. whitening"
                  value={segment.service_type || ''}
                  onChange={(e) => updateSegment(segment.id, { service_type: e.target.value })}
                  className="text-sm"
                />
                <p className="text-[11px] text-muted-foreground">Matches any booking whose service contains this text (case-insensitive) — e.g. &quot;whitening&quot; matches &quot;Teeth Whitening&quot; and &quot;whitening consultation&quot;</p>
              </div>
            )}

            <div className="space-y-2">
              <p className="text-sm font-medium">Contact patients who haven&apos;t visited in</p>
              <div className="flex gap-2 flex-wrap">
                {[3, 6, 12, 18, 24].map((m) => (
                  <button
                    key={m}
                    onClick={() => updateSegment(segment.id, { interval_months: m })}
                    className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
                      segment.interval_months === m
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background border-input hover:bg-accent'
                    }`}
                  >
                    {m} months
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Approved marketing template to send</Label>
              <Select
                value={segment.whatsapp_template_id || ''}
                onValueChange={(v) => updateSegment(segment.id, { whatsapp_template_id: v || null })}
              >
                <SelectTrigger className="w-full"><SelectValue placeholder="— select an approved template —" /></SelectTrigger>
                <SelectContent>
                  {(approvedTemplates || []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Recall messages go to patients who haven&apos;t visited in months — WhatsApp requires a Meta-approved template for that.
                Create and get one approved on the <a href="/campaigns/templates" className="underline">Marketing Templates</a> page first.
                {!approvedTemplates?.length && ' You have no approved templates yet — recall sends will be skipped until one is linked.'}
              </p>
            </div>

            <div className="text-xs text-muted-foreground bg-muted/40 rounded-md p-3">
              Preview placeholders (for the log only, not what&apos;s actually sent): <code className="font-mono">{'{name}'}</code> <code className="font-mono">{'{clinic}'}</code> <code className="font-mono">{'{service}'}</code>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Re-engagement message (preview / internal log text)</Label>
              <Textarea
                rows={4}
                placeholder={DEFAULT_RECALL_PREVIEW}
                value={segment.message_template || ''}
                onChange={(e) => updateSegment(segment.id, { message_template: e.target.value })}
                className="text-sm resize-none"
              />
              <p className="text-[11px] text-muted-foreground">This text is only shown in your message history for readability — the actual WhatsApp message always uses the approved template selected above.</p>
            </div>

            <Button
              onClick={() => saveSegmentMutation.mutate(segment)}
              disabled={saveSegmentMutation.isPending}
              size="sm"
            >
              {saveSegmentMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Segment
            </Button>
          </CardContent>
        </Card>
      ))}

      <Button variant="outline" size="sm" onClick={addSegment} className="gap-1.5">
        <Plus className="h-4 w-4" /> Add Segment
      </Button>

      {/* Bulk CSV send */}
      <Card>
        <CardHeader>
          <CardTitle>Send Recall From a Spreadsheet</CardTitle>
          <CardDescription>
            Import contacts from your existing system and send recall messages immediately, using one segment&apos;s message and interval.
            Accepts <span className="font-mono">.csv</span>, <span className="font-mono">.xlsx</span>, or <span className="font-mono">.xls</span> files — max 500 contacts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Segment to use for this batch</Label>
            <Select value={selectedCsvSegmentId} onValueChange={(v) => v && setSelectedCsvSegmentId(v)}>
              <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
              <SelectContent>
                {segments.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.is_default ? 'Default segment' : (s.service_type || 'Untitled segment')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <CsvCampaignUploader
            type="recall"
            tenantId={tenant?.id || ''}
            isConnected={isConnected}
            messageTemplate={csvSegment?.message_template || DEFAULT_RECALL_PREVIEW}
            intervalMonths={csvSegment?.interval_months || 6}
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
