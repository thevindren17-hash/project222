# Frontend Build Instructions — Part 2 (Continuation)

## Part 8: Calendar Page (⭐ Most Important)

### File: `/src/app/(dashboard)/calendar/page.tsx`

```typescript
'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin from '@fullcalendar/interaction'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import AddBookingModal from '@/components/calendar/add-booking-modal'
import BookingDetailModal from '@/components/calendar/booking-detail-modal'
import type { Booking } from '@/lib/types'
import { format } from 'date-fns'

export default function CalendarPage() {
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)

  const { data: bookings } = useQuery({
    queryKey: ['bookings'],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) throw new Error('No tenant')

      const { data, error } = await supabase
        .from('bookings')
        .select(`
          *,
          contact:contacts(*)
        `)
        .eq('tenant_id', tenant.id)
        .order('scheduled_at', { ascending: true })

      if (error) throw error
      return data as Booking[]
    },
  })

  // Transform bookings to FullCalendar events
  const events = bookings?.map((booking) => ({
    id: booking.id,
    title: `${booking.service_type} - ${booking.contact?.name || 'Unknown'}`,
    start: booking.scheduled_at,
    end: new Date(new Date(booking.scheduled_at).getTime() + booking.duration_minutes * 60000).toISOString(),
    backgroundColor: 
      booking.status === 'confirmed' ? '#22C55E' :
      booking.status === 'pending' ? '#F59E0B' :
      booking.status === 'cancelled' ? '#EF4444' : '#06B6D4',
    borderColor: 'transparent',
    extendedProps: {
      booking,
    },
  }))

  function handleEventClick(info: any) {
    setSelectedBooking(info.event.extendedProps.booking)
  }

  function handleDateClick(info: any) {
    setSelectedDate(new Date(info.dateStr))
    setShowAddModal(true)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Calendar</h1>
          <p className="text-muted-foreground">Manage appointments and bookings</p>
        </div>
        <Button onClick={() => setShowAddModal(true)}>
          Add Booking
        </Button>
      </div>

      <Card className="p-6">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="timeGridWeek"
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,timeGridDay'
          }}
          events={events}
          eventClick={handleEventClick}
          dateClick={handleDateClick}
          height="auto"
          slotMinTime="08:00:00"
          slotMaxTime="20:00:00"
          allDaySlot={false}
          nowIndicator={true}
          editable={true}
          selectable={true}
        />
      </Card>

      {/* Modals */}
      {selectedBooking && (
        <BookingDetailModal
          booking={selectedBooking}
          open={!!selectedBooking}
          onClose={() => setSelectedBooking(null)}
        />
      )}
      
      {showAddModal && (
        <AddBookingModal
          open={showAddModal}
          onClose={() => setShowAddModal(false)}
          defaultDate={selectedDate}
        />
      )}
    </div>
  )
}
```

---

## Part 9: Settings - AI Providers Plugin

### File: `/src/app/(dashboard)/settings/plugins/ai-providers/page.tsx`

