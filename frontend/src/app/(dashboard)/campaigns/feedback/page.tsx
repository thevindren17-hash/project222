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
import { Loader2, Star, FlaskConical, AlertCircle, CheckCircle2, ShieldCheck } from 'lucide-react'
import CsvCampaignUploader from '@/components/campaigns/csv-campaign-uploader'

interface ApprovedTemplate { id: string; name: string; body_text: string }

function fillPreview(tmpl: string) {
  return tmpl.replace('{{1}}', 'Sarah').replace('{{2}}', 'Dental Scaling')
}

export default function FeedbackAndReviewSystemPage() {
  const queryClient = useQueryClient()
  const [feedbackEnabled, setFeedbackEnabled] = useState(false)
  const [googleReviewUrl, setGoogleReviewUrl] = useState('')
  const [reviewRequestTemplate, setReviewRequestTemplate] = useState('')
  const [negativeFeedbackMsg, setNegativeFeedbackMsg] = useState('')
  const [referralEnabled, setReferralEnabled] = useState(false)
  const [referralMsgTemplate, setReferralMsgTemplate] = useState('')
  const [testPhone, setTestPhone] = useState('')
  const [testSending, setTestSending] = useState(false)
  const [testResult, setTestResult] = useState<{ message: string; to: string } | null>(null)
  const [testError, setTestError] = useState('')

  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })
  const isConnected = !!tenant?.wa_phone_number_id

  const { data: settings } = useQuery({
    queryKey: ['tenant-settings', 'feedback'],
    queryFn: async () => {
      if (!tenant) return null
      const { data } = await supabase.from('tenant_settings').select(
        'feedback_enabled,google_review_url,review_request_template,negative_feedback_message,referral_enabled,referral_message_template,feedback_whatsapp_template_id'
      ).eq('tenant_id', tenant.id).maybeSingle()
      return data
    },
    enabled: !!tenant,
  })

  const { data: approvedTemplates } = useQuery({
    queryKey: ['whatsapp-templates', tenant?.id, 'approved', 'feedback'],
    queryFn: async () => {
      if (!tenant) return []
      const res = await fetch(`/api/templates?tenant_id=${tenant.id}`)
      const data = await res.json()
      const list = (Array.isArray(data) ? data : []) as { id: string; name: string; body_text: string; status: string; purpose: string }[]
      return list.filter((t) => t.status === 'approved' && t.purpose === 'feedback') as ApprovedTemplate[]
    },
    enabled: !!tenant,
  })

  const [templateId, setTemplateId] = useState('')
  const selectedTemplate = approvedTemplates?.find((t) => t.id === templateId)

  useEffect(() => {
    if (!settings) return
    setFeedbackEnabled(!!settings.feedback_enabled)
    setGoogleReviewUrl(settings.google_review_url || '')
    setReviewRequestTemplate(settings.review_request_template || '')
    setNegativeFeedbackMsg(settings.negative_feedback_message || '')
    setReferralEnabled(!!settings.referral_enabled)
    setReferralMsgTemplate(settings.referral_message_template || '')
    setTemplateId(settings.feedback_whatsapp_template_id || '')
  }, [settings])

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      const { error } = await supabase.from('tenant_settings').upsert({
        tenant_id: tenant.id,
        feedback_enabled: feedbackEnabled,
        google_review_url: googleReviewUrl.trim() || null,
        review_request_template: reviewRequestTemplate.trim() || null,
        negative_feedback_message: negativeFeedbackMsg.trim() || null,
        referral_enabled: referralEnabled,
        referral_message_template: referralMsgTemplate.trim() || null,
        feedback_whatsapp_template_id: templateId || null,
      }, { onConflict: 'tenant_id' })
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Feedback settings saved')
      queryClient.invalidateQueries({ queryKey: ['tenant-settings', 'feedback'] })
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
        body: JSON.stringify({ tenant_id: tenant.id, phone: testPhone.trim(), type: 'feedback' }),
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
        <h1 className="text-3xl font-bold">Feedback and Review System</h1>
        <p className="text-muted-foreground">Automatically ask patients for a rating 2–6 hours after their visit, then invite happy patients to leave a Google review</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Star className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Automatic Post-Visit Feedback</CardTitle>
              <CardDescription>Sends a 1–5 star rating request after each appointment</CardDescription>
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
              <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/40 rounded-md p-3">
                <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0 text-primary" />
                <span>
                  The initial feedback request is sent as a Meta-approved WhatsApp message template (required
                  outside the 24-hour customer service window). Write and approve one on the{' '}
                  <a href="/campaigns/templates" className="underline">Message Templates</a> page, then pick it below —
                  it can even include a real &quot;Leave a Review&quot; button. The Google review invite and
                  low-rating response below are sent as direct replies within that window, so those stay fully
                  customizable text.
                </span>
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
                <Label className="text-sm font-medium">Approved feedback-request template</Label>
                <Select value={templateId} onValueChange={(v) => v && setTemplateId(v)}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="— select an approved template —" /></SelectTrigger>
                  <SelectContent>
                    {(approvedTemplates || []).map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!approvedTemplates?.length && (
                  <p className="text-[11px] text-muted-foreground">
                    No approved feedback templates yet — create one on the Message Templates page first.
                  </p>
                )}
                {selectedTemplate && (
                  <div className="rounded-md bg-muted/50 border p-3 text-sm leading-relaxed whitespace-pre-line">
                    {fillPreview(selectedTemplate.body_text)}
                  </div>
                )}
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

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Ask for referrals after positive feedback</p>
                    <p className="text-xs text-muted-foreground">Sent as a second message right after the Google review invite, only to patients who rated 4–5 stars</p>
                  </div>
                  <Switch checked={referralEnabled} onCheckedChange={setReferralEnabled} />
                </div>
                {referralEnabled && (
                  <Textarea
                    rows={3}
                    placeholder="If you know anyone who'd benefit from visiting {clinic}, we'd love a referral! Just have them mention your name when they book. 😊"
                    value={referralMsgTemplate}
                    onChange={(e) => setReferralMsgTemplate(e.target.value)}
                    className="text-sm resize-none"
                  />
                )}
              </div>
            </div>
          )}

          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} size="sm">
            {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Feedback Settings
          </Button>
        </CardContent>
      </Card>

      {/* Bulk CSV send */}
      <Card>
        <CardHeader>
          <CardTitle>Send Feedback Requests From a Spreadsheet</CardTitle>
          <CardDescription>
            Import patients from your existing system and send a feedback request immediately — replies are handled automatically, same as automatic feedback.
            Accepts <span className="font-mono">.csv</span>, <span className="font-mono">.xlsx</span>, or <span className="font-mono">.xls</span> files — max 500 contacts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CsvCampaignUploader
            type="feedback"
            tenantId={tenant?.id || ''}
            isConnected={isConnected}
            messageTemplate={selectedTemplate?.body_text || "Hi {name}, thank you for visiting us for your {service}! We'd love to hear your feedback."}
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
              <CardDescription>Send a real test feedback request to any WhatsApp number to verify it looks correct</CardDescription>
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
              : <><Star className="mr-2 h-3.5 w-3.5" />Send Test Feedback</>}
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
                Reply with 1–5 on WhatsApp to test the full feedback flow — a rating of 4–5 will trigger the Google review link, 1–3 will create an escalation alert.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
