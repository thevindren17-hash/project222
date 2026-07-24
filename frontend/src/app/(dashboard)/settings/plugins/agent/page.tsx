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
import { LLM_PROVIDERS, VOICE_STT_PROVIDERS, VOICE_TTS_PROVIDERS, VOICE_LANGUAGES } from '@/lib/providers'
import {
  Loader2, Bot, BookOpen, Zap, Users, Code, Eye, Plus, Trash2, Brain, Mic, Sparkles, Key, Check, Languages,
  Volume2, Play, ExternalLink, CheckCircle2, Database, Wrench, Upload,
} from 'lucide-react'

const SERVICES = [
  'Scaling & Cleaning', 'Dental Checkup', 'Teeth Whitening', 'Tooth Extraction',
  'Braces & Orthodontics', 'Root Canal', 'Dental Crown', 'Dental Implant', 'Other',
]

const TOOL_LABELS: Record<string, { label: string; desc: string }> = {
  book_appointment: { label: 'Book Appointments', desc: 'AI can create new appointment bookings' },
  check_slots: { label: 'Check Available Slots', desc: 'AI can look up free appointment times' },
  lookup_patient: { label: 'Look Up Patient Records', desc: 'AI can check if a caller is an existing patient by phone number (read-only)' },
  get_faq: { label: 'Look Up FAQ', desc: 'AI references your knowledge base when answering' },
  escalate: { label: 'Escalate to Human', desc: 'AI can hand off conversations to staff' },
}

const SECTIONS = [
  { id: 'instructions', label: 'Instructions', icon: Code },
  { id: 'model', label: 'Model Settings', icon: Brain },
  { id: 'fields', label: 'Data Fields', icon: Database },
  { id: 'custom-tools', label: 'Custom Tools', icon: Wrench },
  { id: 'knowledge', label: 'Knowledge Base', icon: BookOpen },
  { id: 'language', label: 'Language', icon: Languages },
  { id: 'voice', label: 'Voice', icon: Mic },
  { id: 'handoff', label: 'Handoff', icon: Users },
  { id: 'capabilities', label: 'Capabilities', icon: Zap },
]

const LLM_CRED_FIELDS: Record<string, { placeholder: string }> = {
  groq: { placeholder: 'gsk_...' },
  openai: { placeholder: 'sk-...' },
  anthropic: { placeholder: 'sk-ant-...' },
  google: { placeholder: 'AIza...' },
  mistral: { placeholder: 'your-mistral-key' },
}

interface FaqItem { q: string; a: string }
type CustomFieldAction = 'book_appointment' | 'cancel_appointment' | 'reschedule_appointment'
interface CustomFieldItem { key: string; label: string; instruction: string; action: CustomFieldAction }