```typescript
'use client'

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { Loader2, Sparkles, Mic, Volume2 } from 'lucide-react'
import { LLM_PROVIDERS, STT_PROVIDERS, TTS_PROVIDERS, LANGUAGES } from '@/lib/providers'

export default function AIProvidersPage() {
  const queryClient = useQueryClient()
  const { data: tenant } = useQuery({
    queryKey: ['tenant'],
    queryFn: getCurrentTenant,
  })

  const [llmProvider, setLlmProvider] = useState(tenant?.llm_config?.provider || 'groq')
  const [llmModel, setLlmModel] = useState(tenant?.llm_config?.model || 'llama-3.3-70b-versatile')
  const [sttConfig, setSttConfig] = useState(tenant?.stt_config || { en: 'deepgram', ms: 'whisper_groq', zh: 'deepgram' })
  const [ttsConfig, setTtsConfig] = useState(tenant?.tts_config || { en: 'cartesia', ms: 'elevenlabs', zh: 'elevenlabs' })

  useEffect(() => {
    if (tenant) {
      setLlmProvider(tenant.llm_config?.provider || 'groq')
      setLlmModel(tenant.llm_config?.model || 'llama-3.3-70b-versatile')
      setSttConfig(tenant.stt_config || { en: 'deepgram', ms: 'whisper_groq', zh: 'deepgram' })
      setTtsConfig(tenant.tts_config || { en: 'cartesia', ms: 'elevenlabs', zh: 'elevenlabs' })
    }
  }, [tenant])

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')

      const { error } = await supabase
        .from('tenants')
        .update({
          llm_config: { provider: llmProvider, model: llmModel },
          stt_config: sttConfig,
          tts_config: ttsConfig,
        })
        .eq('id', tenant.id)

      if (error) throw error
    },
    onSuccess: () => {
      toast.success('AI providers updated successfully')
      queryClient.invalidateQueries({ queryKey: ['tenant'] })
    },
    onError: (error: any) => {
      toast.error(error.message)
    },
  })

  const selectedLlmProvider = LLM_PROVIDERS.find(p => p.provider === llmProvider)
  const availableModels = selectedLlmProvider?.models || []

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">AI Providers</h1>
        <p className="text-muted-foreground">
          Configure LLM, speech-to-text, and text-to-speech providers
        </p>
      </div>

      {/* LLM Provider */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Large Language Model (LLM)
          </CardTitle>
          <CardDescription>
            The AI brain that understands and responds to conversations
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <RadioGroup value={llmProvider} onValueChange={setLlmProvider}>
            {LLM_PROVIDERS.map((provider) => (
              <div
                key={provider.provider}
                className="flex items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-muted/50 transition-colors"
              >
                <RadioGroupItem value={provider.provider} id={provider.provider} />
                <div className="flex-1">
                  <Label htmlFor={provider.provider} className="font-semibold cursor-pointer flex items-center gap-2">
                    {provider.name}
                    {provider.recommended && (
                      <Badge variant="secondary" className="text-xs">Recommended</Badge>
                    )}
                  </Label>
                  <p className="text-sm text-muted-foreground mt-1">
                    {provider.description}
                  </p>
                  <p className="text-xs text-muted-foreground mt-2">
                    Est. cost: {provider.estimatedCostPerCall} per call
                  </p>
                </div>
              </div>
            ))}
          </RadioGroup>

          {availableModels.length > 0 && (
            <div className="space-y-2">
              <Label>Model</Label>
              <Select value={llmModel} onValueChange={setLlmModel}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableModels.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      {/* STT Provider */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mic className="h-5 w-5 text-primary" />
            Speech-to-Text (STT)
          </CardTitle>
          <CardDescription>
            Converts voice to text for each language
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {LANGUAGES.map((lang) => (
              <div key={lang.code} className="flex items-center justify-between p-4 border rounded-md">
                <div>
                  <Label className="font-semibold">{lang.name}</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Language code: {lang.code}
                  </p>
                </div>
                <Select
                  value={sttConfig[lang.code]}
                  onValueChange={(value) => setSttConfig({ ...sttConfig, [lang.code]: value })}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STT_PROVIDERS[lang.code]?.map((provider: any) => (
                      <SelectItem key={provider.id} value={provider.id}>
                        {provider.name}
                        {provider.recommended && ' ⭐'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* TTS Provider */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Volume2 className="h-5 w-5 text-primary" />
            Text-to-Speech (TTS)
          </CardTitle>
          <CardDescription>
            AI voice that speaks to callers in each language
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {LANGUAGES.map((lang) => (
              <div key={lang.code} className="flex items-center justify-between p-4 border rounded-md">
                <div>
                  <Label className="font-semibold">{lang.name}</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    Language code: {lang.code}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Select
                    value={ttsConfig[lang.code]}
                    onValueChange={(value) => setTtsConfig({ ...ttsConfig, [lang.code]: value })}
                  >
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TTS_PROVIDERS[lang.code]?.map((provider: any) => (
                        <SelectItem key={provider.id} value={provider.id}>
                          {provider.name}
                          {provider.recommended && ' ⭐'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button variant="outline" size="icon">
                    <Volume2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Changes
        </Button>
      </div>
    </div>
  )
}
```

---

## Part 10: Settings - Agent Plugin (Guided Form)

### File: `/src/app/(dashboard)/settings/plugins/agent/page.tsx`

