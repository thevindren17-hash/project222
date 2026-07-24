'use client'

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'
import { Loader2, Plus, Trash2, ImagePlus, Send, MessageSquareText, AlertCircle, Download } from 'lucide-react'
import CsvCampaignUploader, { ExtraColumn } from '@/components/campaigns/csv-campaign-uploader'

type TemplatePurpose = 'marketing' | 'reminder' | 'feedback'

interface WhatsappTemplate {
  id: string
  tenant_id: string
  name: string
  language: string
  category: string
  purpose: TemplatePurpose
  header_type: string | null
  header_media_id: string | null
  body_text: string
  variables: string[]
  example_values: string[]
  footer_text: string | null
  buttons: { text: string; url: string }[] | null
  meta_template_id: string | null
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'paused' | 'disabled'
  rejected_reason: string | null
  created_at: string
}

interface MetaAvailableTemplate {
  meta_template_id: string
  name: string
  language: string
  category: string
  body_text: string
  footer_text: string | null
  header_type: string | null
  buttons: { text: string; url: string }[] | null
  variable_count: number
}

// Reminder/feedback jobs positionally inject values into these exact
// variables, in this exact order (backend/api/reminders.py,
// backend/api/campaigns.py) -- a clinic can't rename or reorder them the
// way they can for a marketing template, so these are shown read-only.
const FIXED_VARIABLES: Record<Exclude<TemplatePurpose, 'marketing'>, string[]> = {
  reminder: ['name', 'service', 'date', 'time'],
  feedback: ['name', 'service'],
}

const PURPOSE_LABEL: Record<TemplatePurpose, string> = {
  marketing: 'Marketing', reminder: 'Appointment Reminder', feedback: 'Feedback Request',
}

const BODY_PLACEHOLDER: Record<TemplatePurpose, string> = {
  marketing: 'Hi {{1}}! Enjoy 20% off {{2}} until end of month.',
  reminder: 'Hi {{1}}, this is a reminder that you have a {{2}} appointment on {{3}} at {{4}}.',
  feedback: 'Hi {{1}}, thank you for visiting us for your {{2}}! We\'d love to hear your feedback.',
}

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground border-transparent',
  pending: 'bg-amber-100 text-amber-800 border-transparent dark:bg-amber-900/40 dark:text-amber-300',
  approved: 'bg-green-100 text-green-800 border-transparent dark:bg-green-900/40 dark:text-green-300',
  rejected: 'bg-red-100 text-red-800 border-transparent dark:bg-red-900/40 dark:text-red-300',
  paused: 'bg-orange-100 text-orange-800 border-transparent dark:bg-orange-900/40 dark:text-orange-300',
  disabled: 'bg-red-100 text-red-800 border-transparent dark:bg-red-900/40 dark:text-red-300',
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft', pending: 'Pending review', approved: 'Approved',
  rejected: 'Rejected', paused: 'Paused', disabled: 'Disabled',
}

