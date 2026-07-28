'use client'

import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Checkbox } from '@/components/ui/checkbox'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LLM_PROVIDERS } from '@/lib/providers'
import {
  Loader2, Bot, BookOpen, Users, Code, Eye, Plus, Trash2, Brain, Sparkles, Key, Check,
  ExternalLink, CheckCircle2, Database, Wrench, Upload,
} from 'lucide-react'

const SERVICES = [
  'Scaling & Cleaning', 'Dental Checkup', 'Teeth Whitening', 'Tooth Extraction',
  'Braces & Orthodontics', 'Root Canal', 'Dental Crown', 'Dental Implant', 'Other',
]

const SECTIONS = [
  { id: 'instructions', label: 'Instructions', icon: Code },
  { id: 'model', label: 'Model Settings', icon: Brain },
  { id: 'fields', label: 'Data Fields', icon: Database },
  { id: 'custom-tools', label: 'Custom Tools', icon: Wrench },
  { id: 'knowledge', label: 'Knowledge Base', icon: BookOpen },
  { id: 'handoff', label: 'Handoff', icon: Users },
]

const LLM_CRED_FIELDS: Record<string, { placeholder: string }> = {
  groq: { placeholder: 'gsk_...' },
  kimi: { placeholder: 'sk-...' },
  openai: { placeholder: 'sk-...' },
  anthropic: { placeholder: 'sk-ant-...' },
}

interface FaqItem { q: string; a: string }
type CustomFieldAction = 'book_appointment' | 'cancel_appointment' | 'reschedule_appointment'
interface CustomFieldItem { key: string; label: string; instruction: string; action: CustomFieldAction }

const CUSTOM_FIELD_ACTIONS: { value: CustomFieldAction; label: string; description: string }[] = [
  { value: 'book_appointment', label: 'Book Appointment', description: 'Extra questions asked when booking a new appointment, on top of the usual name, phone, service, date, and time.' },
  { value: 'cancel_appointment', label: 'Cancel Appointment', description: 'Extra questions asked when a patient wants to cancel an appointment.' },
  { value: 'reschedule_appointment', label: 'Reschedule Appointment', description: 'Extra questions asked when a patient wants to reschedule an appointment.' },
]

// Built-in tool names a clinic-created custom tool's key must never collide
// with — these have real, hardcoded backend behavior.
const RESERVED_TOOL_NAMES = new Set([
  'book_appointment', 'check_slots', 'lookup_patient', 'get_faq',
  'cancel_appointment', 'reschedule_appointment', 'escalate_to_human',
])

interface CustomToolField { key: string; label: string; instruction: string }
interface CustomTool {
  tool_key: string
  name: string
  trigger_instruction: string
  enabled: boolean
  fields: CustomToolField[]
}

// Mirrors backend/api/whatsapp.py's _RESERVED_FIELD_KEYS exactly -- a custom
// field using one of these keys collides with a built-in property (already
// collected automatically) and gets silently skipped server-side. Shown
// here so the clinic sees a warning where they're editing, instead of only
// in a server log they never see.
const RESERVED_FIELD_KEYS = new Set([
  'contact_name', 'contact_phone', 'service_type', 'date', 'time', 'notes',
  'new_date', 'new_time', 'booking_id',
  'name', 'phone', 'phone_number', 'full_name', 'patient_name', 'patient_phone',
  'services', 'appointment_date', 'appointment_time', 'date_time', 'datetime',
  'appointment_date_time', 'booking_date', 'booking_time',
])

// Field keys become tool-call argument names sent to the LLM, so they must be
// safe identifiers — not raw user text.
function slugifyFieldKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

// A custom tool's key becomes its LLM function name, so it must never
// collide with a built-in tool or another custom tool for this tenant —
// append _2, _3, ... until it's unique.
function slugifyToolKey(name: string, otherKeys: string[]): string {
  const base = slugifyFieldKey(name) || 'custom_tool'
  const taken = new Set([...RESERVED_TOOL_NAMES, ...otherKeys])
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(`${base}_${i}`)) i++
  return `${base}_${i}`
}