```typescript
'use client'

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { Loader2, Bot, Eye, Code } from 'lucide-react'

const SERVICES = [
  'Scaling & Cleaning',
  'Dental Checkup',
  'Teeth Whitening',
  'Tooth Extraction',
  'Braces & Orthodontics',
  'Root Canal',
  'Dental Crown',
  'Dental Implant',
  'Other',
]

const TONES = [
  { id: 'professional', label: 'Professional', description: 'Formal and competent' },
  { id: 'friendly', label: 'Friendly', description: 'Warm and approachable' },
  { id: 'casual', label: 'Casual', description: 'Relaxed and conversational' },
]

export default function AgentPluginPage() {
  const queryClient = useQueryClient()
  const { data: tenant } = useQuery({
    queryKey: ['tenant'],
    queryFn: getCurrentTenant,
  })

  const [agentName, setAgentName] = useState('Maya')
  const [clinicName, setClinicName] = useState('')
  const [clinicTagline, setClinicTagline] = useState('')
  const [selectedServices, setSelectedServices] = useState<string[]>([])
  const [specialInstructions, setSpecialInstructions] = useState('')
  const [neverSay, setNeverSay] = useState('')
  const [tone, setTone] = useState('friendly')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [rawPrompt, setRawPrompt] = useState('')

  useEffect(() => {
    if (tenant) {
      setAgentName(tenant.agent_name || 'Maya')
      setClinicName(tenant.clinic_name || '')
      // Parse existing system_prompt if needed
      setRawPrompt(tenant.system_prompt || '')
    }
  }, [tenant])

  // Build system prompt from form fields
  const buildSystemPrompt = () => {
    return `You are ${agentName}, an AI receptionist for ${clinicName}${clinicTagline ? ` - ${clinicTagline}` : ''}.

Your job:
- Book, reschedule, and cancel appointments
- Answer questions about clinic hours, location, services, and pricing
- Handle common dental inquiries with empathy and professionalism
- Transfer to a human when needed

Services we offer:
${selectedServices.map(s => `- ${s}`).join('\n')}

Tone: ${tone.charAt(0).toUpperCase() + tone.slice(1)}

${specialInstructions ? `Special instructions:\n${specialInstructions}\n` : ''}
${neverSay ? `Things you must NEVER say:\n${neverSay}\n` : ''}

Always:
- Be warm and professional
- Confirm details before booking
- Ask for patient name and phone number
- Offer alternative times if requested slot is unavailable
- Speak naturally and avoid robotic responses

