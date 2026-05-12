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
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Checkbox } from '@/components/ui/checkbox'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  Loader2, Bot, BookOpen, Zap, Users, Code, Eye, Plus, Trash2, Brain,
} from 'lucide-react'

const SERVICES = [
  'Scaling & Cleaning', 'Dental Checkup', 'Teeth Whitening', 'Tooth Extraction',
  'Braces & Orthodontics', 'Root Canal', 'Dental Crown', 'Dental Implant', 'Other',
]

const TOOL_LABELS: Record<string, { label: string; desc: string }> = {
  book_appointment: { label: 'Book Appointments', desc: 'AI can create new appointment bookings' },
  check_slots: { label: 'Check Available Slots', desc: 'AI can look up free appointment times' },
  get_faq: { label: 'Look Up FAQ', desc: 'AI references your knowledge base when answering' },
  escalate: { label: 'Escalate to Human', desc: 'AI can hand off conversations to staff' },
}

const SECTIONS = [
  { id: 'instructions', label: 'Instructions', icon: Code },
  { id: 'model', label: 'Model Settings', icon: Brain },
  { id: 'knowledge', label: 'Knowledge Base', icon: BookOpen },
  { id: 'handoff', label: 'Handoff', icon: Users },
  { id: 'capabilities', label: 'Capabilities', icon: Zap },
]

interface FaqItem { q: string; a: string }

export default function AgentPluginPage() {
  const queryClient = useQueryClient()
  const [section, setSection] = useState('instructions')

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

  const [agentName, setAgentName] = useState('Maya')
  const [clinicName, setClinicName] = useState('')
  const [clinicTagline, setClinicTagline] = useState('')
  const [tone, setTone] = useState('friendly')

  const [rawMode, setRawMode] = useState(false)
  const [rawPrompt, setRawPrompt] = useState('')
  const [selectedServices, setSelectedServices] = useState<string[]>([])
  const [specialInstructions, setSpecialInstructions] = useState('')
  const [neverSay, setNeverSay] = useState('')

  const [temperature, setTemperature] = useState(0.7)
  const [maxTokens, setMaxTokens] = useState(1024)
  const [toolConfig, setToolConfig] = useState<Record<string, boolean>>({
    book_appointment: true, check_slots: true, get_faq: true, escalate: true,
  })

  const [faq, setFaq] = useState<FaqItem[]>([])

  const [humanTakeover, setHumanTakeover] = useState(true)
  const [escalationKeywords, setEscalationKeywords] = useState<string[]>([
    'urgent', 'emergency', 'speak to human', 'real person',
  ])
  const [keywordsInput, setKeywordsInput] = useState('')
  const [maxTurns, setMaxTurns] = useState(10)

  useEffect(() => {
    if (tenant) setClinicName(tenant.name || '')
    if (settings) {
      setAgentName(settings.agent_name || 'Maya')
      setRawPrompt(settings.system_prompt || '')
      setTemperature(settings.llm_config?.temperature ?? 0.7)
      setMaxTokens(settings.llm_config?.max_tokens ?? 1024)
      setToolConfig(settings.tool_config || { book_appointment: true, check_slots: true, get_faq: true, escalate: true })
      setHumanTakeover(settings.tool_config?.escalate ?? true)
      setFaq(settings.faq || [])
      if (settings.escalation_keywords?.length) setEscalationKeywords(settings.escalation_keywords)
      if (settings.max_turns_before_handoff) setMaxTurns(settings.max_turns_before_handoff)
    }
  }, [tenant, settings])

  function buildSystemPrompt() {
    const serviceList = selectedServices.length
      ? selectedServices.map((s) => `- ${s}`).join('\n')
      : '- General dental services'
    return [
      `You are ${agentName}, an AI receptionist for ${clinicName}${clinicTagline ? ` — ${clinicTagline}` : ''}.`,
      '',
      'Your job:',
      '- Book, reschedule, and cancel appointments',
      '- Answer questions about clinic hours, location, services, and pricing',
      '- Transfer to a human when needed',
      '',
      'Services we offer:',
      serviceList,
      '',
      `Tone: ${tone.charAt(0).toUpperCase() + tone.slice(1)}`,
      ...(specialInstructions ? ['', 'Special instructions:', specialInstructions] : []),
      ...(neverSay ? ['', 'Never say:', neverSay] : []),
      '',
      'Always confirm appointment details before booking. Ask for patient name and phone number.',
      'Escalate to human when: patient requests human, complex clinical questions, complaints, payment issues.',
    ].join('\n').trim()
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      const { error } = await supabase.from('tenant_settings').upsert({
        tenant_id: tenant.id,
        agent_name: agentName,
        system_prompt: rawMode ? rawPrompt : buildSystemPrompt(),
        llm_config: { ...(settings?.llm_config || {}), temperature, max_tokens: maxTokens },
        tool_config: { ...toolConfig, escalate: humanTakeover },
        faq,
        escalation_keywords: escalationKeywords,
        max_turns_before_handoff: maxTurns,
      }, { onConflict: 'tenant_id' })
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Agent configuration saved')
      queryClient.invalidateQueries({ queryKey: ['tenant-settings'] })
      queryClient.invalidateQueries({ queryKey: ['plugin-status'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

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
  function addKeyword() {
    const kw = keywordsInput.trim().toLowerCase()
    if (kw && !escalationKeywords.includes(kw)) setEscalationKeywords([...escalationKeywords, kw])
    setKeywordsInput('')
  }
  function removeKeyword(kw: string) {
    setEscalationKeywords(escalationKeywords.filter((k) => k !== kw))
  }

  const provider = settings?.llm_config?.provider || 'groq'

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
                  <Badge variant="secondary" className="text-xs px-2 py-0.5 capitalize">{provider}</Badge>
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
                  <p className="text-sm text-muted-foreground">Define what your AI knows and how it behaves</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => {
                  if (!rawMode) setRawPrompt(buildSystemPrompt())
                  setRawMode(!rawMode)
                }}>
                  {rawMode ? <><Eye className="h-3.5 w-3.5 mr-1.5" />Guided</> : <><Code className="h-3.5 w-3.5 mr-1.5" />Raw Prompt</>}
                </Button>
              </div>

              {rawMode ? (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">System Prompt</CardTitle>
                    <CardDescription>This is sent to the AI before every conversation</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Textarea value={rawPrompt} onChange={(e) => setRawPrompt(e.target.value)} rows={20} className="font-mono text-sm" placeholder="Enter your system prompt..." />
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
                      <CardTitle className="text-base">Custom Instructions</CardTitle>
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
                      <CardTitle className="text-sm flex items-center gap-2"><Eye className="h-3.5 w-3.5" />Prompt Preview</CardTitle>
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
                <p className="text-sm text-muted-foreground">Control how the AI generates responses</p>
              </div>

              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Parameters</CardTitle>
                  <CardDescription>To change provider or model, go to Settings → AI Providers</CardDescription>
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

                  <Separator />

                  <div className="flex items-center gap-3 p-3 bg-muted/40 rounded-lg">
                    <Brain className="h-5 w-5 text-muted-foreground shrink-0" />
                    <div>
                      <p className="text-sm font-medium capitalize">{provider} — {settings?.llm_config?.model || 'default model'}</p>
                      <p className="text-xs text-muted-foreground">Change in Settings → AI Providers</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
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
                <Button variant="outline" size="sm" onClick={addFaq}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />Add Entry
                </Button>
              </div>

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