export default function AgentPluginPage() {
  const queryClient = useQueryClient()
  const [section, setSection] = useState('instructions')

  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })
  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ['tenant-settings', 'full'],
    queryFn: async () => {
      if (!tenant) return null
      // Exclude provider_credentials — keys never leave the server
      const { data, error } = await supabase.from('tenant_settings')
        .select('agent_name,system_prompt,custom_instructions,llm_config,tool_config,faq,voice_reply_enabled,voice_tts_provider,voice_tts_voice_map,voice_stt_provider,escalation_keywords,max_turns_before_handoff,reply_language,custom_booking_fields,base_field_labels,custom_tools')
        .eq('tenant_id', tenant.id).maybeSingle()
      if (error) throw error
      return data
    },
    enabled: !!tenant,
    staleTime: 0,
    refetchOnMount: true,
  })

  // Credential existence flags — only booleans, never actual key values
  const { data: credExistence } = useQuery({
    queryKey: ['agent-cred-existence'],
    queryFn: async () => {
      const res = await fetch('/api/credentials?type=agent')
      return res.ok ? (await res.json() as Record<string, boolean>) : {}
    },
    enabled: !!tenant,
    staleTime: 30_000,
  })

  const [agentName, setAgentName] = useState('Maya')
  const [clinicName, setClinicName] = useState('')
  const [clinicTagline, setClinicTagline] = useState('')
  const [tone, setTone] = useState('friendly')

  const [rawMode, setRawMode] = useState(true)
  const [rawPrompt, setRawPrompt] = useState('')
  const [promptSeeded, setPromptSeeded] = useState(false)
  const [selectedServices, setSelectedServices] = useState<string[]>([])
  const [specialInstructions, setSpecialInstructions] = useState('')
  const [neverSay, setNeverSay] = useState('')

  const [temperature, setTemperature] = useState(0.3)
  const [maxTokens, setMaxTokens] = useState(300)
  const [toolConfig, setToolConfig] = useState<Record<string, boolean>>({
    book_appointment: true, check_slots: true, get_faq: true, escalate: true,
  })

  const [faq, setFaq] = useState<FaqItem[]>([])
  const [uploadingFaq, setUploadingFaq] = useState(false)
  const [customFields, setCustomFields] = useState<CustomFieldItem[]>([])
  const [customTools, setCustomTools] = useState<CustomTool[]>([])

  const [llmProvider, setLlmProvider] = useState('groq')
  const [llmModel, setLlmModel] = useState('openai/gpt-oss-120b')
  const [newApiKey, setNewApiKey] = useState('')

  // Optional second provider -- empty string means "no fallback configured".
  // Used when the primary provider fails outright (bad key, outage, rate
  // limit) so the patient gets answered by the backup instead of the
  // generic "having trouble responding" message. Requires its own saved
  // API key, same as the primary.
  const [fallbackProvider, setFallbackProvider] = useState('')
  const [fallbackModel, setFallbackModel] = useState('')
  const [newFallbackApiKey, setNewFallbackApiKey] = useState('')

  const [voiceReplyEnabled, setVoiceReplyEnabled] = useState(false)
  const [voiceTtsProvider, setVoiceTtsProvider] = useState('openai')
  const [voiceTtsVoiceMap, setVoiceTtsVoiceMap] = useState<Record<string, string>>({})
  const [voiceSttProvider, setVoiceSttProvider] = useState('openai')
  const [newVoiceSttKey, setNewVoiceSttKey] = useState('')
  const [newVoiceTtsKey, setNewVoiceTtsKey] = useState('')
  const [replyLanguage, setReplyLanguage] = useState('ask')

  const [humanTakeover, setHumanTakeover] = useState(true)
  const [escalationKeywords, setEscalationKeywords] = useState<string[]>([
    'urgent', 'emergency', 'speak to human', 'real person',
  ])
  const [keywordsInput, setKeywordsInput] = useState('')
  const [maxTurns, setMaxTurns] = useState(10)
  const [baseFieldLabels, setBaseFieldLabels] = useState<Record<string, string>>({})

  useEffect(() => {
    if (tenant) setClinicName(tenant.name || '')
    if (settings && !promptSeeded) {
      setAgentName(settings.agent_name || 'Maya')
      // custom_instructions is the new field; fall back to the old
      // system_prompt column for clinics who saved a prompt before this split.
      setRawPrompt(settings.custom_instructions ?? settings.system_prompt ?? '')
      setPromptSeeded(true)
      setLlmProvider(settings.llm_config?.provider || 'groq')
      setLlmModel(settings.llm_config?.model || 'openai/gpt-oss-120b')
      setFallbackProvider(settings.llm_config?.fallback?.provider || '')
      setFallbackModel(settings.llm_config?.fallback?.model || '')
      setTemperature(settings.llm_config?.temperature ?? 0.3)
      setMaxTokens(settings.llm_config?.max_tokens ?? 300)
      setToolConfig(settings.tool_config || { book_appointment: true, check_slots: true, get_faq: true, escalate: true })
      setHumanTakeover(settings.tool_config?.escalate ?? true)
      setFaq(settings.faq || [])
      setCustomFields(
        (settings.custom_booking_fields || []).map((f: Partial<CustomFieldItem>) => ({
          key: f.key || '', label: f.label || '', instruction: f.instruction || '',
          action: f.action || 'book_appointment',
        }))
      )
      setVoiceReplyEnabled(settings.voice_reply_enabled ?? false)
      if (settings.voice_tts_provider) setVoiceTtsProvider(settings.voice_tts_provider)
      if (settings.voice_tts_voice_map) setVoiceTtsVoiceMap(settings.voice_tts_voice_map)
      if (settings.voice_stt_provider) setVoiceSttProvider(settings.voice_stt_provider)
      if (settings.escalation_keywords?.length) setEscalationKeywords(settings.escalation_keywords)
      if (settings.max_turns_before_handoff) setMaxTurns(settings.max_turns_before_handoff)
      if (settings.reply_language) setReplyLanguage(settings.reply_language)
      setBaseFieldLabels(settings.base_field_labels || {})
      setCustomTools(
        (settings.custom_tools || []).map((t: Partial<CustomTool>) => ({
          tool_key: t.tool_key || '', name: t.name || '', trigger_instruction: t.trigger_instruction || '',
          enabled: t.enabled ?? true,
          fields: (t.fields || []).map((f: Partial<CustomToolField>) => ({
            key: f.key || '', label: f.label || '', instruction: f.instruction || '',
          })),
        }))
      )
    }
  }, [tenant, settings, promptSeeded])

  // Builds only the CUSTOMIZATION layer — tone, services, clinic-specific
  // notes. Booking flow, escalation triggers, and safety rules are always
  // sent by the backend on top of this and can't be overridden here.
  function buildSystemPrompt() {
    const serviceList = selectedServices.length
      ? selectedServices.map((s) => `- ${s}`).join('\n')
      : ''
    return [
      ...(clinicTagline ? [`About us: ${clinicTagline}`, ''] : []),
      ...(serviceList ? ['Services we offer:', serviceList, ''] : []),
      `Preferred tone: ${tone.charAt(0).toUpperCase() + tone.slice(1)}`,
      ...(specialInstructions ? ['', 'Always say / do:', specialInstructions] : []),
      ...(neverSay ? ['', 'Never say:', neverSay] : []),
    ].join('\n').trim()
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      // Booking flow, escalation, and safety rules are always included by the
      // backend — this is only the clinic's optional customization on top,
      // so it's fine for it to be empty.
      const prompt = rawMode ? rawPrompt.trim() : buildSystemPrompt()
      const { error } = await supabase.from('tenant_settings').upsert({
        tenant_id: tenant.id,
        agent_name: agentName,
        custom_instructions: prompt,
        llm_config: {
          provider: llmProvider, model: llmModel, temperature, max_tokens: maxTokens,
          fallback: fallbackProvider && fallbackModel ? { provider: fallbackProvider, model: fallbackModel } : null,
        },
        tool_config: { ...toolConfig, escalate: humanTakeover },
        faq,
        custom_booking_fields: customFields.filter((f) => f.key && f.label),
        base_field_labels: Object.fromEntries(
          Object.entries(baseFieldLabels).filter(([, v]) => v.trim())
        ),
        custom_tools: customTools
          .filter((t) => t.tool_key && t.name)
          .map((t) => ({ ...t, fields: t.fields.filter((f) => f.key && f.label) })),
        voice_reply_enabled: voiceReplyEnabled,
        voice_tts_provider: voiceTtsProvider,
        voice_tts_voice_map: voiceTtsVoiceMap,
        voice_stt_provider: voiceSttProvider,
        escalation_keywords: escalationKeywords,
        max_turns_before_handoff: maxTurns,
        reply_language: replyLanguage,
      }, { onConflict: 'tenant_id' })
      if (error) throw error

      // Keep tenants.name in sync so voice agent greeting uses the right clinic name
      if (clinicName.trim()) {
        const { error: tenantError } = await supabase
          .from('tenants')
          .update({ name: clinicName.trim() })
          .eq('id', tenant.id)
        if (tenantError) throw tenantError
      }

      // Save API key separately — never included in the main upsert
      if (newApiKey.trim()) {
        const res = await fetch('/api/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: llmProvider, api_key: newApiKey.trim(), type: 'agent' }),
        })
        if (!res.ok) throw new Error('Failed to save API key')
        setNewApiKey('')
      }
      if (newFallbackApiKey.trim() && fallbackProvider) {
        const res = await fetch('/api/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: fallbackProvider, api_key: newFallbackApiKey.trim(), type: 'agent' }),
        })
        if (!res.ok) throw new Error('Failed to save fallback API key')
        setNewFallbackApiKey('')
      }
      if (newVoiceSttKey.trim()) {
        const res = await fetch('/api/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: voiceSttProvider, api_key: newVoiceSttKey.trim(), type: 'agent' }),
        })
        if (!res.ok) throw new Error('Failed to save STT API key')
        setNewVoiceSttKey('')
      }
      if (newVoiceTtsKey.trim()) {
        const res = await fetch('/api/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: voiceTtsProvider, api_key: newVoiceTtsKey.trim(), type: 'agent' }),
        })
        if (!res.ok) throw new Error('Failed to save TTS API key')
        setNewVoiceTtsKey('')
      }
    },
    onSuccess: () => {
      toast.success('Agent configuration saved')
      queryClient.invalidateQueries({ queryKey: ['tenant-settings'] })
      queryClient.invalidateQueries({ queryKey: ['plugin-status'] })
      queryClient.invalidateQueries({ queryKey: ['tenant-settings', 'full'] })
      queryClient.invalidateQueries({ queryKey: ['agent-cred-existence'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  function toggleService(service: string) {
    setSelectedServices((prev) =>
      prev.includes(service) ? prev.filter((s) => s !== service) : [...prev, service]
    )
  }
  // Knowledge Base saves itself the moment it changes (upload, delete, clear)
  // instead of waiting for the page's global Save Changes button -- a doc
  // upload should take effect immediately, not depend on the clinic
  // remembering to click Save while possibly mid-edit somewhere else on the
  // page. Only the faq column is touched (upsert with a single-key payload
  // updates just that column on conflict, or creates the row with sane
  // defaults elsewhere if this is a brand new tenant) -- never overwrites
  // any other in-progress, unsaved edit on this page.
  async function persistFaq(next: FaqItem[]) {
    if (!tenant) return
    const { error } = await supabase.from('tenant_settings').upsert(
      { tenant_id: tenant.id, faq: next },
      { onConflict: 'tenant_id' }
    )
    if (error) throw error
    queryClient.invalidateQueries({ queryKey: ['tenant-settings', 'full'] })
  }

  async function removeFaq(i: number) {
    const next = faq.filter((_, idx) => idx !== i)
    setFaq(next)
    try {
      await persistFaq(next)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove that entry')
      setFaq(faq)
    }
  }

  async function clearAllFaq() {
    if (faq.length === 0) return
    if (!confirm(`Remove all ${faq.length} knowledge base entries? This can't be undone.`)) return
    const prev = faq
    setFaq([])
    try {
      await persistFaq([])
      toast.success('Knowledge base cleared')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not clear the knowledge base')
      setFaq(prev)
    }
  }

  async function uploadFaqDocument(file: File) {
    if (!tenant) return
    if (!/\.(pdf|md|txt|json)$/i.test(file.name)) {
      toast.error('Only PDF, Markdown (.md), text (.txt), or JSON files are supported')
      return
    }
    if (file.size > 7 * 1024 * 1024) {
      toast.error('File is too large — please keep uploads under 7MB')
      return
    }
    setUploadingFaq(true)
    try {
      const form = new FormData()
      form.set('tenant_id', tenant.id)
      form.set('file', file)
      const res = await fetch('/api/agent/extract-faq', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || data.error || 'Could not extract Q&A from that document')
      const merged = [...faq, ...(data.faq || [])]
      setFaq(merged)
      await persistFaq(merged)
      toast.success(
        `Learned ${data.faq?.length || 0} things from "${file.name}" — the AI can use them right away`
        + (data.truncated ? ' (only the first part of the document was used)' : '')
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploadingFaq(false)
    }
  }
  function addCustomFieldForAction(action: CustomFieldAction) {
    setCustomFields([...customFields, { key: '', label: '', instruction: '', action }])
  }
  function updateCustomFieldLabel(i: number, label: string) {
    const next = [...customFields]
    next[i] = { ...next[i], label, key: slugifyFieldKey(label) }
    setCustomFields(next)
  }
  function updateCustomFieldInstruction(i: number, instruction: string) {
    const next = [...customFields]; next[i] = { ...next[i], instruction }; setCustomFields(next)
  }
  function removeCustomField(i: number) { setCustomFields(customFields.filter((_, idx) => idx !== i)) }
  function addCustomTool() {
    setCustomTools([...customTools, { tool_key: '', name: '', trigger_instruction: '', enabled: true, fields: [] }])
  }
  function updateCustomToolName(i: number, name: string) {
    const next = [...customTools]
    const otherKeys = customTools.filter((_, idx) => idx !== i).map((t) => t.tool_key)
    next[i] = { ...next[i], name, tool_key: name.trim() ? slugifyToolKey(name, otherKeys) : '' }
    setCustomTools(next)
  }
  function updateCustomToolTrigger(i: number, trigger_instruction: string) {
    const next = [...customTools]; next[i] = { ...next[i], trigger_instruction }; setCustomTools(next)
  }
  function toggleCustomToolEnabled(i: number, enabled: boolean) {
    const next = [...customTools]; next[i] = { ...next[i], enabled }; setCustomTools(next)
  }
  function removeCustomTool(i: number) { setCustomTools(customTools.filter((_, idx) => idx !== i)) }
  function addCustomToolField(i: number) {
    const next = [...customTools]
    next[i] = { ...next[i], fields: [...next[i].fields, { key: '', label: '', instruction: '' }] }
    setCustomTools(next)
  }
  function updateCustomToolField(i: number, j: number, label: string) {
    const next = [...customTools]
    const fields = [...next[i].fields]
    fields[j] = { ...fields[j], label, key: slugifyFieldKey(label) }
    next[i] = { ...next[i], fields }
    setCustomTools(next)
  }
  function updateCustomToolFieldInstruction(i: number, j: number, instruction: string) {
    const next = [...customTools]
    const fields = [...next[i].fields]
    fields[j] = { ...fields[j], instruction }
    next[i] = { ...next[i], fields }
    setCustomTools(next)
  }
  function removeCustomToolField(i: number, j: number) {
    const next = [...customTools]
    next[i] = { ...next[i], fields: next[i].fields.filter((_, idx) => idx !== j) }
    setCustomTools(next)
  }
  function addKeyword() {
    const kw = keywordsInput.trim().toLowerCase()
    if (kw && !escalationKeywords.includes(kw)) setEscalationKeywords([...escalationKeywords, kw])
    setKeywordsInput('')
  }
  function removeKeyword(kw: string) {
    setEscalationKeywords(escalationKeywords.filter((k) => k !== kw))
  }

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Agent Builder</h1>
          <p className="text-muted-foreground">Configure your AI receptionist</p>
        </div>
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} size="default">
          {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Changes
        </Button>
      </div>

      {/* ── Two-panel layout ── */}
      <div className="flex gap-6 items-start">

        {/* ── Left Panel ── */}
        <div className="w-52 shrink-0 space-y-3">

          {/* Agent identity card */}
          <Card>
            <CardContent className="pt-5 pb-4">
              <div className="flex flex-col items-center text-center gap-3">
                <div className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center ring-2 ring-primary/20">
                  <Bot className="h-7 w-7 text-primary" />
                </div>
                <div>
                  <p className="font-semibold text-sm leading-tight">{agentName || 'Maya'}</p>
                  <p className="text-xs text-muted-foreground">AI Receptionist</p>
                </div>
                <div className="flex flex-wrap gap-1 justify-center">
                  <Badge className="text-xs gap-1 px-2 py-0.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-green-400 inline-block" />
                    Active
                  </Badge>
                  <Badge variant="secondary" className="text-xs px-2 py-0.5 capitalize">{llmProvider}</Badge>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Quick-edit fields */}
          <Card>
            <CardContent className="p-3 space-y-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Agent Name</Label>
                <Input value={agentName} onChange={(e) => setAgentName(e.target.value)} className="h-7 text-sm" placeholder="Maya" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Clinic Name</Label>
                <Input value={clinicName} onChange={(e) => setClinicName(e.target.value)} className="h-7 text-sm" placeholder="Your clinic name" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Tagline</Label>
                <Input value={clinicTagline} onChange={(e) => setClinicTagline(e.target.value)} className="h-7 text-sm" placeholder="Optional" />
              </div>
            </CardContent>
          </Card>

          {/* Section navigation */}
          <nav className="space-y-0.5">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors text-left',
                  section === s.id
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <s.icon className="h-4 w-4 shrink-0" />
                {s.label}
              </button>
            ))}
          </nav>
        </div>

        {/* ── Right Content ── */}
        <div className="flex-1 min-w-0 space-y-4">

          {/* Instructions */}
          {section === 'instructions' && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Instructions</h2>
                  <p className="text-sm text-muted-foreground">Customize your AI's tone, services, and notes — the core booking flow and safety rules below are always active</p>
                </div>
                <div className="flex rounded-lg border overflow-hidden text-xs">
                  <button onClick={() => setRawMode(true)}
                    className={cn('px-3 py-1.5 font-medium transition-colors flex items-center gap-1.5',
                      rawMode ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground')}>
                    <Code className="h-3 w-3" />Write Notes
                  </button>
                  <button onClick={() => { if (rawMode && !rawPrompt) setRawPrompt(buildSystemPrompt()); setRawMode(false) }}
                    className={cn('px-3 py-1.5 font-medium transition-colors flex items-center gap-1.5 border-l',
                      !rawMode ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground')}>
                    <Eye className="h-3 w-3" />Use Builder
                  </button>
                </div>
              </div>

              <Card className="border-green-500/30 bg-green-500/5">
                <CardContent className="p-3.5 flex items-start gap-2.5">
                  <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500 mt-0.5 shrink-0" />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    <span className="font-medium text-foreground">Always on for every clinic:</span> collecting patient name & phone before booking,
                    confirming details before finalizing, checking availability, rescheduling/cancellation flow, answering FAQs,
                    and immediately transferring to a human for medical concerns, emergencies, or complaints. You don't need to write
                    any of this yourself — everything below is optional, additional customization on top.
                  </p>
                </CardContent>
              </Card>

              {rawMode ? (
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <CardTitle className="text-base">Customize Your Agent</CardTitle>
                        <CardDescription>Added on top of the built-in booking flow and safety rules — use this for tone, services, promotions, or clinic-specific notes. Leave blank to use default behavior only.</CardDescription>
                      </div>
                      {!rawPrompt && (
                        <Button variant="outline" size="sm" className="shrink-0 text-xs"
                          onClick={() => setRawPrompt(buildSystemPrompt())}>
                          Generate example notes
                        </Button>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <Textarea
                      value={rawPrompt}
                      onChange={(e) => setRawPrompt(e.target.value)}
                      rows={16}
                      className="font-mono text-sm resize-y min-h-[160px]"
                      placeholder={`We're a family-owned clinic since 1995 — mention this when relevant.\nAlways mention we have free parking.\nPrefer a warm, friendly tone.\nNever discuss insurance claims — always transfer to staff for that.`}
                    />
                    <p className="text-xs text-muted-foreground text-right">{rawPrompt.length} characters</p>
                  </CardContent>
                </Card>
              ) : (
                <>
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">Conversation Tone</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {[
                        { id: 'professional', label: 'Professional', desc: 'Formal, competent, and precise' },
                        { id: 'friendly', label: 'Friendly', desc: 'Warm, approachable, and helpful' },
                        { id: 'casual', label: 'Casual', desc: 'Relaxed and conversational' },
                      ].map((t) => (
                        <div key={t.id} onClick={() => setTone(t.id)}
                          className={cn(
                            'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors select-none',
                            tone === t.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                          )}
                        >
                          <div className={cn('h-4 w-4 rounded-full border-2 flex items-center justify-center shrink-0', tone === t.id ? 'border-primary' : 'border-muted-foreground')}>
                            {tone === t.id && <div className="h-2 w-2 rounded-full bg-primary" />}
                          </div>
                          <div>
                            <p className="font-medium text-sm">{t.label}</p>
                            <p className="text-xs text-muted-foreground">{t.desc}</p>
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">Services Offered</CardTitle>
                      <CardDescription>Services the AI can book appointments for</CardDescription>
                    </CardHeader>
                    <CardContent className="grid grid-cols-2 gap-2">
                      {SERVICES.map((service) => (
                        <div key={service} className="flex items-center space-x-2">
                          <Checkbox id={service} checked={selectedServices.includes(service)} onCheckedChange={() => toggleService(service)} />
                          <Label htmlFor={service} className="text-sm font-normal cursor-pointer">{service}</Label>
                        </div>
                      ))}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">Additional Notes</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="space-y-2">
                        <Label>Always say / do</Label>
                        <Textarea value={specialInstructions} onChange={(e) => setSpecialInstructions(e.target.value)} rows={3} placeholder="E.g., Always mention we have free parking..." />
                      </div>
                      <div className="space-y-2">
                        <Label>Never say</Label>
                        <Textarea value={neverSay} onChange={(e) => setNeverSay(e.target.value)} rows={3} placeholder="E.g., Never quote exact prices over the phone..." />
                      </div>
                    </CardContent>
                  </Card>

                  <Card className="bg-muted/30 border-dashed">
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm flex items-center gap-2"><Eye className="h-3.5 w-3.5" />Custom Notes Preview</CardTitle>
                        <Button variant="outline" size="sm" className="text-xs h-7"
                          onClick={() => { if (!rawPrompt) setRawPrompt(buildSystemPrompt()); setRawMode(true) }}>
                          Edit these notes
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <pre className="text-xs font-mono whitespace-pre-wrap max-h-56 overflow-y-auto leading-relaxed text-muted-foreground">
                        {buildSystemPrompt()}
                      </pre>
                    </CardContent>
                  </Card>
                </>
              )}
            </>
          )}

          {/* Model Settings */}
          {section === 'model' && (
            <>
              <div>
                <h2 className="text-lg font-semibold">Model Settings</h2>
                <p className="text-sm text-muted-foreground">Choose your AI provider and configure how it generates responses</p>
              </div>

              {/* Provider + model + API key */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-primary" />Language Model
                  </CardTitle>
                  <CardDescription>The AI engine for conversations</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">

                  {/* Compact provider grid */}
                  <div className="grid grid-cols-4 gap-2">
                    {LLM_PROVIDERS.map((p) => {
                      const active = llmProvider === p.provider
                      return (
                        <button
                          key={p.provider}
                          type="button"
                          onClick={() => {
                            setLlmProvider(p.provider)
                            if (p.models?.[0]) setLlmModel(p.models[0].id)
                          }}
                          className={cn(
                            'relative flex flex-col gap-1 rounded-xl border px-3 py-3 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                            active
                              ? 'border-primary bg-primary/5 shadow-sm'
                              : 'border-border hover:border-muted-foreground/30 hover:bg-muted/20'
                          )}
                        >
                          {active && (
                            <span className="absolute top-2 right-2 flex h-4 w-4 items-center justify-center rounded-full bg-primary">
                              <Check className="h-2.5 w-2.5 text-primary-foreground" />
                            </span>
                          )}
                          <span className="text-xs font-semibold leading-snug pr-5">{p.name}</span>
                          <span className={cn('text-[11px] font-medium', p.recommended ? 'text-emerald-500' : 'text-muted-foreground')}>
                            {p.estimatedCostPerCall}/call
                          </span>
                        </button>
                      )
                    })}
                  </div>

                  {/* Model + API key inline */}
                  {(() => {
                    const selectedLlm = LLM_PROVIDERS.find((p) => p.provider === llmProvider)
                    if (!selectedLlm) return null
                    const hasKey = !!LLM_CRED_FIELDS[llmProvider]
                    return (
                      <div className={cn('grid gap-3 pt-3 border-t', hasKey ? 'grid-cols-2' : 'grid-cols-1 max-w-sm')}>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-muted-foreground">Model</Label>
                          <Select value={llmModel} onValueChange={(v) => v && setLlmModel(v)}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {selectedLlm.models.map((m) => (
                                <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        {hasKey && (
                          <div className="space-y-1.5">
                            <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                              <Key className="h-3 w-3" />API Key
                              {credExistence?.[llmProvider] && !newApiKey && (
                                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5 text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800">
                                  <Check className="h-2.5 w-2.5" />Key saved
                                </Badge>
                              )}
                            </Label>
                            <Input
                              type="password"
                              placeholder={credExistence?.[llmProvider] ? 'Enter new key to replace…' : LLM_CRED_FIELDS[llmProvider].placeholder}
                              value={newApiKey}
                              onChange={(e) => setNewApiKey(e.target.value)}
                            />
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </CardContent>
              </Card>

              {/* Fallback LLM */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-primary" />Fallback LLM (optional)
                  </CardTitle>
                  <CardDescription>
                    Used automatically if the main provider above fails (bad key, outage, rate limit) — so patients
                    get answered by the backup instead of an error message. Needs its own saved API key.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5 max-w-sm">
                    <Label className="text-xs font-medium text-muted-foreground">Provider</Label>
                    <Select
                      value={fallbackProvider || 'none'}
                      onValueChange={(v) => {
                        if (!v || v === 'none') { setFallbackProvider(''); setFallbackModel(''); return }
                        setFallbackProvider(v)
                        const p = LLM_PROVIDERS.find((p) => p.provider === v)
                        setFallbackModel(p?.models?.[0]?.id || '')
                      }}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        {LLM_PROVIDERS.filter((p) => p.provider !== llmProvider).map((p) => (
                          <SelectItem key={p.provider} value={p.provider}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {fallbackProvider && (() => {
                    const selectedFallback = LLM_PROVIDERS.find((p) => p.provider === fallbackProvider)
                    if (!selectedFallback) return null
                    const hasKey = !!LLM_CRED_FIELDS[fallbackProvider]
                    return (
                      <div className={cn('grid gap-3 pt-3 border-t', hasKey ? 'grid-cols-2' : 'grid-cols-1 max-w-sm')}>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-muted-foreground">Model</Label>
                          <Select value={fallbackModel} onValueChange={(v) => v && setFallbackModel(v)}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {selectedFallback.models.map((m) => (
                                <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        {hasKey && (
                          <div className="space-y-1.5">
                            <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                              <Key className="h-3 w-3" />API Key
                              {credExistence?.[fallbackProvider] && !newFallbackApiKey && (
                                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5 text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800">
                                  <Check className="h-2.5 w-2.5" />Key saved
                                </Badge>
                              )}
                            </Label>
                            <Input
                              type="password"
                              placeholder={credExistence?.[fallbackProvider] ? 'Enter new key to replace…' : LLM_CRED_FIELDS[fallbackProvider].placeholder}
                              value={newFallbackApiKey}
                              onChange={(e) => setNewFallbackApiKey(e.target.value)}
                            />
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </CardContent>
              </Card>

              {/* Parameters */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Brain className="h-4 w-4 text-muted-foreground" />Parameters
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <Label>Temperature</Label>
                        <p className="text-xs text-muted-foreground mt-0.5">Lower = more consistent. Higher = more creative.</p>
                      </div>
                      <Badge variant="outline" className="font-mono tabular-nums text-sm px-3">{temperature.toFixed(1)}</Badge>
                    </div>
                    <input
                      type="range" min="0" max="1" step="0.1" value={temperature}
                      onChange={(e) => setTemperature(parseFloat(e.target.value))}
                      className="w-full h-2 accent-primary cursor-pointer rounded-full"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground px-0.5">
                      <span>Precise (0.0)</span>
                      <span>Balanced (0.5)</span>
                      <span>Creative (1.0)</span>
                    </div>
                  </div>

                  <Separator />

                  <div className="space-y-2">
                    <Label htmlFor="max-tokens">Max Tokens per Response</Label>
                    <p className="text-xs text-muted-foreground">
                      Limits how long each AI reply can be (128–4096). Keep this low (around 300) for a WhatsApp
                      receptionist — it&apos;s a backstop against the AI rambling or repeating itself, not just a
                      length preference. There are separate safeguards that catch rambling directly, so this doesn&apos;t
                      need to be as tight as possible — just tight enough that a runaway reply can&apos;t go far.
                    </p>
                    <div className="flex items-center gap-3">
                      <Input id="max-tokens" type="number" min={128} max={4096} step={128} value={maxTokens}
                        onChange={(e) => setMaxTokens(parseInt(e.target.value) || 300)}
                        className="w-36"
                      />
                      <span className="text-xs text-muted-foreground">tokens ≈ {Math.round(maxTokens * 0.75)} words</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </>
          )}

          {/* Data Fields */}
          {section === 'fields' && (
            <>
              <div>
                <h2 className="text-lg font-semibold">Data Fields</h2>
                <p className="text-sm text-muted-foreground">
                  Extra questions the AI asks, grouped under whichever function it's actually collecting them
                  for — on top of the usual name, phone, service, date, and time. Captured values are saved
                  with the booking and, if connected, mirrored to your Google Sheet.
                </p>
              </div>

              {CUSTOM_FIELD_ACTIONS.map((actionDef) => {
                // Original array indexes preserved through the filter, since
                // add/update/remove all operate on the single shared
                // customFields array — only the display groups fields by
                // which function they belong to.
                const fieldsForAction = customFields
                  .map((f, i) => ({ field: f, idx: i }))
                  .filter(({ field }) => field.action === actionDef.value)

                return (
                  <div key={actionDef.value} className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-semibold">{actionDef.label}</h3>
                        <p className="text-xs text-muted-foreground">{actionDef.description}</p>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => addCustomFieldForAction(actionDef.value)}>
                        <Plus className="h-3.5 w-3.5 mr-1.5" />Add Field
                      </Button>
                    </div>

                    {fieldsForAction.length === 0 ? (
                      <Card className="border-dashed">
                        <CardContent className="flex flex-col items-center justify-center py-8 gap-1.5 text-muted-foreground">
                          <Database className="h-6 w-6 opacity-25" />
                          <p className="text-xs">No extra fields for {actionDef.label.toLowerCase()} yet</p>
                        </CardContent>
                      </Card>
                    ) : (
                      <div className="space-y-3">
                        {fieldsForAction.map(({ field: f, idx: i }) => (
                          <Card key={i}>
                            <CardContent className="pt-4 pb-4">
                              <div className="flex items-start gap-3">
                                <div className="flex-1 space-y-2">
                                  <Input
                                    placeholder="Field label — e.g. Insurance Provider"
                                    value={f.label}
                                    onChange={(e) => updateCustomFieldLabel(i, e.target.value)}
                                    className="font-medium"
                                  />
                                  <Textarea
                                    placeholder="What should the AI ask? — e.g. Ask if they have insurance and which provider."
                                    value={f.instruction}
                                    onChange={(e) => updateCustomFieldInstruction(i, e.target.value)}
                                    rows={2}
                                    className="text-sm resize-none"
                                  />
                                  {f.key && RESERVED_FIELD_KEYS.has(f.key) ? (
                                    <p className="text-[11px] text-destructive">
                                      This overlaps with a built-in field (name, phone, service, date, or time) and will be ignored — choose a different label.
                                    </p>
                                  ) : f.key && (
                                    <p className="text-[11px] text-muted-foreground font-mono">key: {f.key}</p>
                                  )}
                                </div>
                                <Button variant="ghost" size="icon" onClick={() => removeCustomField(i)} className="text-muted-foreground hover:text-destructive shrink-0 mt-0.5">
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </>
          )}

          {/* Custom Tools */}
          {section === 'custom-tools' && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Custom Tools</h2>
                  <p className="text-sm text-muted-foreground">
                    Give the AI its own tools beyond Booking, Cancellation, and Reschedule — e.g. an
                    &quot;Intake Form&quot; or &quot;Callback Request&quot;. Each tool collects only the
                    fields you define here, and every submission is saved and mirrored to your Google
                    Sheet (if connected) so it&apos;s ready to feed into any CRM.
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={addCustomTool}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />Add Custom Tool
                </Button>
              </div>

              <div className="space-y-3">
                {customTools.length === 0 && (
                  <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                      <Wrench className="h-9 w-9 opacity-25" />
                      <p className="text-sm font-medium">No custom tools yet</p>
                      <p className="text-xs text-center max-w-xs">
                        Add a tool like &quot;Intake Form&quot; for the AI to use when a patient wants to
                        submit information that isn&apos;t part of booking.
                      </p>
                      <Button variant="outline" size="sm" className="mt-2" onClick={addCustomTool}>
                        <Plus className="h-3.5 w-3.5 mr-1.5" />Add First Tool
                      </Button>
                    </CardContent>
                  </Card>
                )}
                {customTools.map((t, i) => (
                  <Card key={i}>
                    <CardContent className="pt-4 pb-4 space-y-3">
                      <div className="flex items-start gap-3">
                        <div className="flex-1 space-y-2">
                          <Input
                            placeholder="Tool name — e.g. Intake Form"
                            value={t.name}
                            onChange={(e) => updateCustomToolName(i, e.target.value)}
                            className="font-medium"
                          />
                          <Textarea
                            placeholder="When should the AI use this? — e.g. Use when a new patient wants to submit intake info before their visit."
                            value={t.trigger_instruction}
                            onChange={(e) => updateCustomToolTrigger(i, e.target.value)}
                            rows={2}
                            className="text-sm resize-none"
                          />
                          {t.tool_key && (
                            <p className="text-[11px] text-muted-foreground font-mono">key: {t.tool_key}</p>
                          )}
                        </div>
                        <div className="flex flex-col items-center gap-2 shrink-0">
                          <Switch checked={t.enabled} onCheckedChange={(v) => toggleCustomToolEnabled(i, v)} />
                          <Button variant="ghost" size="icon" onClick={() => removeCustomTool(i)} className="text-muted-foreground hover:text-destructive">
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      <Separator />

                      <div className="space-y-2 pl-1">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs text-muted-foreground">Fields this tool collects</Label>
                          <Button variant="ghost" size="sm" onClick={() => addCustomToolField(i)}>
                            <Plus className="h-3 w-3 mr-1" />Add Field
                          </Button>
                        </div>
                        {t.fields.map((f, j) => (
                          <div key={j} className="flex items-start gap-2">
                            <div className="flex-1 space-y-1.5">
                              <Input
                                placeholder="Field label — e.g. Allergies"
                                value={f.label}
                                onChange={(e) => updateCustomToolField(i, j, e.target.value)}
                                className="text-sm"
                              />
                              <Textarea
                                placeholder="What should the AI ask? — e.g. Ask if they have any known allergies."
                                value={f.instruction}
                                onChange={(e) => updateCustomToolFieldInstruction(i, j, e.target.value)}
                                rows={2}
                                className="text-sm resize-none"
                              />
                            </div>
                            <Button variant="ghost" size="icon" onClick={() => removeCustomToolField(i, j)} className="text-muted-foreground hover:text-destructive shrink-0 mt-0.5">
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          )}

          {/* Knowledge Base */}
          {section === 'knowledge' && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Knowledge Base</h2>
                  <p className="text-sm text-muted-foreground">Documents the AI uses to answer customer questions</p>
                </div>
                <div className="flex items-center gap-2">
                  {faq.length > 0 && (
                    <Button variant="ghost" size="sm" onClick={clearAllFaq} className="text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-3.5 w-3.5 mr-1.5" />Clear All
                    </Button>
                  )}
                  <label className="inline-flex">
                    <input
                      type="file" accept=".pdf,.md,.txt,.json" className="hidden" disabled={uploadingFaq}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFaqDocument(f); e.target.value = '' }}
                    />
                    <span className={cn(
                      'inline-flex items-center gap-1.5 text-sm border rounded-md px-3 py-1.5 cursor-pointer hover:bg-accent',
                      uploadingFaq && 'opacity-60 pointer-events-none'
                    )}>
                      {uploadingFaq ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      {uploadingFaq ? 'Extracting…' : 'Upload Document'}
                    </span>
                  </label>
                </div>
              </div>
              <p className="text-xs text-muted-foreground -mt-2">
                Upload a PDF, Markdown, text, or JSON file (up to 7MB) — the AI reads it and starts using it right away,
                no extra step needed.
              </p>

              <div className="space-y-3">
                {faq.length === 0 && (
                  <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                      <BookOpen className="h-9 w-9 opacity-25" />
                      <p className="text-sm font-medium">Nothing uploaded yet</p>
                      <p className="text-xs text-center max-w-xs">Upload a document — clinic hours, pricing, services, policies — and the AI will learn from it automatically.</p>
                    </CardContent>
                  </Card>
                )}
                {faq.length > 0 && (
                  <Card>
                    <CardContent className="pt-4 pb-4 divide-y">
                      {faq.map((item, i) => (
                        <div key={i} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{item.q}</p>
                            <p className="text-xs text-muted-foreground line-clamp-2">{item.a}</p>
                          </div>
                          <Button variant="ghost" size="icon" onClick={() => removeFaq(i)} className="text-muted-foreground hover:text-destructive shrink-0 h-7 w-7">
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}
              </div>
            </>
          )}

          {/* Handoff */}
          {section === 'handoff' && (
            <>
              <div>
                <h2 className="text-lg font-semibold">Human Handoff</h2>
                <p className="text-sm text-muted-foreground">Control when and how the AI hands over to a staff member</p>
              </div>

              <Card>
                <CardContent className="pt-4 space-y-5">
                  <div className="flex items-center justify-between p-3 bg-muted/40 rounded-lg">
                    <div>
                      <p className="font-medium text-sm">Enable human takeover</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Staff can take over any WhatsApp conversation from the AI</p>
                    </div>
                    <Switch checked={humanTakeover} onCheckedChange={setHumanTakeover} />
                  </div>

                  {humanTakeover && (
                    <>
                      <Separator />
                      <div className="space-y-3">
                        <div>
                          <Label>Escalation Keywords</Label>
                          <p className="text-xs text-muted-foreground mt-0.5">AI auto-escalates when any of these phrases appear in the conversation</p>
                        </div>
                        <div className="flex gap-2">
                          <Input
                            placeholder="Add a keyword or phrase..."
                            value={keywordsInput}
                            onChange={(e) => setKeywordsInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKeyword() } }}
                          />
                          <Button variant="outline" onClick={addKeyword}>Add</Button>
                        </div>
                        {escalationKeywords.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 pt-1">
                            {escalationKeywords.map((kw) => (
                              <Badge key={kw} variant="secondary"
                                className="gap-1 cursor-pointer hover:bg-destructive/10 hover:text-destructive transition-colors"
                                onClick={() => removeKeyword(kw)}
                              >
                                {kw} <span className="opacity-50">×</span>
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>

                      <Separator />

                      <div className="space-y-2">
                        <Label>Max turns before offering a human</Label>
                        <p className="text-xs text-muted-foreground">After this many messages, the AI will suggest connecting a staff member</p>
                        <div className="flex items-center gap-3">
                          <Input id="max-turns" type="number" min={1} max={50} value={maxTurns}
                            onChange={(e) => setMaxTurns(parseInt(e.target.value) || 10)}
                            className="w-28"
                          />
                          <span className="text-xs text-muted-foreground">messages</span>
                        </div>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 p-4">
                <p className="text-sm font-semibold text-blue-800 dark:text-blue-300">How to take over a conversation</p>
                <p className="text-sm text-blue-700 dark:text-blue-400 mt-1">
                  Open <strong>WhatsApp</strong> from the sidebar, select a conversation, then click <strong>Take Over</strong>. The AI pauses instantly and your typed messages go directly to the customer. Click <strong>Hand Back to AI</strong> when done.
                </p>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  )
}