When to escalate:
- Patient requests to speak with dentist
- Complex treatment questions beyond your knowledge
- Complaints or sensitive issues
- Payment or billing questions
`.trim()
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')

      const promptToSave = showAdvanced ? rawPrompt : buildSystemPrompt()

      const { error } = await supabase
        .from('tenants')
        .update({
          agent_name: agentName,
          clinic_name: clinicName,
          system_prompt: promptToSave,
        })
        .eq('id', tenant.id)

      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Agent configuration updated')
      queryClient.invalidateQueries({ queryKey: ['tenant'] })
    },
    onError: (error: any) => {
      toast.error(error.message)
    },
  })

  function toggleService(service: string) {
    setSelectedServices((prev) =>
      prev.includes(service)
        ? prev.filter((s) => s !== service)
        : [...prev, service]
    )
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Agent Configuration</h1>
          <p className="text-muted-foreground">
            Customize your AI receptionist's personality and instructions
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="gap-2"
        >
          {showAdvanced ? <Eye className="h-4 w-4" /> : <Code className="h-4 w-4" />}
          {showAdvanced ? 'Guided Form' : 'Advanced Mode'}
        </Button>
      </div>

      {showAdvanced ? (
        // Advanced Mode: Raw Prompt Editor
        <Card>
          <CardHeader>
            <CardTitle>System Prompt</CardTitle>
            <CardDescription>
              Edit the raw system prompt directly (for advanced users)
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Textarea
              value={rawPrompt}
              onChange={(e) => setRawPrompt(e.target.value)}
              rows={20}
              className="font-mono text-sm"
              placeholder="Enter system prompt..."
            />
          </CardContent>
        </Card>
      ) : (
        // Guided Form Mode
        <>
          {/* Basic Info */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bot className="h-5 w-5 text-primary" />
                Basic Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="agent-name">Agent Name</Label>
                  <Input
                    id="agent-name"
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    placeholder="Maya"
                  />
                  <p className="text-xs text-muted-foreground">
                    The name your AI will use when introducing itself
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="clinic-name">Clinic Name</Label>
                  <Input
                    id="clinic-name"
                    value={clinicName}
                    onChange={(e) => setClinicName(e.target.value)}
                    placeholder="Gigi Maju Dental Clinic"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="tagline">Clinic Tagline (Optional)</Label>
                <Input
                  id="tagline"
                  value={clinicTagline}
                  onChange={(e) => setClinicTagline(e.target.value)}
                  placeholder="Your smile, our priority"
                />
              </div>
            </CardContent>
          </Card>

          {/* Services */}
          <Card>
            <CardHeader>
              <CardTitle>Services Offered</CardTitle>
              <CardDescription>
                Select all services your clinic provides
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3">
                {SERVICES.map((service) => (
                  <div key={service} className="flex items-center space-x-2">
                    <Checkbox
                      id={service}
                      checked={selectedServices.includes(service)}
                      onCheckedChange={() => toggleService(service)}
                    />
                    <Label
                      htmlFor={service}
                      className="text-sm font-normal cursor-pointer"
                    >
                      {service}
                    </Label>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Tone */}
          <Card>
            <CardHeader>
              <CardTitle>Conversation Tone</CardTitle>
              <CardDescription>
                How should your AI speak to patients?
              </CardDescription>
            </CardHeader>
            <CardContent>
              <RadioGroup value={tone} onValueChange={setTone}>
                {TONES.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-muted/50 transition-colors"
                  >
                    <RadioGroupItem value={t.id} id={t.id} />
                    <div className="flex-1">
                      <Label htmlFor={t.id} className="font-semibold cursor-pointer">
                        {t.label}
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        {t.description}
                      </p>
                    </div>
                  </div>
                ))}
              </RadioGroup>
            </CardContent>
          </Card>

          {/* Special Instructions */}
          <Card>
            <CardHeader>
              <CardTitle>Special Instructions</CardTitle>
              <CardDescription>
                Any specific things your AI should always mention or do
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                value={specialInstructions}
                onChange={(e) => setSpecialInstructions(e.target.value)}
                rows={4}
                placeholder="E.g., Always mention we have free parking, We offer payment plans, We're open on Sundays..."
              />
            </CardContent>
          </Card>

          {/* Never Say */}
          <Card>
            <CardHeader>
              <CardTitle>Things Agent Must Never Say</CardTitle>
              <CardDescription>
                Topics or phrases your AI should avoid
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                value={neverSay}
                onChange={(e) => setNeverSay(e.target.value)}
                rows={4}
                placeholder="E.g., Never quote exact prices over the phone, Don't diagnose conditions, Don't make medical recommendations..."
              />
            </CardContent>
          </Card>

          {/* Preview */}
          <Card className="bg-muted/50">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Eye className="h-4 w-4" />
                Prompt Preview
              </CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="text-xs font-mono whitespace-pre-wrap bg-background p-4 rounded-md border max-h-96 overflow-y-auto">
                {buildSystemPrompt()}
              </pre>
            </CardContent>
          </Card>
        </>
      )}

      {/* Save Button */}
      <div className="flex justify-end gap-3">
        <Button variant="outline">Test Agent</Button>
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Configuration
        </Button>
      </div>
    </div>
  )
}
```

---

## Part 11: Google Calendar Plugin

### File: `/src/app/(dashboard)/settings/plugins/calendar/page.tsx`

