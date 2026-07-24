'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { Loader2, Plus, Trash2, ImagePlus, Send, MessageSquareText, AlertCircle } from 'lucide-react'
import CsvCampaignUploader, { ExtraColumn } from '@/components/campaigns/csv-campaign-uploader'

interface WhatsappTemplate {
  id: string
  tenant_id: string
  name: string
  language: string
  category: string
  header_type: string | null
  header_media_id: string | null
  body_text: string
  variables: string[]
  example_values: string[]
  footer_text: string | null
  meta_template_id: string | null
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'paused' | 'disabled'
  rejected_reason: string | null
  created_at: string
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

  // New-template draft form
  const [name, setName] = useState('')
  const [bodyText, setBodyText] = useState('')
  const [footerText, setFooterText] = useState('Reply STOP to unsubscribe')
  const [varMeta, setVarMeta] = useState<{ label: string; example: string }[]>([])
  const [showNewForm, setShowNewForm] = useState(false)

  const placeholderCount = detectPlaceholderCount(bodyText)
  // Keep varMeta rows in sync with however many {{n}} placeholders are
  // currently typed in the body -- variables/example_values submitted to
  // Meta are positional, so this is the single source of truth for order.
  if (varMeta.length !== placeholderCount) {
    const next = Array.from({ length: placeholderCount }, (_, i) => varMeta[i] || { label: '', example: '' })
    if (JSON.stringify(next) !== JSON.stringify(varMeta)) setVarMeta(next)
  }

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
          variables: varMeta.map((v) => v.label.trim() || 'value'),
          example_values: varMeta.map((v) => v.example.trim() || 'Example'),
          footer_text: footerText,
          language: 'en',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not create template')
      return data
    },
    onSuccess: () => {
      toast.success('Template saved as draft — attach an image (optional) and submit for approval below')
      setName(''); setBodyText(''); setFooterText('Reply STOP to unsubscribe'); setVarMeta([]); setShowNewForm(false)
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
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      toast.error('Only JPEG or PNG images are allowed')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image is too large — WhatsApp allows up to 5MB for a template header')
      return
    }
    setUploadingId(id)
    try {
      const form = new FormData()
      form.set('tenant_id', tenant.id)
      form.set('file', file)
      const res = await fetch(`/api/templates/${id}/media`, { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Image upload failed')
      toast.success('Image attached')
      queryClient.invalidateQueries({ queryKey: ['whatsapp-templates', tenant?.id] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Image upload failed')
    } finally {
      setUploadingId(null)
    }
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Marketing Templates</h1>
        <p className="text-muted-foreground">
          Write your own WhatsApp marketing messages and submit them for Meta&apos;s approval — once approved, upload a
          spreadsheet of patients to send a personalized campaign.
        </p>
      </div>

      {!isConnected && (
        <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 rounded-md p-3">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          Connect WhatsApp in Settings before creating templates.
        </div>
      )}

      {(templates || []).map((tpl) => (
        <Card key={tpl.id}>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <MessageSquareText className="h-5 w-5 text-primary" />
                <div>
                  <CardTitle className="font-mono text-base">{tpl.name}</CardTitle>
                  <CardDescription>{tpl.variables.length} variable{tpl.variables.length === 1 ? '' : 's'} · {tpl.language}{tpl.header_type ? ' · has image header' : ''}</CardDescription>
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
              Type <code className="font-mono">{'{{1}}'}</code>, <code className="font-mono">{'{{2}}'}</code>... anywhere you want a
              personalized value (patient name, offer, service) — a row appears below for each one you use.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Template name (internal, not shown to patients)</Label>
              <Input placeholder="e.g. End of Month Scaling Promo" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Message</Label>
              <Textarea
                rows={4} className="text-sm"
                placeholder="Hi {{1}}! Enjoy 20% off {{2}} until end of month."
                value={bodyText} onChange={(e) => setBodyText(e.target.value)}
              />
            </div>

            {varMeta.length > 0 && (
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground">Variables (in order)</p>
                {varMeta.map((v, i) => (
                  <div key={i} className="grid grid-cols-2 gap-2">
                    <Input
                      placeholder={`{{${i + 1}}} friendly name, e.g. name`} value={v.label}
                      onChange={(e) => setVarMeta((prev) => prev.map((p, j) => (j === i ? { ...p, label: e.target.value } : p)))}
                      className="text-xs"
                    />
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

            <div className="space-y-1.5">
              <Label className="text-xs">Footer (opt-out line — recommended for marketing messages)</Label>
              <Input value={footerText} onChange={(e) => setFooterText(e.target.value)} className="text-sm" />
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !name.trim() || !bodyText.trim() || varMeta.some((v) => !v.label.trim() || !v.example.trim())}
              >
                {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Draft
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowNewForm(false)}>Cancel</Button>
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
