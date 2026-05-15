'use client'

import { useState, useRef, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { CheckCircle2, XCircle, Copy, Loader2, RefreshCw, AlertCircle, Send, Bot, Zap, Bell, Star, UserRoundCheck } from 'lucide-react'

export default function WhatsAppPluginPage() {
  const queryClient = useQueryClient()
  const [phoneNumberId, setPhoneNumberId] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [businessAccountId, setBusinessAccountId] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [testPhone, setTestPhone] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [testLoading, setTestLoading] = useState(false)
  const [credError, setCredError] = useState<string | null>(null)
  const [credValid, setCredValid] = useState<{ phone: string; name: string } | null>(null)
  const [reminder1dEnabled, setReminder1dEnabled] = useState(false)
  const [reminder3hEnabled, setReminder3hEnabled] = useState(false)
  const [reminder1dTemplate, setReminder1dTemplate] = useState('')
  const [reminder3hTemplate, setReminder3hTemplate] = useState('')
  const [feedbackEnabled, setFeedbackEnabled] = useState(false)
  const [googleReviewUrl, setGoogleReviewUrl] = useState('')
  const [feedbackMsgTemplate, setFeedbackMsgTemplate] = useState('')
  const [reviewRequestTemplate, setReviewRequestTemplate] = useState('')
  const [negativeFeedbackMsg, setNegativeFeedbackMsg] = useState('')
  const [recallEnabled, setRecallEnabled] = useState(false)
  const [recallIntervalMonths, setRecallIntervalMonths] = useState(6)
  const [recallMsgTemplate, setRecallMsgTemplate] = useState('')
  // CSV upload state
  const [csvHeaders, setCsvHeaders] = useState<string[]>([])
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([])
  const [nameCol, setNameCol] = useState('')
  const [phoneCol, setPhoneCol] = useState('')
  const [csvSending, setCsvSending] = useState(false)
  const [csvResult, setCsvResult] = useState<{ sent: number; skipped: number; failed: number } | null>(null)
  const [csvDragOver, setCsvDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { data: tenant, isLoading, error, refetch } = useQuery({
    queryKey: ['tenant'],
    queryFn: getCurrentTenant,
    retry: 2,
    staleTime: 0,
  })

  const { data: agentSettings } = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: async () => {
      if (!tenant) return null
      const { data } = await supabase.from('tenant_settings').select(
        'llm_config,agent_name,system_prompt,provider_credentials,reminder_1d_enabled,reminder_3h_enabled,reminder_1d_template,reminder_3h_template,feedback_enabled,google_review_url,feedback_message_template,review_request_template,negative_feedback_message,recall_enabled,recall_interval_months,recall_message_template'
      ).eq('tenant_id', tenant.id).maybeSingle()
      if (data) {
        setReminder1dEnabled(!!data.reminder_1d_enabled)
        setReminder3hEnabled(!!data.reminder_3h_enabled)
        setReminder1dTemplate(data.reminder_1d_template || '')
        setReminder3hTemplate(data.reminder_3h_template || '')
        setFeedbackEnabled(!!data.feedback_enabled)
        setGoogleReviewUrl(data.google_review_url || '')
        setFeedbackMsgTemplate(data.feedback_message_template || '')
        setReviewRequestTemplate(data.review_request_template || '')
        setNegativeFeedbackMsg(data.negative_feedback_message || '')
        setRecallEnabled(!!data.recall_enabled)
        setRecallIntervalMonths(data.recall_interval_months || 6)
        setRecallMsgTemplate(data.recall_message_template || '')
      }
      return data
    },
    enabled: !!tenant,
  })

  const isConnected = !!tenant?.wa_phone_number_id

  // Determine AI agent readiness
  const llmProvider = agentSettings?.llm_config?.provider || ''
  const llmModel = agentSettings?.llm_config?.model || ''
  const agentName = agentSettings?.agent_name || 'Maya'
  const hasSystemPrompt = !!agentSettings?.system_prompt
  const hasLlmKey = !!(agentSettings?.provider_credentials?.[llmProvider]?.api_key)
  const agentReady = !!(llmProvider && hasLlmKey)

  const backendUrl = (process.env.NEXT_PUBLIC_BACKEND_URL || '').replace(/\/$/, '')
  const webhookUrl = tenant ? `${backendUrl}/webhook/whatsapp/${tenant.id}` : ''
  const verifyToken = tenant ? `wa_${tenant.id.replace(/-/g, '').slice(0, 16)}` : ''

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      setCredError(null)
      setCredValid(null)

      // Validate Phone Number ID with Meta before saving
      const valRes = await fetch('/api/whatsapp/validate-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenant.id, phone_number_id: phoneNumberId, access_token: accessToken }),
      })
      const valData = await valRes.json()
      if (!valData.valid) {
        throw new Error(valData.error || 'Invalid credentials')
      }
      setCredValid({ phone: valData.display_phone_number, name: valData.verified_name })

      const derivedToken = `wa_${tenant.id.replace(/-/g, '').slice(0, 16)}`
      const { error } = await supabase.from('tenants').update({
        wa_phone_number: phoneNumber || valData.display_phone_number || null,
        wa_phone_number_id: phoneNumberId,
        wa_business_account_id: businessAccountId,
        wa_access_token: accessToken,
        wa_verify_token: derivedToken,
      }).eq('id', tenant.id)
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('WhatsApp connected')
      queryClient.invalidateQueries({ queryKey: ['tenant'] })
      queryClient.invalidateQueries({ queryKey: ['plugin-status'] })
    },
    onError: (e: Error) => {
      setCredError(e.message)
      toast.error('Save failed — check credentials')
    },
  })

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      const { error } = await supabase.from('tenants').update({
        wa_phone_number: null,
        wa_phone_number_id: null,
        wa_business_account_id: null,
        wa_access_token: null,
      }).eq('id', tenant.id)
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('WhatsApp disconnected')
      queryClient.invalidateQueries({ queryKey: ['tenant'] })
      queryClient.invalidateQueries({ queryKey: ['plugin-status'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const saveRemindersMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      const { error } = await supabase.from('tenant_settings').upsert({
        tenant_id: tenant.id,
        reminder_1d_enabled: reminder1dEnabled,
        reminder_3h_enabled: reminder3hEnabled,
        reminder_1d_template: reminder1dTemplate.trim() || null,
        reminder_3h_template: reminder3hTemplate.trim() || null,
      }, { onConflict: 'tenant_id' })
      if (error) throw error
    },
    onSuccess: () => toast.success('Reminder settings saved'),
    onError: (e: Error) => toast.error(e.message),
  })

  const saveRecallMutation = useMutation({
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
    onSuccess: () => toast.success('Recall settings saved'),
    onError: (e: Error) => toast.error(e.message),
  })

  const saveFeedbackMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      const { error } = await supabase.from('tenant_settings').upsert({
        tenant_id: tenant.id,
        feedback_enabled: feedbackEnabled,
        google_review_url: googleReviewUrl.trim() || null,
        feedback_message_template: feedbackMsgTemplate.trim() || null,
        review_request_template: reviewRequestTemplate.trim() || null,
        negative_feedback_message: negativeFeedbackMsg.trim() || null,
      }, { onConflict: 'tenant_id' })
      if (error) throw error
    },
    onSuccess: () => toast.success('Feedback settings saved'),
    onError: (e: Error) => toast.error(e.message),
  })

  const NAME_CANDIDATES  = ['name', 'nama', 'patient', 'full name', 'patient name', 'pesakit']
  const PHONE_CANDIDATES = ['phone', 'mobile', 'tel', 'contact', 'number', 'no', 'telefon', 'hp', 'handphone']

  function detectCol(headers: string[], candidates: string[]): string {
    const lower = headers.map(h => h.toLowerCase().trim())
    for (const c of candidates) {
      const idx = lower.findIndex(h => h.includes(c))
      if (idx !== -1) return headers[idx]
    }
    return ''
  }

  const parseFile = useCallback(async (file: File) => {
    setCsvResult(null)
    setCsvHeaders([])
    setCsvRows([])

    try {
      if (file.name.endsWith('.csv') || file.type === 'text/csv') {
        const Papa = (await import('papaparse')).default
        Papa.parse<Record<string, string>>(file, {
          header: true,
          skipEmptyLines: true,
          complete: (res) => {
            const headers = res.meta.fields || []
            setCsvHeaders(headers)
            setCsvRows(res.data as Record<string, string>[])
            setNameCol(detectCol(headers, NAME_CANDIDATES))
            setPhoneCol(detectCol(headers, PHONE_CANDIDATES))
          },
        })
      } else {
        const XLSX = await import('xlsx')
        const buf = await file.arrayBuffer()
        const wb  = XLSX.read(buf, { type: 'array' })
        const ws  = wb.Sheets[wb.SheetNames[0]]
        const data = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: '' })
        if (!data.length) { toast.error('Spreadsheet appears to be empty'); return }
        const headers = Object.keys(data[0])
        setCsvHeaders(headers)
        setCsvRows(data)
        setNameCol(detectCol(headers, NAME_CANDIDATES))
        setPhoneCol(detectCol(headers, PHONE_CANDIDATES))
      }
    } catch {
      toast.error('Could not read file — make sure it is a valid CSV or Excel file')
    }
  }, [])

  async function sendCsvRecall() {
    if (!tenant || !nameCol || !phoneCol || !csvRows.length) return
    setCsvSending(true)
    setCsvResult(null)
    try {
      const contacts = csvRows
        .map(r => ({ name: String(r[nameCol] || '').trim(), phone: String(r[phoneCol] || '').trim() }))
        .filter(c => c.phone.length >= 6)

      const res = await fetch('/api/campaigns/recall-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: tenant.id,
          contacts,
          message_template: recallMsgTemplate.trim() || undefined,
          interval_months: recallIntervalMonths,
        }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || 'Send failed'); return }
      setCsvResult(data)
    } catch {
      toast.error('Network error')
    } finally {
      setCsvSending(false)
    }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text)
    toast.success('Copied!')
  }

  async function runTestSend() {
    if (!tenant || !testPhone.trim()) return
    setTestLoading(true)
    setTestResult(null)
    try {
      const res = await fetch('/api/whatsapp/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenant.id, to_phone: testPhone.trim() }),
      })
      const data = await res.json()
      setTestResult({ ok: data.success, msg: data.success ? 'Test message sent! Check your WhatsApp.' : (data.error || 'Unknown error') })
    } catch (e) {
      setTestResult({ ok: false, msg: 'Network error — backend unreachable' })
    } finally {
      setTestLoading(false)
    }
  }

  // ── Loading state ──────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="max-w-4xl space-y-6">
        <div>
          <h1 className="text-3xl font-bold">WhatsApp Plugin</h1>
          <p className="text-muted-foreground">Connect your WhatsApp Business account</p>
        </div>
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mr-2" />
            <span className="text-muted-foreground">Loading your account...</span>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Error / no tenant state ────────────────────────────────────────────────
  if (error || !tenant) {
    return (
      <div className="max-w-4xl space-y-6">
        <div>
          <h1 className="text-3xl font-bold">WhatsApp Plugin</h1>
          <p className="text-muted-foreground">Connect your WhatsApp Business account</p>
        </div>
        <Card className="border-destructive/50">
          <CardContent className="flex flex-col items-center justify-center py-12 gap-4">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <div className="text-center">
              <p className="font-medium">Could not load your clinic account</p>
              <p className="text-sm text-muted-foreground mt-1">
                {error ? `Error: ${(error as Error).message}` : 'No clinic account found for your login.'}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Make sure you are logged in with the correct account.
              </p>
            </div>
            <Button variant="outline" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Main page ──────────────────────────────────────────────────────────────
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">WhatsApp Plugin</h1>
        <p className="text-muted-foreground">Connect your WhatsApp Business account</p>
      </div>

      {/* Status card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Connection Status</CardTitle>
              <CardDescription>{isConnected ? 'Your WhatsApp is connected' : 'Not connected yet'}</CardDescription>
            </div>
            <Badge variant={isConnected ? 'default' : 'secondary'} className="gap-1">
              {isConnected
                ? <><CheckCircle2 className="h-4 w-4" />Connected</>
                : <><XCircle className="h-4 w-4" />Disconnected</>}
            </Badge>
          </div>
        </CardHeader>
        {isConnected && (
          <CardContent className="space-y-2">
            {tenant.wa_phone_number && (
              <p className="text-sm"><span className="font-medium">Phone Number:</span> {tenant.wa_phone_number}</p>
            )}
            <p className="text-sm"><span className="font-medium">Phone Number ID:</span> {tenant.wa_phone_number_id}</p>
            <p className="text-sm"><span className="font-medium">Business Account ID:</span> {tenant.wa_business_account_id || '—'}</p>
            <Button variant="destructive" size="sm" className="mt-4"
              onClick={() => disconnectMutation.mutate()} disabled={disconnectMutation.isPending}>
              {disconnectMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Disconnect
            </Button>
          </CardContent>
        )}
      </Card>

      {/* AI Agent Connection status */}
      <Card className={agentReady && isConnected ? 'border-green-500/40' : ''}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>AI Agent</CardTitle>
                <CardDescription>The AI model that will respond to your WhatsApp messages</CardDescription>
              </div>
            </div>
            <Badge variant={agentReady ? 'default' : 'secondary'} className="gap-1">
              {agentReady
                ? <><Zap className="h-3 w-3" />Active</>
                : <><AlertCircle className="h-3 w-3" />Not configured</>}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {agentReady ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 font-medium">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>
                  <span className="capitalize">{agentName}</span> is ready to handle WhatsApp messages
                  using <span className="font-semibold capitalize">{llmProvider}</span> · {llmModel}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  {hasSystemPrompt ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> : <XCircle className="h-3.5 w-3.5 text-yellow-500" />}
                  System prompt {hasSystemPrompt ? 'configured' : 'using default'}
                </div>
                <div className="flex items-center gap-1.5">
                  {isConnected ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> : <XCircle className="h-3.5 w-3.5 text-yellow-500" />}
                  WhatsApp credentials {isConnected ? 'saved' : 'not saved'}
                </div>
              </div>
              {agentReady && isConnected && (
                <div className="rounded-md bg-green-500/10 border border-green-500/20 p-3 text-sm text-green-700 dark:text-green-400">
                  ✓ Your AI agent is fully connected and will automatically reply to all incoming WhatsApp messages.
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-yellow-500" />
              <span>
                No AI model configured. Go to{' '}
                <a href="/settings/plugins/agent" className="text-primary underline underline-offset-2">
                  Agent Config
                </a>{' '}
                to set up your LLM provider and API key first.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Webhook config — always visible so you can copy these at any time */}
      <Card>
        <CardHeader>
          <CardTitle>Webhook Configuration</CardTitle>
          <CardDescription>Paste these into Meta Developer Portal → your App → WhatsApp → Configuration → Webhooks</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Callback URL</Label>
            <div className="flex gap-2">
              <Input value={webhookUrl} readOnly className="font-mono text-xs bg-muted" />
              <Button variant="outline" size="icon" onClick={() => copy(webhookUrl)}><Copy className="h-4 w-4" /></Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Verify Token</Label>
            <div className="flex gap-2">
              <Input value={verifyToken} readOnly className="font-mono text-xs bg-muted" />
              <Button variant="outline" size="icon" onClick={() => copy(verifyToken)}><Copy className="h-4 w-4" /></Button>
            </div>
            <p className="text-xs text-muted-foreground">After verifying, subscribe to the <span className="font-medium">messages</span> webhook field.</p>
          </div>
        </CardContent>
      </Card>

      {/* Test Connection — verify send credentials are working */}
      <Card>
        <CardHeader>
          <CardTitle>Test Connection</CardTitle>
          <CardDescription>Send a test message to verify your WhatsApp credentials are working correctly</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Send test message to (your own number)</Label>
            <div className="flex gap-2">
              <Input
                placeholder="+60123456789"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
                className="flex-1"
              />
              <Button onClick={runTestSend} disabled={testLoading || !testPhone.trim() || !isConnected}>
                {testLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                <span className="ml-2">Send Test</span>
              </Button>
            </div>
            {!isConnected && <p className="text-xs text-muted-foreground">Save credentials below before testing.</p>}
          </div>
          {testResult && (
            <div className={`flex items-start gap-2 rounded-md p-3 text-sm ${testResult.ok ? 'bg-green-500/10 text-green-600' : 'bg-destructive/10 text-destructive'}`}>
              {testResult.ok ? <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" /> : <XCircle className="h-4 w-4 mt-0.5 shrink-0" />}
              <span>{testResult.msg}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Appointment Reminders */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Bell className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Appointment Reminders</CardTitle>
              <CardDescription>Automatically send WhatsApp reminders to patients before their appointment</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="text-xs text-muted-foreground bg-muted/40 rounded-md p-3">
            Available placeholders: <code className="font-mono">{'{name}'}</code> <code className="font-mono">{'{service}'}</code> <code className="font-mono">{'{date}'}</code> <code className="font-mono">{'{time}'}</code>
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
                <Label className="text-xs">Message</Label>
                <Textarea
                  rows={3}
                  placeholder="Hi {name}, reminder: your {service} appointment is tomorrow, {date} at {time}. Reply CANCEL to cancel."
                  value={reminder1dTemplate}
                  onChange={(e) => setReminder1dTemplate(e.target.value)}
                  className="text-sm resize-none"
                />
                <p className="text-[11px] text-muted-foreground">Leave blank to use default message</p>
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
                <Label className="text-xs">Message</Label>
                <Textarea
                  rows={3}
                  placeholder="Hi {name}, your {service} appointment is in 3 hours at {time} today. See you soon!"
                  value={reminder3hTemplate}
                  onChange={(e) => setReminder3hTemplate(e.target.value)}
                  className="text-sm resize-none"
                />
                <p className="text-[11px] text-muted-foreground">Leave blank to use default message</p>
              </div>
            )}
          </div>

          <Button
            onClick={() => saveRemindersMutation.mutate()}
            disabled={saveRemindersMutation.isPending}
            size="sm"
          >
            {saveRemindersMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Reminder Settings
          </Button>
        </CardContent>
      </Card>

      {/* Feedback & Reviews */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Star className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Feedback & Reviews</CardTitle>
              <CardDescription>Automatically ask patients for a rating 2–6 hours after their visit, then invite happy patients to leave a Google review</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Enable post-visit feedback</p>
              <p className="text-xs text-muted-foreground">Sends a 1–5 star rating request after each appointment</p>
            </div>
            <Switch checked={feedbackEnabled} onCheckedChange={setFeedbackEnabled} />
          </div>

          {feedbackEnabled && (
            <div className="space-y-5">
              <div className="text-xs text-muted-foreground bg-muted/40 rounded-md p-3">
                Available placeholders: <code className="font-mono">{'{name}'}</code> <code className="font-mono">{'{service}'}</code> <code className="font-mono">{'{rating}'}</code> <code className="font-mono">{'{review_link}'}</code>
              </div>

              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Google Review Link <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <Input
                  placeholder="https://g.page/r/your-business/review"
                  value={googleReviewUrl}
                  onChange={(e) => setGoogleReviewUrl(e.target.value)}
                  className="text-sm"
                />
                <p className="text-[11px] text-muted-foreground">Patients rated 4–5 stars will be sent this link. Leave blank to just send a thank-you message.</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Feedback request message</Label>
                <Textarea
                  rows={4}
                  placeholder={`Hi {name}! 😊 Thank you for visiting us today for your {service}. How was your experience? Please reply with a number:\n1 ⭐ – Poor  2 ⭐⭐ – Fair  3 ⭐⭐⭐ – Good  4 ⭐⭐⭐⭐ – Great  5 ⭐⭐⭐⭐⭐ – Excellent`}
                  value={feedbackMsgTemplate}
                  onChange={(e) => setFeedbackMsgTemplate(e.target.value)}
                  className="text-sm resize-none"
                />
                <p className="text-[11px] text-muted-foreground">Leave blank to use the default message</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Google review invite (4–5 stars)</Label>
                <Textarea
                  rows={3}
                  placeholder="Thank you for the {rating} stars! ⭐ We really appreciate it. Would you mind sharing your experience on Google? {review_link}"
                  value={reviewRequestTemplate}
                  onChange={(e) => setReviewRequestTemplate(e.target.value)}
                  className="text-sm resize-none"
                />
                <p className="text-[11px] text-muted-foreground">Sent to patients who rated 4 or 5 stars (only when Google Review Link is set)</p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Low-rating response (1–3 stars)</Label>
                <Textarea
                  rows={3}
                  placeholder="We're sorry to hear that, {name}. We take all feedback seriously and our team will reach out to you shortly. 🙏"
                  value={negativeFeedbackMsg}
                  onChange={(e) => setNegativeFeedbackMsg(e.target.value)}
                  className="text-sm resize-none"
                />
                <p className="text-[11px] text-muted-foreground">Sent to patients who rated 1–3 stars. An escalation alert is also created for your staff.</p>
              </div>
            </div>
          )}

          <Button
            onClick={() => saveFeedbackMutation.mutate()}
            disabled={saveFeedbackMutation.isPending}
            size="sm"
          >
            {saveFeedbackMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Feedback Settings
          </Button>
        </CardContent>
      </Card>

      {/* Patient Recall & Re-engagement */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <UserRoundCheck className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Patient Recall</CardTitle>
              <CardDescription>Automatically reach out to patients who haven&apos;t visited in a while and invite them back</CardDescription>
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
                Available placeholders: <code className="font-mono">{'{name}'}</code> <code className="font-mono">{'{clinic}'}</code>
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

          <Button
            onClick={() => saveRecallMutation.mutate()}
            disabled={saveRecallMutation.isPending}
            size="sm"
          >
            {saveRecallMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Recall Settings
          </Button>

          {/* ── CSV / Excel upload ── */}
          <div className="border-t pt-6 space-y-4">
            <div>
              <p className="text-sm font-medium">Upload patient list</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Import contacts from your existing system and send recall messages immediately.
                Accepts <span className="font-mono">.csv</span>, <span className="font-mono">.xlsx</span>, or <span className="font-mono">.xls</span> files — max 500 contacts.
              </p>
            </div>

            {/* Drop zone */}
            <div
              className={`relative border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${
                csvDragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-accent/30'
              }`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setCsvDragOver(true) }}
              onDragLeave={() => setCsvDragOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setCsvDragOver(false)
                const file = e.dataTransfer.files[0]
                if (file) parseFile(file)
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) parseFile(f); e.target.value = '' }}
              />
              <p className="text-sm text-muted-foreground">
                {csvRows.length > 0
                  ? <span className="text-foreground font-medium">{csvRows.length} rows loaded — click to replace</span>
                  : <>Drag & drop or <span className="text-primary underline">browse</span> to upload</>}
              </p>
            </div>

            {/* Column mapping + preview */}
            {csvHeaders.length > 0 && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Name column</Label>
                    <select
                      value={nameCol}
                      onChange={(e) => setNameCol(e.target.value)}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      <option value="">— select —</option>
                      {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Phone column</Label>
                    <select
                      value={phoneCol}
                      onChange={(e) => setPhoneCol(e.target.value)}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      <option value="">— select —</option>
                      {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                </div>

                {/* Preview table */}
                {nameCol && phoneCol && (
                  <div className="rounded-md border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/60">
                        <tr>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">Name</th>
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">Phone</th>
                        </tr>
                      </thead>
                      <tbody>
                        {csvRows.slice(0, 5).map((r, i) => (
                          <tr key={i} className="border-t">
                            <td className="px-3 py-2">{r[nameCol] || '—'}</td>
                            <td className="px-3 py-2 font-mono">{r[phoneCol] || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {csvRows.length > 5 && (
                      <p className="px-3 py-2 text-[11px] text-muted-foreground border-t bg-muted/30">
                        …and {csvRows.length - 5} more rows
                      </p>
                    )}
                  </div>
                )}

                <Button
                  onClick={sendCsvRecall}
                  disabled={csvSending || !nameCol || !phoneCol || !isConnected}
                  size="sm"
                  className="w-full sm:w-auto"
                >
                  {csvSending
                    ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Sending…</>
                    : <><Send className="mr-2 h-4 w-4" />Send to {csvRows.length} contacts</>}
                </Button>
                {!isConnected && (
                  <p className="text-xs text-destructive">WhatsApp must be connected before sending.</p>
                )}
              </div>
            )}

            {/* Results */}
            {csvResult && (
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-lg bg-green-500/10 border border-green-500/20 p-3">
                  <p className="text-xl font-bold text-green-600 dark:text-green-400">{csvResult.sent}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Sent</p>
                </div>
                <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-3">
                  <p className="text-xl font-bold text-yellow-600 dark:text-yellow-400">{csvResult.skipped}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Already contacted</p>
                </div>
                <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3">
                  <p className="text-xl font-bold text-destructive">{csvResult.failed}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Failed</p>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Credentials form — always visible for initial setup or re-configuration */}
      <Card>
        <CardHeader>
          <CardTitle>{isConnected ? 'Update Credentials' : 'Connect WhatsApp Business'}</CardTitle>
          <CardDescription>
            {isConnected
              ? 'Update your credentials if your token has changed or you need to re-connect'
              : 'Get these from Meta Developer Portal → your App → WhatsApp → API Setup'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>WhatsApp Phone Number</Label>
            <Input autoComplete="off" placeholder="+60123456789" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} />
            <p className="text-xs text-muted-foreground">The actual number shown to users (e.g. +60123456789)</p>
          </div>
          <div className="space-y-2">
            <Label>Phone Number ID</Label>
            <Input
              autoComplete="off"
              placeholder="123456789012345"
              value={phoneNumberId}
              onChange={(e) => {
                const raw = e.target.value.trim()
                const match = raw.match(/\d{10,}/)
                setPhoneNumberId(match ? match[0] : raw)
              }}
            />
            <p className="text-xs text-muted-foreground">Found in Meta → WhatsApp → API Setup → Phone Number ID</p>
          </div>
          <div className="space-y-2">
            <Label>WhatsApp Business Account ID</Label>
            <Input autoComplete="off" placeholder="987654321098765" value={businessAccountId} onChange={(e) => setBusinessAccountId(e.target.value)} />
            <p className="text-xs text-muted-foreground">Found in Meta → WhatsApp → API Setup → WhatsApp Business Account ID</p>
          </div>
          <div className="space-y-2">
            <Label>Permanent Access Token</Label>
            <Input autoComplete="new-password" type="password" placeholder="EAA..." value={accessToken} onChange={(e) => setAccessToken(e.target.value)} />
            <p className="text-xs text-muted-foreground">Generate a permanent token from Meta System Users (not the temp token)</p>
          </div>
          <Button onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !phoneNumberId || !businessAccountId || !accessToken}>
            {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isConnected ? 'Update & Reconnect' : 'Save & Connect'}
          </Button>

          {credError && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{credError}</span>
            </div>
          )}
          {credValid && (
            <div className="flex items-start gap-2 rounded-md bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-400">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              <span>Verified: <strong>{credValid.name}</strong> — {credValid.phone}</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