```typescript
'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { initiateGoogleCalendarOAuth, disconnectGoogleCalendar } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { CheckCircle2, XCircle, Calendar, ExternalLink, Loader2 } from 'lucide-react'
import { format } from 'date-fns'

export default function CalendarPluginPage() {
  const queryClient = useQueryClient()
  
  const { data: tenant } = useQuery({
    queryKey: ['tenant'],
    queryFn: getCurrentTenant,
  })

  const { data: integration } = useQuery({
    queryKey: ['calendar-integration'],
    queryFn: async () => {
      if (!tenant) return null
      
      const { data, error } = await supabase
        .from('tenant_integrations')
        .select('*')
        .eq('tenant_id', tenant.id)
        .eq('integration_type', 'google_calendar')
        .single()
      
      if (error && error.code !== 'PGRST116') throw error
      return data
    },
    enabled: !!tenant,
  })

  const isConnected = !!integration?.config?.access_token

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      await disconnectGoogleCalendar(tenant.id)
      
      await supabase
        .from('tenant_integrations')
        .delete()
        .eq('tenant_id', tenant.id)
        .eq('integration_type', 'google_calendar')
    },
    onSuccess: () => {
      toast.success('Google Calendar disconnected')
      queryClient.invalidateQueries({ queryKey: ['calendar-integration'] })
    },
    onError: (error: any) => {
      toast.error(error.message)
    },
  })

  const toggleSyncMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      if (!tenant || !integration) throw new Error('Not connected')
      
      const { error } = await supabase
        .from('tenant_integrations')
        .update({
          config: { ...integration.config, sync_enabled: enabled }
        })
        .eq('id', integration.id)
      
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['calendar-integration'] })
      toast.success('Sync settings updated')
    },
    onError: (error: any) => {
      toast.error(error.message)
    },
  })

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Google Calendar Plugin</h1>
        <p className="text-muted-foreground">
          Sync appointments with your Google Calendar
        </p>
      </div>

      {/* Status Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Connection Status</CardTitle>
              <CardDescription>
                {isConnected ? 'Your Google Calendar is connected' : 'Not connected yet'}
              </CardDescription>
            </div>
            <Badge variant={isConnected ? 'default' : 'secondary'} className="gap-1">
              {isConnected ? (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  Connected
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4" />
                  Disconnected
                </>
              )}
            </Badge>
          </div>
        </CardHeader>
        {isConnected && integration && (
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm">
                <span className="font-medium">Connected Account:</span>{' '}
                {integration.config.google_email || 'Unknown'}
              </p>
              <p className="text-sm">
                <span className="font-medium">Calendar:</span>{' '}
                {integration.config.calendar_id || 'Primary'}
              </p>
              <p className="text-sm">
                <span className="font-medium">Last Synced:</span>{' '}
                {integration.updated_at
                  ? format(new Date(integration.updated_at), 'MMM dd, yyyy HH:mm')
                  : 'Never'}
              </p>
            </div>

            <Separator />

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label>Two-way Sync</Label>
                <p className="text-xs text-muted-foreground">
                  Sync bookings to Google and detect blocked time
                </p>
              </div>
              <Switch
                checked={integration.config.sync_enabled !== false}
                onCheckedChange={(checked) => toggleSyncMutation.mutate(checked)}
              />
            </div>

            <Separator />

            <Button
              variant="destructive"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
            >
              {disconnectMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Disconnect Calendar
            </Button>
          </CardContent>
        )}
      </Card>

      {!isConnected && (
        <>
          {/* How It Works */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Calendar className="h-5 w-5 text-primary" />
                How It Works
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                <div className="flex gap-3">
                  <div className="h-6 w-6 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold flex-shrink-0">
                    1
                  </div>
                  <div>
                    <p className="font-medium">Connect Your Google Account</p>
                    <p className="text-sm text-muted-foreground">
                      Click the button below to sign in with Google and grant calendar access
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="h-6 w-6 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold flex-shrink-0">
                    2
                  </div>
                  <div>
                    <p className="font-medium">Automatic Booking Sync</p>
                    <p className="text-sm text-muted-foreground">
                      Every appointment booked by AI is automatically added to your Google Calendar
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <div className="h-6 w-6 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold flex-shrink-0">
                    3
                  </div>
                  <div>
                    <p className="font-medium">Blocked Time Detection</p>
                    <p className="text-sm text-muted-foreground">
                      AI checks your calendar for blocked time and won't book over existing events
                    </p>
                  </div>
                </div>
              </div>

              <Separator />

              <div className="bg-muted/50 p-4 rounded-md">
                <p className="text-sm font-medium mb-2">What gets synced:</p>
                <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
                  <li>Patient name and service type</li>
                  <li>Appointment time and duration</li>
                  <li>Booking source (Voice or WhatsApp)</li>
                  <li>Contact phone number (if available)</li>
                </ul>
              </div>
            </CardContent>
          </Card>

          {/* Connect Button */}
          <Card>
            <CardContent className="pt-6">
              <Button
                onClick={() => tenant && initiateGoogleCalendarOAuth(tenant.id)}
                size="lg"
                className="w-full"
              >
                <Calendar className="mr-2 h-5 w-5" />
                Connect Google Calendar
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
```

---

## Part 12: Package.json