function detectPlaceholderCount(bodyText: string): number {
  const matches = [...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((m) => parseInt(m[1], 10))
  return matches.length ? Math.max(...matches) : 0
}

export default function MarketingTemplatesPage() {
  const queryClient = useQueryClient()
  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })
  const isConnected = !!tenant?.wa_phone_number_id

  const { data: googleReviewUrl } = useQuery({
    queryKey: ['tenant-settings', 'google-review-url', tenant?.id],
    queryFn: async () => {
      if (!tenant) return ''
      const { data } = await supabase.from('tenant_settings').select('google_review_url')
        .eq('tenant_id', tenant.id).maybeSingle()
      return data?.google_review_url || ''
    },
    enabled: !!tenant,
  })

  // New-template draft form
  const [purpose, setPurpose] = useState<TemplatePurpose>('marketing')
  const [name, setName] = useState('')
  const [bodyText, setBodyText] = useState('')
  const [footerText, setFooterText] = useState('Reply STOP to unsubscribe')
  const [varMeta, setVarMeta] = useState<{ label: string; example: string }[]>([])
  const [showNewForm, setShowNewForm] = useState(false)
  const [addReviewButton, setAddReviewButton] = useState(false)
  const [reviewButtonText, setReviewButtonText] = useState('Leave a Review')
  const [reviewButtonUrl, setReviewButtonUrl] = useState('')

  useEffect(() => {
    if (googleReviewUrl && !reviewButtonUrl) setReviewButtonUrl(googleReviewUrl)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleReviewUrl])

  const placeholderCount = detectPlaceholderCount(bodyText)
  if (purpose === 'marketing') {
    // Keep varMeta rows in sync with however many {{n}} placeholders are
    // currently typed in the body -- variables/example_values submitted to
    // Meta are positional, so this is the single source of truth for order.
    if (varMeta.length !== placeholderCount) {
      const next = Array.from({ length: placeholderCount }, (_, i) => varMeta[i] || { label: '', example: '' })
      if (JSON.stringify(next) !== JSON.stringify(varMeta)) setVarMeta(next)
    }
  } else {
    // Reminder/feedback: variables are fixed (see FIXED_VARIABLES) -- only
    // the example value per row is ever editable, label stays locked.
    const fixed = FIXED_VARIABLES[purpose]
    if (varMeta.length !== fixed.length || varMeta.some((v, i) => v.label !== fixed[i])) {
      const next = fixed.map((label, i) => ({ label, example: varMeta[i]?.label === label ? varMeta[i].example : '' }))
      setVarMeta(next)
    }
  }

  function resetNewForm() {
    setPurpose('marketing'); setName(''); setBodyText('')
    setFooterText('Reply STOP to unsubscribe'); setVarMeta([]); setShowNewForm(false)
    setAddReviewButton(false); setReviewButtonText('Leave a Review'); setReviewButtonUrl(googleReviewUrl || '')
    setImageFile(null)
  }

  function validateImageFile(file: File): string | null {
    if (!['image/jpeg', 'image/png'].includes(file.type)) return 'Only JPEG or PNG images are allowed'
    if (file.size > 5 * 1024 * 1024) return 'Image is too large — WhatsApp allows up to 5MB for a template header'
    return null
  }

  async function uploadTemplateImage(id: string, file: File) {
    if (!tenant) return
    const form = new FormData()
    form.set('tenant_id', tenant.id)
    form.set('file', file)
    const res = await fetch(`/api/templates/${id}/media`, { method: 'POST', body: form })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Image upload failed')
  }

  const [imageFile, setImageFile] = useState<File | null>(null)

  const { data: templates } = useQuery({
    queryKey: ['whatsapp-templates', tenant?.id],
    queryFn: async () => {
      if (!tenant) return []
      const res = await fetch(`/api/templates?tenant_id=${tenant.id}`)
      const data = await res.json()
      return (Array.isArray(data) ? data : []) as WhatsappTemplate[]
    },
    enabled: !!tenant,
    refetchInterval: (query) => {
      const list = (query.state.data as WhatsappTemplate[] | undefined) || []
      return list.some((t) => t.status === 'pending') ? 20000 : false
    },
  })

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      const res = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: tenant.id,
          name,
          body_text: bodyText,
          purpose,
          variables: varMeta.map((v) => v.label.trim() || 'value'),
          example_values: varMeta.map((v) => v.example.trim() || 'Example'),
          footer_text: purpose === 'marketing' ? footerText : null,
          language: 'en',
          buttons: purpose === 'feedback' && addReviewButton && reviewButtonUrl.trim()
            ? [{ text: reviewButtonText.trim() || 'Leave a Review', url: reviewButtonUrl.trim() }]
            : [],
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not create template')

      // Image upload is a separate call after the draft exists -- if it
      // fails, the draft itself is still saved (don't lose it / don't let
      // the mutation "fail" in a way that would invite a duplicate retry).
      // Only note the image error, don't throw.
      let imageError: string | null = null
      if (imageFile) {
        try {
          await uploadTemplateImage(data.id, imageFile)
        } catch (e) {
          imageError = e instanceof Error ? e.message : 'Image upload failed'
        }
      }
      return { ...data, imageError }
    },
    onSuccess: (data) => {
      if (data.imageError) {
        toast.warning(`Template saved, but the image didn't upload: ${data.imageError} — attach it from the card below.`)
      } else {
        toast.success(imageFile ? 'Template and image saved as draft — submit for approval below' : 'Template saved as draft — attach an image (optional) and submit for approval below')
      }
      resetNewForm()
      queryClient.invalidateQueries({ queryKey: ['whatsapp-templates', tenant?.id] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!tenant) throw new Error('No tenant')
      const res = await fetch(`/api/templates/${id}?tenant_id=${tenant.id}`, { method: 'DELETE' })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Delete failed') }
    },
    onSuccess: () => {
      toast.success('Template removed')
      queryClient.invalidateQueries({ queryKey: ['whatsapp-templates', tenant?.id] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const submitMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!tenant) throw new Error('No tenant')
      const res = await fetch(`/api/templates/${id}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenant.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Submission failed')
      return data
    },
    onSuccess: () => {
      toast.success("Submitted to Meta for review — usually a few minutes to 24 hours")
      queryClient.invalidateQueries({ queryKey: ['whatsapp-templates', tenant?.id] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const [uploadingId, setUploadingId] = useState<string | null>(null)
  async function attachMedia(id: string, file: File) {
    if (!tenant) return
    const err = validateImageFile(file)
    if (err) { toast.error(err); return }
    setUploadingId(id)
    try {
      await uploadTemplateImage(id, file)
      toast.success('Image attached')
      queryClient.invalidateQueries({ queryKey: ['whatsapp-templates', tenant?.id] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Image upload failed')
    } finally {
      setUploadingId(null)
    }
  }

  // Templates that already exist, approved, directly on Meta (e.g. created
  // by hand in WhatsApp Manager before this page existed) -- fetched lazily,
  // only once this section is opened, since it's an extra Meta API round trip.
  const [showImportSection, setShowImportSection] = useState(false)
  const [importPurposeById, setImportPurposeById] = useState<Record<string, TemplatePurpose>>({})
  const [importingId, setImportingId] = useState<string | null>(null)

  const { data: metaAvailable, isFetching: metaAvailableLoading, refetch: refetchMetaAvailable } = useQuery({
    queryKey: ['whatsapp-templates-meta-available', tenant?.id],
    queryFn: async () => {
      if (!tenant) return []
      const res = await fetch(`/api/templates/meta-available?tenant_id=${tenant.id}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not reach Meta')
      return (Array.isArray(data) ? data : []) as MetaAvailableTemplate[]
    },
    enabled: false,
  })

  async function importTemplate(t: MetaAvailableTemplate) {
    if (!tenant) return
    setImportingId(t.meta_template_id)
    try {
      const res = await fetch('/api/templates/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: tenant.id,
          meta_template_id: t.meta_template_id,
          purpose: importPurposeById[t.meta_template_id] || 'marketing',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Import failed')
      toast.success(`Imported "${t.name}" — ready to use immediately`)
      queryClient.invalidateQueries({ queryKey: ['whatsapp-templates', tenant.id] })
      refetchMetaAvailable()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setImportingId(null)
    }
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Message Templates</h1>
        <p className="text-muted-foreground">
          Write your own marketing, reminder, and feedback-request messages and submit them for Meta&apos;s approval —
          no more waiting on the WhatsApp team to set these up for you.
        </p>
      </div>

      {!isConnected && (
        <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 rounded-md p-3">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          Connect WhatsApp in Settings before creating templates.
        </div>
      )}

      {isConnected && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle>Already Have Approved Templates?</CardTitle>
                <CardDescription>
                  Import templates you already created directly in Meta&apos;s WhatsApp Manager — no need to recreate them here.
                </CardDescription>
              </div>
              <Button
                variant="outline" size="sm" className="gap-1.5 shrink-0"
                onClick={() => { setShowImportSection((v) => !v); if (!showImportSection) refetchMetaAvailable() }}
              >
                <Download className="h-3.5 w-3.5" />
                {showImportSection ? 'Hide' : 'Check Meta for Templates'}
              </Button>
            </div>
          </CardHeader>
          {showImportSection && (
            <CardContent className="space-y-3">
              {metaAvailableLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                  <Loader2 className="h-4 w-4 animate-spin" /> Checking Meta for your existing templates…
                </div>
              )}
              {!metaAvailableLoading && metaAvailable?.length === 0 && (
                <p className="text-sm text-muted-foreground py-2">
                  No new approved templates found on Meta — everything&apos;s already imported, or nothing&apos;s approved there yet.
                </p>
              )}
              {(metaAvailable || []).map((t) => (
                <div key={t.meta_template_id} className="rounded-md border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-mono text-sm font-medium">{t.name}</p>
                    <span className="text-[11px] text-muted-foreground">{t.category} · {t.language}{t.header_type ? ' · has image header' : ''}{t.buttons?.length ? ' · has button' : ''}</span>
                  </div>
                  <div className="rounded-md bg-muted/40 p-2 text-xs whitespace-pre-wrap">{t.body_text}</div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={importPurposeById[t.meta_template_id] || 'marketing'}
                      onValueChange={(v) => v && setImportPurposeById((prev) => ({ ...prev, [t.meta_template_id]: v as TemplatePurpose }))}
                    >
                      <SelectTrigger className="w-56 h-8 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="marketing">Marketing / Recall Campaign</SelectItem>
                        <SelectItem value="reminder">Appointment Reminder ({t.variable_count} var{t.variable_count === 1 ? '' : 's'} found)</SelectItem>
                        <SelectItem value="feedback">Feedback Request ({t.variable_count} var{t.variable_count === 1 ? '' : 's'} found)</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button size="sm" className="h-8 text-xs" disabled={importingId === t.meta_template_id} onClick={() => importTemplate(t)}>
                      {importingId === t.meta_template_id && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                      Import
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          )}
        </Card>
      )}

      {(templates || []).map((tpl) => (
        <Card key={tpl.id}>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <MessageSquareText className="h-5 w-5 text-primary" />
                <div>
                  <CardTitle className="font-mono text-base">{tpl.name}</CardTitle>
                  <CardDescription>
                    {PURPOSE_LABEL[tpl.purpose] || 'Marketing'} · {tpl.variables.length} variable{tpl.variables.length === 1 ? '' : 's'} · {tpl.language}
                    {tpl.header_type ? ' · has image header' : ''}{tpl.buttons?.length ? ' · has button' : ''}
                  </CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge className={STATUS_STYLE[tpl.status]}>{STATUS_LABEL[tpl.status] || tpl.status}</Badge>
                <Button size="icon" variant="ghost" onClick={() => deleteMutation.mutate(tpl.id)} disabled={deleteMutation.isPending}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-md bg-muted/40 p-3 text-sm whitespace-pre-wrap">{tpl.body_text}</div>
            {tpl.footer_text && <p className="text-xs text-muted-foreground italic">{tpl.footer_text}</p>}

            {tpl.status === 'rejected' && tpl.rejected_reason && (
              <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 rounded-md p-3">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                Meta rejected this: {tpl.rejected_reason}
              </div>
            )}

            {(tpl.status === 'draft' || tpl.status === 'rejected') && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <label className="inline-flex">
                  <input
                    type="file" accept="image/jpeg,image/png" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) attachMedia(tpl.id, f); e.target.value = '' }}
                  />
                  <span className="inline-flex items-center gap-1.5 text-xs border rounded-md px-3 py-1.5 cursor-pointer hover:bg-accent">
                    {uploadingId === tpl.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
                    {tpl.header_type ? 'Replace image' : 'Attach image (optional)'}
                  </span>
                </label>
                <Button size="sm" onClick={() => submitMutation.mutate(tpl.id)} disabled={submitMutation.isPending || !isConnected}>
                  {submitMutation.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                  {tpl.status === 'rejected' ? 'Resubmit for Approval' : 'Submit for Approval'}
                </Button>
              </div>
            )}

            {tpl.status === 'pending' && (
              <p className="text-xs text-muted-foreground">Waiting on Meta&apos;s review — this page checks automatically every 20 seconds.</p>
            )}

            {tpl.status === 'approved' && (
              <SendCampaignSection template={tpl} tenantId={tenant?.id || ''} isConnected={isConnected} />
            )}

            {(tpl.status === 'paused' || tpl.status === 'disabled') && (
              <p className="text-xs text-destructive">
                Meta has {tpl.status} this template (usually due to low quality ratings/reports) — create a new one instead.
              </p>
            )}
          </CardContent>
        </Card>
      ))}

      {!showNewForm && (
        <Button variant="outline" size="sm" onClick={() => setShowNewForm(true)} className="gap-1.5">
          <Plus className="h-4 w-4" /> New Template
        </Button>
      )}

      {showNewForm && (
        <Card>
          <CardHeader>
            <CardTitle>New Template</CardTitle>
            <CardDescription>
              {purpose === 'marketing'
                ? <>Type <code className="font-mono">{'{{1}}'}</code>, <code className="font-mono">{'{{2}}'}</code>... anywhere you want a
                    personalized value (patient name, offer, service) — a row appears below for each one you use.</>
                : `This wording is what patients see for every ${PURPOSE_LABEL[purpose].toLowerCase()} sent automatically.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">What is this template for?</Label>
              <Select value={purpose} onValueChange={(v) => v && setPurpose(v as TemplatePurpose)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="marketing">Marketing / Recall Campaign</SelectItem>
                  <SelectItem value="reminder">Appointment Reminder</SelectItem>
                  <SelectItem value="feedback">Feedback Request</SelectItem>
                </SelectContent>
              </Select>
              {purpose !== 'marketing' && (
                <p className="text-[11px] text-muted-foreground">
                  Reviewed as a transactional message, not a promotion — usually approved faster than marketing templates.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Template name (internal, not shown to patients)</Label>
              <Input placeholder="e.g. End of Month Scaling Promo" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Message</Label>
              <Textarea
                rows={4} className="text-sm"
                placeholder={BODY_PLACEHOLDER[purpose]}
                value={bodyText} onChange={(e) => setBodyText(e.target.value)}
              />
              {purpose !== 'marketing' && (
                <p className="text-[11px] text-muted-foreground">
                  Use exactly <code className="font-mono">{FIXED_VARIABLES[purpose].map((_, i) => `{{${i + 1}}}`).join(', ')}</code> in
                  that order for {FIXED_VARIABLES[purpose].join(', ')} — the system fills these in automatically for every send.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Image header <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <label className="inline-flex">
                <input
                  type="file" accept="image/jpeg,image/png" className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) {
                      const err = validateImageFile(f)
                      if (err) { toast.error(err); e.target.value = ''; return }
                      setImageFile(f)
                    }
                    e.target.value = ''
                  }}
                />
                <span className="inline-flex items-center gap-1.5 text-xs border rounded-md px-3 py-1.5 cursor-pointer hover:bg-accent">
                  <ImagePlus className="h-3.5 w-3.5" />
                  {imageFile ? imageFile.name : 'Choose image (JPEG/PNG, up to 5MB)'}
                </span>
              </label>
              {imageFile && (
                <Button variant="ghost" size="sm" className="ml-1 text-xs" onClick={() => setImageFile(null)}>Remove</Button>
              )}
            </div>

            {varMeta.length > 0 && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground">Variables (in order)</p>
                {varMeta.map((v, i) => (
                  <div key={i} className="grid grid-cols-2 gap-2">
                    {purpose === 'marketing' ? (
                      <Input
                        placeholder={`{{${i + 1}}} friendly name, e.g. name`} value={v.label}
                        onChange={(e) => setVarMeta((prev) => prev.map((p, j) => (j === i ? { ...p, label: e.target.value } : p)))}
                        className="text-xs"
                      />
                    ) : (
                      <div className="flex items-center px-3 text-xs font-mono text-muted-foreground">{`{{${i + 1}}} = ${v.label}`}</div>
                    )}
                    <Input
                      placeholder="Example value, e.g. Jack" value={v.example}
                      onChange={(e) => setVarMeta((prev) => prev.map((p, j) => (j === i ? { ...p, example: e.target.value } : p)))}
                      className="text-xs"
                    />
                  </div>
                ))}
                <p className="text-[11px] text-muted-foreground">Meta requires an example value for every variable to review the template.</p>
              </div>
            )}

            {purpose === 'marketing' && (
              <div className="space-y-1.5">
                <Label className="text-xs">Footer (opt-out line — recommended for marketing messages)</Label>
                <Input value={footerText} onChange={(e) => setFooterText(e.target.value)} className="text-sm" />
              </div>
            )}

            {purpose === 'feedback' && (
              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium">Add a &quot;Leave a Review&quot; button</Label>
                  <Switch checked={addReviewButton} onCheckedChange={setAddReviewButton} />
                </div>
                {addReviewButton && (
                  <div className="space-y-2 pt-1">
                    <Input placeholder="Button text, e.g. Leave a Review" value={reviewButtonText}
                      onChange={(e) => setReviewButtonText(e.target.value)} className="text-sm" />
                    <Input placeholder="Your Google review link" value={reviewButtonUrl}
                      onChange={(e) => setReviewButtonUrl(e.target.value)} className="text-sm" />
                    <p className="text-[11px] text-muted-foreground">
                      A real clickable button on the message, not a pasted link — opens straight to your Google review page.
                    </p>
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !name.trim() || !bodyText.trim() || varMeta.some((v) => !v.label.trim() || !v.example.trim())}
              >
                {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Draft
              </Button>
              <Button size="sm" variant="ghost" onClick={resetNewForm}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function SendCampaignSection({ template, tenantId, isConnected }: { template: WhatsappTemplate; tenantId: string; isConnected: boolean }) {
  const [open, setOpen] = useState(false)
  const extraColumns: ExtraColumn[] = template.variables.map((v) => ({
    key: v, label: v, candidates: [v],
  }))

  return (
    <div className="pt-1">
      {!open ? (
        <Button size="sm" onClick={() => setOpen(true)} className="gap-1.5">
          <Send className="h-3.5 w-3.5" /> Send Campaign From Spreadsheet
        </Button>
      ) : (
        <div className="space-y-3 pt-2 border-t">
          <p className="text-xs text-muted-foreground">
            Upload a spreadsheet with a column for each variable below — map each one, then send.
          </p>
          <CsvCampaignUploader
            type="marketing"
            tenantId={tenantId}
            isConnected={isConnected}
            messageTemplate={template.body_text}
            templateId={template.id}
            extraColumns={extraColumns}
          />
        </div>
      )}
    </div>
  )
}
