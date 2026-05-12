'use client'

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { Loader2, Sparkles, Mic, Volume2, Key } from 'lucide-react'
import { LLM_PROVIDERS, STT_PROVIDERS, TTS_PROVIDERS, LANGUAGES } from '@/lib/providers'

export default function AIProvidersPage() {
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

  const [llmProvider, setLlmProvider] = useState('groq')
  const [llmModel, setLlmModel] = useState('llama-3.3-70b-versatile')
  const [sttConfig, setSttConfig] = useState<Record<string, string>>({ en: 'deepgram', ms: 'openai', zh: 'deepgram' })
  const [ttsConfig, setTtsConfig] = useState<Record<string, string>>({ en: 'cartesia', ms: 'elevenlabs', zh: 'elevenlabs' })
  const [creds, setCreds] = useState<Record<string, Record<string, string>>>({})

  useEffect(() => {
    if (settings) {
      setLlmProvider(settings.llm_config?.provider || 'groq')
      setLlmModel(settings.llm_config?.model || 'llama-3.3-70b-versatile')
      setSttConfig(settings.stt_config || { en: 'deepgram', ms: 'openai', zh: 'deepgram' })
      setTtsConfig(settings.tts_config || { en: 'cartesia', ms: 'elevenlabs', zh: 'elevenlabs' })
      setCreds(settings.provider_credentials || {})
    }
  }, [settings])

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      const { error } = await supabase.from('tenant_settings').upsert({
        tenant_id: tenant.id,
        llm_config: { provider: llmProvider, model: llmModel },
        stt_config: sttConfig,
        tts_config: ttsConfig,
        provider_credentials: creds,
      }, { onConflict: 'tenant_id' })
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('AI providers saved')
      queryClient.invalidateQueries({ queryKey: ['tenant-settings'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  function setCredKey(provider: string, key: string, value: string) {
    setCreds((prev) => ({ ...prev, [provider]: { ...(prev[provider] || {}), [key]: value } }))
  }

  const credFields: Record<string, Array<{ key: string; label: string; placeholder: string }>> = {
    groq: [{ key: 'api_key', label: 'Groq API Key', placeholder: 'gsk_...' }],
    openai: [{ key: 'api_key', label: 'OpenAI API Key', placeholder: 'sk-...' }],
    anthropic: [{ key: 'api_key', label: 'Anthropic API Key', placeholder: 'sk-ant-...' }],
    google: [{ key: 'api_key', label: 'Google API Key', placeholder: 'AIza...' }],
    mistral: [{ key: 'api_key', label: 'Mistral API Key', placeholder: 'your-mistral-key' }],
    deepgram: [{ key: 'api_key', label: 'Deepgram API Key', placeholder: 'dg_...' }],
    cartesia: [
      { key: 'api_key', label: 'Cartesia API Key', placeholder: '' },
      { key: 'voice_id', label: 'Voice ID', placeholder: 'a0e99841-...' },
    ],
    elevenlabs: [
      { key: 'api_key', label: 'ElevenLabs API Key', placeholder: '' },
      { key: 'voice_id', label: 'Voice ID', placeholder: '21m00Tcm4...' },
    ],
  }

  const neededProviders = new Set([llmProvider, ...Object.values(sttConfig), ...Object.values(ttsConfig)])
  const credProviders = [...neededProviders].filter((p) => credFields[p])

  const selectedLlm = LLM_PROVIDERS.find((p) => p.provider === llmProvider)

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">AI Providers</h1>
        <p className="text-muted-foreground">Configure LLM, speech-to-text, and text-to-speech providers</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-primary" />Language Model (LLM)</CardTitle>
          <CardDescription>The AI brain for conversations</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup value={llmProvider} onValueChange={(v) => v && setLlmProvider(v)}>
            {LLM_PROVIDERS.map((p) => (
              <div key={p.provider} className="flex items-start space-x-3 rounded-md border p-4 hover:bg-muted/50 transition-colors">
                <RadioGroupItem value={p.provider} id={p.provider} />
                <div className="flex-1">
                  <Label htmlFor={p.provider} className="font-semibold cursor-pointer flex items-center gap-2">
                    {p.name}
                    {p.recommended && <Badge variant="secondary" className="text-xs">Recommended</Badge>}
                  </Label>
                  <p className="text-sm text-muted-foreground mt-1">{p.description}</p>
                  <p className="text-xs text-muted-foreground mt-1">Est. {p.estimatedCostPerCall}/call</p>
                </div>
              </div>
            ))}
          </RadioGroup>
          {selectedLlm && (
            <div className="space-y-2">
              <Label>Model</Label>
              <Select value={llmModel} onValueChange={(v) => v && setLlmModel(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {selectedLlm.models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Mic className="h-5 w-5 text-primary" />Speech-to-Text (STT)</CardTitle>
          <CardDescription>Converts voice to text per language</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {LANGUAGES.map((lang) => (
            <div key={lang.code} className="flex items-center justify-between p-3 border rounded-md">
              <Label className="font-medium">{lang.name}</Label>
              <Select value={sttConfig[lang.code]} onValueChange={(v) => v && setSttConfig({ ...sttConfig, [lang.code]: v })}>
                <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STT_PROVIDERS[lang.code]?.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}{p.recommended ? ' ⭐' : ''}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Volume2 className="h-5 w-5 text-primary" />Text-to-Speech (TTS)</CardTitle>
          <CardDescription>AI voice that speaks to callers</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {LANGUAGES.map((lang) => (
            <div key={lang.code} className="flex items-center justify-between p-3 border rounded-md">
              <Label className="font-medium">{lang.name}</Label>
              <Select value={ttsConfig[lang.code]} onValueChange={(v) => v && setTtsConfig({ ...ttsConfig, [lang.code]: v })}>
                <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TTS_PROVIDERS[lang.code]?.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}{p.recommended ? ' ⭐' : ''}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Key className="h-5 w-5 text-primary" />API Keys</CardTitle>
          <CardDescription>Your keys are stored securely and never shared</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {credProviders.map((provider) => (
            <div key={provider}>
              <p className="font-semibold text-sm mb-3 capitalize">{provider}</p>
              <div className="space-y-3">
                {credFields[provider].map(({ key, label, placeholder }) => (
                  <div key={key} className="space-y-1">
                    <Label className="text-sm">{label}</Label>
                    <Input
                      type="password"
                      placeholder={placeholder || 'Enter key...'}
                      value={creds[provider]?.[key] || ''}
                      onChange={(e) => setCredKey(provider, key, e.target.value)}
                    />
                  </div>
                ))}
              </div>
              <Separator className="mt-4" />
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Changes
        </Button>
      </div>
    </div>
  )
}