```json
{
  "name": "ai-receptionist-dashboard",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "@fullcalendar/daygrid": "^6.1.10",
    "@fullcalendar/interaction": "^6.1.10",
    "@fullcalendar/react": "^6.1.10",
    "@fullcalendar/timegrid": "^6.1.10",
    "@hookform/resolvers": "^3.3.4",
    "@radix-ui/react-avatar": "^1.0.4",
    "@radix-ui/react-checkbox": "^1.0.4",
    "@radix-ui/react-dialog": "^1.0.5",
    "@radix-ui/react-dropdown-menu": "^2.0.6",
    "@radix-ui/react-label": "^2.0.2",
    "@radix-ui/react-popover": "^1.0.7",
    "@radix-ui/react-radio-group": "^1.1.3",
    "@radix-ui/react-select": "^2.0.0",
    "@radix-ui/react-separator": "^1.0.3",
    "@radix-ui/react-slot": "^1.0.2",
    "@radix-ui/react-switch": "^1.0.3",
    "@radix-ui/react-tabs": "^1.0.4",
    "@supabase/auth-helpers-nextjs": "^0.8.7",
    "@supabase/supabase-js": "^2.39.3",
    "@tanstack/react-query": "^5.17.19",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.0",
    "date-fns": "^3.3.1",
    "lucide-react": "^0.309.0",
    "next": "14.1.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-hook-form": "^7.49.3",
    "recharts": "^2.10.4",
    "sonner": "^1.3.1",
    "tailwind-merge": "^2.2.0",
    "tailwindcss-animate": "^1.0.7",
    "zod": "^3.22.4",
    "zustand": "^4.4.7"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "autoprefixer": "^10.0.1",
    "eslint": "^8",
    "eslint-config-next": "14.1.0",
    "postcss": "^8",
    "tailwindcss": "^3.3.0",
    "typescript": "^5"
  }
}
```

---

## Deployment Instructions

### Step 1: Deploy to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
cd frontend
vercel

# Add environment variables in Vercel dashboard:
# - NEXT_PUBLIC_SUPABASE_URL
# - NEXT_PUBLIC_SUPABASE_ANON_KEY
# - NEXT_PUBLIC_BACKEND_URL
```

### Step 2: Update Supabase Auth Settings

In Supabase Dashboard → Authentication → URL Configuration:
- Site URL: `https://your-app.vercel.app`
- Redirect URLs: `https://your-app.vercel.app/**`

### Step 3: Test OAuth Callback

Ensure the Google OAuth callback URL is set to:
```
https://your-backend.railway.app/api/integrations/google/callback
```

---

## Build Priority (Recommended Order)

### Phase 1 — MVP (Build First)
1. ✅ Authentication (login, register)
2. ✅ Dashboard layout (sidebar, navbar)
3. ✅ Overview page with metrics
4. ✅ Settings → WhatsApp Plugin
5. ✅ Settings → Phone Plugin (display only, no test needed)
6. ✅ Settings → AI Providers Plugin
7. ✅ Settings → Agent Plugin (guided form)

### Phase 2 — Core Features
8. ✅ Calendar page (FullCalendar with bookings)
9. ✅ Appointments page (table with filters)
10. ✅ Call logs page (list + transcript viewer)

### Phase 3 — Advanced
11. ✅ Google Calendar Plugin (OAuth flow)
12. ✅ WhatsApp inbox page
13. ✅ Analytics page (charts)
14. ✅ Staff management

---

## Additional Components Needed

Due to length, I've omitted some helper components. Create these as needed:

- `/src/components/calendar/add-booking-modal.tsx` — Form to manually add bookings
- `/src/components/calendar/booking-detail-modal.tsx` — View booking details
- `/src/app/(dashboard)/appointments/page.tsx` — Appointments table
- `/src/app/(dashboard)/call-logs/page.tsx` — Call logs with transcripts
- `/src/app/(dashboard)/whatsapp/page.tsx` — WhatsApp inbox
- `/src/app/(dashboard)/analytics/page.tsx` — Charts and metrics

---

## Key Features Summary

✅ **Zero developer needed after deployment**  
✅ **Plugin architecture** — connect/disconnect services in 2 clicks  
✅ **Guided forms** — no raw JSON editing  
✅ **Live status indicators** — see active calls in real-time  
✅ **Two-way calendar sync** — Google Calendar integration  
✅ **Multi-language support** — EN, MS, ZH with provider selection  
✅ **Professional design** — based on TailPanel reference  
✅ **Mobile responsive** — works on all devices  
✅ **Type-safe** — Full TypeScript  
✅ **Real-time updates** — Supabase subscriptions  

---

**End of Frontend Build Instructions**