const CUSTOM_FIELD_ACTIONS: { value: CustomFieldAction; label: string }[] = [
  { value: 'book_appointment', label: 'Booking' },
  { value: 'cancel_appointment', label: 'Cancellation' },
  { value: 'reschedule_appointment', label: 'Reschedule' },
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

// The 5 fields every booking always needs — only the wording is editable
// per clinic (e.g. a legal office renaming "Service" to "Case Type"). The
// underlying contact_name/contact_phone/service_type/date/time keys the AI
// passes to the tool never change, since booking storage depends on them.
const BASE_FIELD_DEFS: { key: string; defaultLabel: string; placeholder: string }[] = [
  { key: 'contact_name', defaultLabel: 'Full Name', placeholder: 'e.g. Patient Name, Client Name' },
  { key: 'contact_phone', defaultLabel: 'Phone Number', placeholder: 'e.g. Contact Number, WhatsApp Number' },
  { key: 'service_type', defaultLabel: 'Service', placeholder: 'e.g. Case Type, Treatment, Package' },
  { key: 'date', defaultLabel: 'Date', placeholder: 'e.g. Preferred Date' },
  { key: 'time', defaultLabel: 'Time', placeholder: 'e.g. Preferred Time' },
]

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

  const [temperature, setTemperature] = useState(0.7)
  const [maxTokens, setMaxTokens] = useState(1024)
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

  const [voiceReplyEnabled, setVoiceReplyEnabled] = useState(false)
  const [voiceTtsProvider, setVoiceTtsProvider] = useState('openai')
  const [voiceTtsVoiceMap, setVoiceTtsVoiceMap] = useState<Record<string, string>>({})
  const [voiceSttProvider, setVoiceSttProvider] = useState('openai')
  const [newVoiceSttKey, setNewVoiceSttKey] = useState('')
  const [newVoiceTtsKey, setNewVoiceTtsKey] = useState('')
  const [previewLoading, setPreviewLoading] = useState<string | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
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
      setTemperature(settings.llm_config?.temperature ?? 0.7)
      setMaxTokens(settings.llm_config?.max_tokens ?? 1024)
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
        llm_config: { provider: llmProvider, model: llmModel, temperature, max_tokens: maxTokens },
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

  async function playVoicePreview(provider: string, voiceId: string, language: string) {
    if (!tenant || !voiceId) return
    const key = `${language}:${voiceId}`
    setPreviewLoading(key)
    try {
      const res = await fetch('/api/voice-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenant.id, provider, voice_id: voiceId, language }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast.error(data.error || 'Preview failed')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      previewAudioRef.current?.pause()
      const audio = new Audio(url)
      previewAudioRef.current = audio
      await audio.play()
    } catch {
      toast.error('Network error')
    } finally {
      setPreviewLoading(null)
    }
  }

  function toggleService(service: string) {
    setSelectedServices((prev) =>
      prev.includes(service) ? prev.filter((s) => s !== service) : [...prev, service]
    )
  }
  function addFaq() { setFaq([...faq, { q: '', a: '' }]) }
  function updateFaq(i: number, field: 'q' | 'a', value: string) {
    const next = [...faq]; next[i] = { ...next[i], [field]: value }; setFaq(next)
  }
  function removeFaq(i: number) { setFaq(faq.filter((_, idx) => idx !== i)) }

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
      if (!res.ok) throw new Error(data.error || 'Could not extract Q&A from that document')
      setFaq([...faq, ...(data.faq || [])])
      toast.success(
        `Added ${data.faq?.length || 0} entries from "${file.name}" — review them below, then Save Changes`
        + (data.truncated ? ' (only the first part of the document was used)' : '')
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploadingFaq(false)
    }
  }
  function addCustomField() { setCustomFields([...customFields, { key: '', label: '', instruction: '', action: 'book_appointment' }]) }
  function updateCustomFieldLabel(i: number, label: string) {
    const next = [...customFields]
    next[i] = { ...next[i], label, key: slugifyFieldKey(label) }
    setCustomFields(next)
  }
  function updateCustomFieldInstruction(i: number, instruction: string) {
    const next = [...customFields]; next[i] = { ...next[i], instruction }; setCustomFields(next)
  }
  function updateCustomFieldAction(i: number, action: CustomFieldAction) {
    const next = [...customFields]; next[i] = { ...next[i], action }; setCustomFields(next)
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
  function updateBaseFieldLabel(key: string, value: string) {
    setBaseFieldLabels((prev) => ({ ...prev, [key]: value }))
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
                  <div className="grid grid-cols-5 gap-2">
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
                    <p className="text-xs text-muted-foreground">Limits how long each AI reply can be (128–4096)</p>
                    <div className="flex items-center gap-3">
                      <Input id="max-tokens" type="number" min={128} max={4096} step={128} value={maxTokens}
                        onChange={(e) => setMaxTokens(parseInt(e.target.value) || 1024)}
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
                <h2 className="text-lg font-semibold">Base Field Labels</h2>
                <p className="text-sm text-muted-foreground">
                  Every booking always collects these 5 — only the wording is yours to change. Leave blank
                  to use the default. This is what the AI calls the field when asking, and what shows up in
                  the booking record — it doesn't affect anything technical underneath.
                </p>
              </div>
              <Card>
                <CardContent className="pt-4 pb-4 space-y-3">
                  {BASE_FIELD_DEFS.map((f) => (
                    <div key={f.key} className="grid grid-cols-[140px_1fr] items-center gap-3">
                      <Label className="text-sm text-muted-foreground">{f.defaultLabel}</Label>
                      <Input
                        placeholder={f.placeholder}
                        value={baseFieldLabels[f.key] || ''}
                        onChange={(e) => updateBaseFieldLabel(f.key, e.target.value)}
                      />
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Separator />

              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold">Data Fields</h2>
                  <p className="text-sm text-muted-foreground">
                    Extra questions the AI asks for Booking, Cancellation, or Reschedule — on top of the usual
                    name, phone, service, date, and time. Each field belongs to one action, since that's the
                    specific moment the AI actually asks for it. Captured values are saved with the booking
                    and, if connected, mirrored to your Google Sheet.
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={addCustomField}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />Add Field
                </Button>
              </div>

              <div className="space-y-3">
                {customFields.length === 0 && (
                  <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                      <Database className="h-9 w-9 opacity-25" />
                      <p className="text-sm font-medium">No custom fields yet</p>
                      <p className="text-xs text-center max-w-xs">
                        Add a field like &quot;Insurance Provider&quot; or &quot;Referral Source&quot; for the AI to ask about during booking.
                      </p>
                      <Button variant="outline" size="sm" className="mt-2" onClick={addCustomField}>
                        <Plus className="h-3.5 w-3.5 mr-1.5" />Add First Field
                      </Button>
                    </CardContent>
                  </Card>
                )}
                {customFields.map((f, i) => (
                  <Card key={i}>
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-start gap-3">
                        <div className="flex-1 space-y-2">
                          <div className="flex items-center gap-2">
                            <Input
                              placeholder="Field label — e.g. Insurance Provider"
                              value={f.label}
                              onChange={(e) => updateCustomFieldLabel(i, e.target.value)}
                              className="font-medium flex-1"
                            />
                            <Select value={f.action} onValueChange={(v) => updateCustomFieldAction(i, v as CustomFieldAction)}>
                              <SelectTrigger className="w-[150px] shrink-0">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {CUSTOM_FIELD_ACTIONS.map((a) => (
                                  <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <Textarea
                            placeholder="What should the AI ask? — e.g. Ask if they have insurance and which provider."
                            value={f.instruction}
                            onChange={(e) => updateCustomFieldInstruction(i, e.target.value)}
                            rows={2}
                            className="text-sm resize-none"
                          />
                          {f.key && RESERVED_FIELD_KEYS.has(f.key) ? (
                            <p className="text-[11px] text-destructive">
                              This overlaps with a built-in field and will be ignored — rename it under{' '}
                              <span className="font-medium">Base Field Labels</span> above instead.
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
                  <p className="text-sm text-muted-foreground">Q&amp;A pairs the AI uses to answer customer questions</p>
                </div>
                <div className="flex items-center gap-2">
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
                  <Button variant="outline" size="sm" onClick={addFaq}>
                    <Plus className="h-3.5 w-3.5 mr-1.5" />Add Entry
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground -mt-2">
                Upload a PDF, Markdown, text, or JSON file (up to 7MB) and AI will pull out Q&amp;A pairs automatically —
                review and edit them below before saving.
              </p>

              <div className="space-y-3">
                {faq.length === 0 && (
                  <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                      <BookOpen className="h-9 w-9 opacity-25" />
                      <p className="text-sm font-medium">No entries yet</p>
                      <p className="text-xs text-center max-w-xs">Add common questions your customers ask, like clinic hours, pricing, parking, or location.</p>
                      <Button variant="outline" size="sm" className="mt-2" onClick={addFaq}>
                        <Plus className="h-3.5 w-3.5 mr-1.5" />Add First Entry
                      </Button>
                    </CardContent>
                  </Card>
                )}
                {faq.map((item, i) => (
                  <Card key={i}>
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-start gap-3">
                        <div className="flex-1 space-y-2">
                          <Input
                            placeholder="Question — e.g. What are your opening hours?"
                            value={item.q}
                            onChange={(e) => updateFaq(i, 'q', e.target.value)}
                            className="font-medium"
                          />
                          <Textarea
                            placeholder="Answer — e.g. We are open Mon–Fri 9am–6pm, Sat 9am–1pm, closed Sunday."
                            value={item.a}
                            onChange={(e) => updateFaq(i, 'a', e.target.value)}
                            rows={2}
                            className="text-sm resize-none"
                          />
                        </div>
                        <Button variant="ghost" size="icon" onClick={() => removeFaq(i)} className="text-muted-foreground hover:text-destructive shrink-0 mt-0.5">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
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

          {/* Language */}
          {section === 'language' && (
            <>
              <div>
                <h2 className="text-lg font-semibold">Language Settings</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Control which language your AI agent uses. Malaysians often write Manglish (mixed English + Malay) — set a strict policy to avoid confusion.
                </p>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Languages className="h-4 w-4 text-primary" />
                    Reply Language Policy
                  </CardTitle>
                  <CardDescription>Choose how the AI decides which language to reply in.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {[
                    {
                      value: 'ask',
                      label: 'Ask user at start of conversation',
                      desc: 'AI greets and asks "English, Bahasa Melayu, or Chinese?" before doing anything else. Recommended for Malaysian clinics.',
                    },
                    {
                      value: 'ms',
                      label: 'Always Bahasa Melayu',
                      desc: 'AI always replies in Bahasa Melayu regardless of what language the user writes in.',
                    },
                    {
                      value: 'en',
                      label: 'Always English',
                      desc: 'AI always replies in English regardless of what language the user writes in.',
                    },
                    {
                      value: 'zh',
                      label: 'Always Mandarin Chinese',
                      desc: 'AI always replies in Mandarin Chinese regardless of what language the user writes in.',
                    },
                  ].map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setReplyLanguage(opt.value)}
                      className={cn(
                        'w-full text-left p-3 rounded-xl border-2 transition-all',
                        replyLanguage === opt.value
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:border-muted-foreground/40'
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div className={cn(
                          'mt-0.5 h-4 w-4 rounded-full border-2 shrink-0 flex items-center justify-center',
                          replyLanguage === opt.value ? 'border-primary' : 'border-muted-foreground/40'
                        )}>
                          {replyLanguage === opt.value && (
                            <div className="h-2 w-2 rounded-full bg-primary" />
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-medium">{opt.label}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{opt.desc}</p>
                        </div>
                      </div>
                    </button>
                  ))}
                </CardContent>
              </Card>

              {replyLanguage === 'ask' && (
                <div className="rounded-xl bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-4 text-sm text-blue-800 dark:text-blue-300">
                  <p className="font-semibold mb-1">How "Ask user" works</p>
                  <p className="text-xs leading-relaxed">
                    When a new WhatsApp conversation starts, the AI will greet the user and ask which language they prefer (English, Bahasa Melayu, or Chinese) before doing anything else.
                    Once the user replies (e.g. "English", "BM", or "Chinese"), the AI uses that language for the rest of the conversation.
                    This is the best option for Malaysia where users freely mix English and Malay (Manglish).
                  </p>
                </div>
              )}
            </>
          )}

          {/* Voice */}
          {section === 'voice' && (
            <>
              <div>
                <h2 className="text-lg font-semibold">Voice Messages</h2>
                <p className="text-sm text-muted-foreground">Let customers send voice notes — AI transcribes and replies with voice</p>
              </div>

              <Card>
                <CardContent className="pt-4 space-y-5">
                  <div className="flex items-center justify-between p-3 bg-muted/40 rounded-lg">
                    <div>
                      <p className="font-medium text-sm">Enable voice replies</p>
                      <p className="text-xs text-muted-foreground mt-0.5">AI receives voice notes, transcribes them, and replies with a voice message</p>
                    </div>
                    <Switch checked={voiceReplyEnabled} onCheckedChange={setVoiceReplyEnabled} />
                  </div>

                  {voiceReplyEnabled && (
                    <>
                      <Separator />

                      {/* STT provider picker */}
                      <div className="space-y-3">
                        <div>
                          <Label className="flex items-center gap-1.5 text-sm font-medium">
                            <Mic className="h-3.5 w-3.5" />Speech-to-Text
                          </Label>
                          <p className="text-xs text-muted-foreground">How incoming voice messages are converted to text</p>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {VOICE_STT_PROVIDERS.map((p) => {
                            const active = voiceSttProvider === p.provider
                            return (
                              <button
                                key={p.provider}
                                type="button"
                                onClick={() => setVoiceSttProvider(p.provider)}
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
                                {p.badge && <Badge variant="secondary" className="text-[10px] w-fit">{p.badge}</Badge>}
                                <span className="text-[11px] text-muted-foreground leading-snug">{p.description}</span>
                              </button>
                            )
                          })}
                        </div>
                        {(() => {
                          const selected = VOICE_STT_PROVIDERS.find((p) => p.provider === voiceSttProvider)
                          if (!selected) return null
                          return (
                            <div className="space-y-1.5 max-w-sm">
                              <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                                <Key className="h-3 w-3" />API Key
                                {credExistence?.[voiceSttProvider] && !newVoiceSttKey && (
                                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5 text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800">
                                    <Check className="h-2.5 w-2.5" />Key saved
                                  </Badge>
                                )}
                                <a href={selected.keyUrl} target="_blank" rel="noopener noreferrer" className="ml-auto text-[11px] text-primary flex items-center gap-1 hover:underline">
                                  Get key <ExternalLink className="h-2.5 w-2.5" />
                                </a>
                              </Label>
                              <Input
                                type="password"
                                placeholder={credExistence?.[voiceSttProvider] ? 'Enter new key to replace…' : selected.keyPlaceholder}
                                value={newVoiceSttKey}
                                onChange={(e) => setNewVoiceSttKey(e.target.value)}
                              />
                            </div>
                          )
                        })()}
                      </div>

                      <Separator />

                      {/* TTS provider picker */}
                      <div className="space-y-3">
                        <div>
                          <Label className="flex items-center gap-1.5 text-sm font-medium">
                            <Volume2 className="h-3.5 w-3.5" />AI Voice
                          </Label>
                          <p className="text-xs text-muted-foreground">The voice used when the AI speaks back — one per language</p>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          {VOICE_TTS_PROVIDERS.map((p) => {
                            const active = voiceTtsProvider === p.provider
                            return (
                              <button
                                key={p.provider}
                                type="button"
                                onClick={() => setVoiceTtsProvider(p.provider)}
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
                                {p.badge && (
                                  <Badge variant="outline" className="text-[10px] w-fit text-primary border-primary/30">{p.badge}</Badge>
                                )}
                              </button>
                            )
                          })}
                        </div>
                        {(() => {
                          const selected = VOICE_TTS_PROVIDERS.find((p) => p.provider === voiceTtsProvider)
                          if (!selected) return null
                          const hasKey = !!credExistence?.[voiceTtsProvider]
                          return (
                            <>
                              <div className="space-y-1.5 max-w-sm">
                                <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                                  <Key className="h-3 w-3" />API Key
                                  {hasKey && !newVoiceTtsKey && (
                                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5 text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800">
                                      <Check className="h-2.5 w-2.5" />Key saved
                                    </Badge>
                                  )}
                                  <a href={selected.keyUrl} target="_blank" rel="noopener noreferrer" className="ml-auto text-[11px] text-primary flex items-center gap-1 hover:underline">
                                    Get key <ExternalLink className="h-2.5 w-2.5" />
                                  </a>
                                </Label>
                                <Input
                                  type="password"
                                  placeholder={hasKey ? 'Enter new key to replace…' : selected.keyPlaceholder}
                                  value={newVoiceTtsKey}
                                  onChange={(e) => setNewVoiceTtsKey(e.target.value)}
                                />
                              </div>

                              <div className="space-y-2 pt-1">
                                {VOICE_LANGUAGES.map((lang) => {
                                  const voices = selected.voicesByLanguage[lang.code] || []
                                  const currentVoiceId = voiceTtsVoiceMap[lang.code] || voices[0]?.id || ''
                                  const previewKey = `${lang.code}:${currentVoiceId}`
                                  return (
                                    <div key={lang.code} className="flex items-center gap-2 rounded-lg border p-2.5">
                                      <span className="text-xs font-medium w-28 shrink-0">{lang.name}</span>
                                      <Select
                                        value={currentVoiceId}
                                        onValueChange={(v) => v && setVoiceTtsVoiceMap({ ...voiceTtsVoiceMap, [lang.code]: v })}
                                      >
                                        <SelectTrigger className="h-8 text-xs flex-1"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                          {voices.map((v) => (
                                            <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="icon"
                                        className="h-8 w-8 shrink-0"
                                        disabled={!hasKey || previewLoading === previewKey}
                                        title={hasKey ? 'Preview this voice' : 'Add an API key above first'}
                                        onClick={() => playVoicePreview(voiceTtsProvider, currentVoiceId, lang.code)}
                                      >
                                        {previewLoading === previewKey
                                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                          : <Play className="h-3.5 w-3.5" />}
                                      </Button>
                                    </div>
                                  )
                                })}
                              </div>
                            </>
                          )
                        })()}
                      </div>

                      <Separator />

                      <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4">
                        <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">Requirements</p>
                        <ul className="mt-1 space-y-0.5 text-sm text-amber-700 dark:text-amber-400">
                          <li>• Add an API key above for whichever STT and TTS provider you pick — same key store as <strong>Model Settings</strong>, so a Groq key you&apos;ve already saved there works here too</li>
                          <li>• Works with WhatsApp voice notes (OGG/Opus format)</li>
                          <li>• Each voice exchange uses a small amount of API credit, depending on the provider</li>
                        </ul>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/30 p-4">
                <p className="text-sm font-semibold text-blue-800 dark:text-blue-300">How voice messages work</p>
                <p className="text-sm text-blue-700 dark:text-blue-400 mt-1">
                  Customer sends a WhatsApp voice note → AI transcribes it → generates a reply → sends back a voice note.
                  If voice reply is disabled, the AI still reads the voice note but replies as text.
                </p>
              </div>
            </>
          )}

          {/* Capabilities */}
          {section === 'capabilities' && (
            <>
              <div>
                <h2 className="text-lg font-semibold">Capabilities</h2>
                <p className="text-sm text-muted-foreground">Choose which actions your AI is allowed to perform</p>
              </div>

              <Card>
                <CardContent className="pt-4 space-y-2">
                  {Object.entries(TOOL_LABELS).map(([key, { label, desc }]) => (
                    <div key={key} className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/30 transition-colors">
                      <div>
                        <p className="text-sm font-medium">{label}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
                      </div>
                      <Switch
                        checked={toolConfig[key] ?? false}
                        onCheckedChange={(v) => setToolConfig({ ...toolConfig, [key]: v })}
                      />
                    </div>
                  ))}
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
