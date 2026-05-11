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
import { toast } from 'sonner'
import { Loader2, Bot, Eye, Code } from 'lucide-react'

const SERVICES = ['Scaling & Cleaning', 'Dental Checkup', 'Teeth Whitening', 'Tooth Extraction',
  'Braces & Orthodontics', 'Root Canal', 'Dental Crown', 'Dental Implant', 'Other']

const TONES = [
  { id: 'professional', label: 'Professional', description: 'Formal and competent' },
  { id: 'friendly', label: 'Friendly', description: 'Warm and approachable' },
  { id: 'casual', label: 'Casual', description: 'Relaxed and conversational' },
]

export default function AgentPluginPage() {
  const queryClient = useQueryClient()
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
  const [selectedServices, setSelectedServices] = useState<string[]>([])
  const [specialInstructions, setSpecialInstructions] = useState('')
  const [neverSay, setNeverSay] = useState('')
  const [tone, setTone] = useState('friendly')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [rawPrompt, setRawPrompt] = useState('')

  useEffect(() => {
    if (tenant) setClinicName(tenant.name || '')
    if (settings) {
      setAgentName(settings.agent_name || 'Maya')
      setRawPrompt(settings.system_prompt || '')
    }
  }, [tenant, settings])

  function buildSystemPrompt() {
    return `You are ${agentName}, an AI receptionist for ${clinicName}${clinicTagline ? ` — ${clinicTagline}` : ''}.

Your job:
- Book, reschedule, and cancel appointments
- Answer questions about clinic hours, location, services, and pricing
- Transfer to a human when needed

Services we offer:
${selectedServices.map((s) => `- ${s}`).join('\n')}

Tone: ${tone.charAt(0).toUpperCase() + tone.slice(1)}

${specialInstructions ? `Special instructions:\n${specialInstructions}\n` : ''}${neverSay ? `Things you must NEVER say:\n${neverSay}\n` : ''}
Always confirm appointment details before booking. Ask for patient name and phone number.
When to escalate: patient requests human, complex treatment questions, complaints, payment issues.`.trim()
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      const promptToSave = showAdvanced ? rawPrompt : buildSystemPrompt()
      const { error: tenantErr } = await supabase.from('tenants').update({ agent_name: agentName }).eq('id', tenant.id)
      if (tenantErr) throw tenantErr
      const { error: settingsErr } = await supabase.from('tenant_settings').upsert({
        tenant_id: tenant.id,
        agent_name: agentName,
        system_prompt: promptToSave,
      }, { onConflict: 'tenant_id' })
      if (settingsErr) throw settingsErr
    },
    onSuccess: () => {
      toast.success('Agent configuration saved')
      queryClient.invalidateQueries({ queryKey: ['tenant'] })
      queryClient.invalidateQueries({ queryKey: ['tenant-settings'] })
      queryClient.invalidateQueries({ queryKey: ['plugin-status'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  function toggleService(service: string) {
    setSelectedServices((prev) => prev.includes(service) ? prev.filter((s) => s !== service) : [...prev, service])
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Agent Configuration</h1>
          <p className="text-muted-foreground">Customize your AI receptionist&apos;s personality</p>
        </div>
        <Button variant="outline" onClick={() => setShowAdvanced(!showAdvanced)} className="gap-2">
          {showAdvanced ? <><Eye className="h-4 w-4" />Guided Form</> : <><Code className="h-4 w-4" />Advanced</>}
        </Button>
      </div>

      {showAdvanced ? (
        <Card>
          <CardHeader>
            <CardTitle>System Prompt</CardTitle>
            <CardDescription>Edit the raw system prompt directly</CardDescription>
          </CardHeader>
          <CardContent>
            <Textarea value={rawPrompt} onChange={(e) => setRawPrompt(e.target.value)}
              rows={20} className="font-mono text-sm" placeholder="Enter system prompt..." />
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Bot className="h-5 w-5 text-primary" />Basic Information</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="agent-name">Agent Name</Label>
                <Input id="agent-name" value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Maya" />
                <p className="text-xs text-muted-foreground">The name your AI will introduce itself as</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="clinic-name">Clinic Name</Label>
                <Input id="clinic-name" value={clinicName} onChange={(e) => setClinicName(e.target.value)} placeholder="Gigi Maju Dental Clinic" />
              </div>
              <div className="space-y-2 col-span-2">
                <Label htmlFor="tagline">Tagline (Optional)</Label>
                <Input id="tagline" value={clinicTagline} onChange={(e) => setClinicTagline(e.target.value)} placeholder="Your smile, our priority" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Services Offered</CardTitle>
              <CardDescription>Select all services your clinic provides</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-3">
              {SERVICES.map((service) => (
                <div key={service} className="flex items-center space-x-2">
                  <Checkbox id={service} checked={selectedServices.includes(service)} onCheckedChange={() => toggleService(service)} />
                  <Label htmlFor={service} className="text-sm font-normal cursor-pointer">{service}</Label>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Conversation Tone</CardTitle>
            </CardHeader>
            <CardContent>
              <RadioGroup value={tone} onValueChange={setTone}>
                {TONES.map((t) => (
                  <div key={t.id} className="flex items-start space-x-3 rounded-md border p-4 hover:bg-muted/50 transition-colors">
                    <RadioGroupItem value={t.id} id={t.id} />
                    <div>
                      <Label htmlFor={t.id} className="font-semibold cursor-pointer">{t.label}</Label>
                      <p className="text-sm text-muted-foreground">{t.description}</p>
                    </div>
                  </div>
                ))}
              </RadioGroup>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Special Instructions</CardTitle>
              <CardDescription>Things your AI should always mention or do</CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea value={specialInstructions} onChange={(e) => setSpecialInstructions(e.target.value)}
                rows={3} placeholder="E.g., Always mention we have free parking..." />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Things Agent Must Never Say</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea value={neverSay} onChange={(e) => setNeverSay(e.target.value)}
                rows={3} placeholder="E.g., Never quote exact prices over the phone..." />
            </CardContent>
          </Card>

          <Card className="bg-muted/50">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2"><Eye className="h-4 w-4" />Prompt Preview</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="text-xs font-mono whitespace-pre-wrap bg-background p-4 rounded-md border max-h-64 overflow-y-auto">
                {buildSystemPrompt()}
              </pre>
            </CardContent>
          </Card>
        </>
      )}

      <div className="flex justify-end gap-3">
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Configuration
        </Button>
      </div>
    </div>
  )
}
