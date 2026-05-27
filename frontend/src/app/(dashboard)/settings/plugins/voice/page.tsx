'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { VOICE_LLM_PROVIDERS, VOICE_STT_PROVIDERS, VOICE_TTS_PROVIDERS } from '@/lib/providers'
import {
  Brain, Mic, Volume2, FlaskConical, Loader2, Check, Key, ExternalLink,
  Bot, Phone, PhoneOff, MicOff, AlertCircle, CheckCircle2,
} from 'lucide-react'

const SECTIONS = [
  { id: 'llm',  label: 'LLM (Brain)',   icon: Brain },
  { id: 'stt',  label: 'STT (Ears)',    icon: Mic },
  { id: 'tts',  label: 'TTS (Voice)',   icon: Volume2 },
  { id: 'test', label: 'Test Call',     icon: FlaskConical },
]

// ── Inline voice call widget ──────────────────────────────────────────────────

type CallState = 'idle' | 'requesting-mic' | 'connecting' | 'connected' | 'error'

interface TranscriptLine {
  id: string
  speaker: 'user' | 'agent'
  text: string
  isFinal: boolean
}

function MicMeter({ level }: { level: number }) {
  const bars = 8
  return (
    <div className="flex items-end gap-0.5 h-5">
      {Array.from({ length: bars }).map((_, i) => {
        const threshold = i / bars
        const active = level > threshold
        return (
          <div
            key={i}
            className={cn(
              'w-1.5 rounded-sm transition-all duration-75',
              active ? (level > 0.6 ? 'bg-red-400' : 'bg-green-400') : 'bg-muted-foreground/20',
            )}
            style={{ height: `${Math.round(((i + 1) / bars) * 100)}%` }}
          />
        )
      })}
    </div>
  )
}

function VoiceTestWidget({ tenantId }: { tenantId: string }) {
  const [callState, setCallState] = useState<CallState>('idle')
  const [agentSpeaking, setAgentSpeaking] = useState(false)
  const [micMuted, setMicMuted] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')
  const [micLevel, setMicLevel] = useState(0)
  const [transcript, setTranscript] = useState<TranscriptLine[]>([])
  const [micWarning, setMicWarning] = useState(false)

  const roomRef        = useRef<import('livekit-client').Room | null>(null)
  const timerRef       = useRef<ReturnType<typeof setInterval> | null>(null)
  const animRef        = useRef<number>(0)
  const silenceRef     = useRef<ReturnType<typeof setTimeout> | null>(null)
  const transcriptEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => () => {
    timerRef.current && clearInterval(timerRef.current)
    cancelAnimationFrame(animRef.current)
    silenceRef.current && clearTimeout(silenceRef.current)
    roomRef.current?.disconnect()
  }, [])

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript])

  const startCall = useCallback(async () => {
    setCallState('requesting-mic')
    setErrorMsg('')
    setTranscript([])
    setMicWarning(false)

    // 1. Request mic — gives us the stream for level monitoring
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    } catch {
      setErrorMsg('Microphone access denied. Click the mic/lock icon in your address bar and allow access, then try again.')
      setCallState('error')
      return
    }

    // 2. Web Audio API level monitor
    const audioCtx = new AudioContext()
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 256
    audioCtx.createMediaStreamSource(stream).connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)
    const tick = () => {
      analyser.getByteFrequencyData(data)
      const level = data.reduce((a, b) => a + b, 0) / data.length / 255
      setMicLevel(level)
      if (level > 0.02) {
        setMicWarning(false)
        silenceRef.current && clearTimeout(silenceRef.current)
      }
      animRef.current = requestAnimationFrame(tick)
    }
    animRef.current = requestAnimationFrame(tick)
    silenceRef.current = setTimeout(() => setMicWarning(true), 5000)

    // 3. Fetch token + connect to LiveKit
    setCallState('connecting')
    try {
      const { Room, RoomEvent } = await import('livekit-client')
      const res = await fetch('/api/voice-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenantId, participant_name: 'Dashboard Test' }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        let detail = `Token error ${res.status}`
        try { detail = JSON.parse(text).detail || detail } catch { /* non-JSON */ }
        throw new Error(detail)
      }
      const { token, url } = await res.json()
      const room = new Room({ adaptiveStream: true, dynacast: true })
      roomRef.current = room

      // Live transcription
      room.on(RoomEvent.TranscriptionReceived, (
        segments: import('livekit-client').TranscriptionSegment[],
        participant?: import('livekit-client').Participant,
      ) => {
        const isAgent = !participant || participant.identity !== room.localParticipant.identity
        setTranscript((prev) => {
          let next = [...prev]
          for (const seg of segments) {
            if (!seg.text.trim()) continue
            const idx = next.findIndex((t) => t.id === seg.id)
            const line: TranscriptLine = {
              id: seg.id,
              speaker: isAgent ? 'agent' : 'user',
              text: seg.text,
              isFinal: seg.final,
            }
            if (idx >= 0) next[idx] = line
            else next = [...next, line]
          }
          return next
        })
      })

      room.on(RoomEvent.ActiveSpeakersChanged, (speakers: import('livekit-client').Participant[]) => {
        setAgentSpeaking(speakers.some((s) => s.identity !== room.localParticipant.identity))
      })
      room.on(RoomEvent.Disconnected, () => {
        setCallState('idle')
        setAgentSpeaking(false)
        setMicLevel(0)
        cancelAnimationFrame(animRef.current)
        timerRef.current && clearInterval(timerRef.current)
      })
      room.on(RoomEvent.TrackSubscribed, (track: import('livekit-client').RemoteTrack) => {
        if (track.kind === 'audio') {
          const el = track.attach() as HTMLAudioElement
          el.autoplay = true
          document.body.appendChild(el)
        }
      })
      room.on(RoomEvent.TrackUnsubscribed, (track: import('livekit-client').RemoteTrack) => {
        if (track.kind === 'audio') track.detach()
      })

      await room.connect(url, token)
      await room.localParticipant.setMicrophoneEnabled(true)
      setCallState('connected')
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to connect')
      setCallState('error')
      cancelAnimationFrame(animRef.current)
      stream.getTracks().forEach((t) => t.stop())
    }
  }, [tenantId])

  const endCall = useCallback(async () => {
    timerRef.current && clearInterval(timerRef.current)
    cancelAnimationFrame(animRef.current)
    silenceRef.current && clearTimeout(silenceRef.current)
    setMicLevel(0)
    setMicWarning(false)
    await roomRef.current?.disconnect()
    roomRef.current = null
    setCallState('idle')
    setAgentSpeaking(false)
    setElapsed(0)
  }, [])

  const toggleMic = useCallback(async () => {
    const lp = roomRef.current?.localParticipant
    if (!lp) return
    await lp.setMicrophoneEnabled(micMuted)
    setMicMuted((m) => !m)
  }, [micMuted])

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

  const isConnected = callState === 'connected'

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x">

      {/* ── Left: call controls ── */}
      <div className="flex flex-col items-center gap-5 py-6 px-4">
        <div className={cn(
          'h-24 w-24 rounded-full flex items-center justify-center transition-all duration-300',
          isConnected && agentSpeaking
            ? 'bg-primary/20 ring-4 ring-primary/40 animate-pulse'
            : isConnected
            ? 'bg-primary/10 ring-2 ring-primary/20'
            : 'bg-muted',
        )}>
          <Bot className={cn('h-12 w-12', isConnected ? 'text-primary' : 'text-muted-foreground')} />
        </div>

        <div className="text-center">
          <p className="font-semibold text-lg">Maya — Voice Receptionist</p>
          <p className="text-sm text-muted-foreground mt-1">
            {(callState === 'idle' || callState === 'error') && 'Click to start a live voice call'}
            {callState === 'requesting-mic' && 'Requesting microphone access…'}
            {callState === 'connecting' && 'Connecting to Maya…'}
            {isConnected && !agentSpeaking && `Connected · ${fmt(elapsed)}`}
            {isConnected && agentSpeaking && `Maya is speaking · ${fmt(elapsed)}`}
          </p>
        </div>

        {/* Mic level meter */}
        {isConnected && (
          <div className="flex flex-col items-center gap-2 w-full max-w-xs">
            <div className="flex items-center gap-3">
              <MicMeter level={micMuted ? 0 : micLevel} />
              <span className="text-xs text-muted-foreground w-24">
                {micMuted ? 'Muted' : micLevel > 0.03 ? 'Mic capturing' : 'No audio detected'}
              </span>
            </div>
            {micWarning && !micMuted && (
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 w-full">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                No audio from mic — check OS sound input settings.
              </div>
            )}
          </div>
        )}

        {errorMsg && (
          <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 px-4 py-2.5 rounded-lg w-full max-w-sm">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {errorMsg}
          </div>
        )}

        <div className="flex gap-3 w-full max-w-sm">
          {isConnected && (
            <>
              <Button variant="outline" className="flex-1 gap-2" onClick={toggleMic}>
                {micMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                {micMuted ? 'Unmute' : 'Mute'}
              </Button>
              <Button variant="destructive" className="flex-1 gap-2" onClick={endCall}>
                <PhoneOff className="h-4 w-4" />
                End Call
              </Button>
            </>
          )}
          {(callState === 'idle' || callState === 'error') && (
            <Button className="w-full gap-2" size="lg" onClick={startCall}>
              <Phone className="h-5 w-5" />
              Start Voice Call
            </Button>
          )}
          {(callState === 'connecting' || callState === 'requesting-mic') && (
            <Button disabled className="w-full gap-2" size="lg">
              <Loader2 className="h-4 w-4 animate-spin" />
              {callState === 'requesting-mic' ? 'Requesting mic…' : 'Connecting…'}
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground text-center max-w-xs">
          Speaks in English, Malay, Tamil or Mandarin — just talk naturally.
          Make sure your microphone is allowed in the browser.
        </p>
      </div>

      {/* ── Right: transcription panel ── */}
      <div className="flex flex-col min-h-[300px]">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <p className="text-sm font-semibold flex items-center gap-2">
            <Mic className="h-4 w-4 text-primary" />
            Live Transcription
          </p>
          {isConnected && (
            <Badge
              variant="outline"
              className={cn(
                'text-xs gap-1',
                micLevel > 0.03 && !micMuted ? 'border-green-500 text-green-600' : 'text-muted-foreground',
              )}
            >
              <span className={cn(
                'h-1.5 w-1.5 rounded-full',
                micLevel > 0.03 && !micMuted ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/30',
              )} />
              {micLevel > 0.03 && !micMuted ? 'STT active' : 'Waiting…'}
            </Badge>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2 max-h-64">
          {transcript.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground py-8 select-none">
              {isConnected ? (
                <>
                  <Mic className="h-7 w-7 mb-2 opacity-20" />
                  <p className="text-sm">Speak — transcription appears here</p>
                  <p className="text-xs mt-1 max-w-[200px]">
                    Nothing showing? STT is not receiving your audio.
                  </p>
                </>
              ) : (
                <>
                  <Phone className="h-7 w-7 mb-2 opacity-20" />
                  <p className="text-sm">Start a call to see live transcription</p>
                </>
              )}
            </div>
          ) : (
            transcript.map((line) => (
              <div
                key={line.id}
                className={cn(
                  'rounded-lg px-3 py-2 text-sm max-w-[90%]',
                  line.speaker === 'user' ? 'bg-primary/10 ml-auto text-right' : 'bg-muted',
                  !line.isFinal && 'opacity-60 italic',
                )}
              >
                <span className="text-[10px] font-semibold text-muted-foreground block mb-0.5">
                  {line.speaker === 'user' ? 'You' : 'Maya'}
                </span>
                {line.text}
                {!line.isFinal && <span className="text-muted-foreground ml-1">…</span>}
              </div>
            ))
          )}
          <div ref={transcriptEndRef} />
        </div>

        {/* STT / LLM / TTS status row */}
        {isConnected && (
          <div className="border-t grid grid-cols-3 divide-x text-center shrink-0">
            {[
              { label: 'STT', ok: transcript.some((t) => t.speaker === 'user'),               hint: 'Your voice' },
              { label: 'LLM', ok: transcript.some((t) => t.speaker === 'agent'),              hint: 'AI reply' },
              { label: 'TTS', ok: transcript.some((t) => t.speaker === 'agent' && t.isFinal), hint: 'Spoken' },
            ].map(({ label, ok, hint }) => (
              <div key={label} className="py-2 flex flex-col items-center gap-0.5">
                <div className="flex items-center gap-1">
                  {ok
                    ? <CheckCircle2 className="h-3 w-3 text-green-500" />
                    : <div className="h-3 w-3 rounded-full border-2 border-muted-foreground/30" />
                  }
                  <span className="text-xs font-semibold">{label}</span>
                </div>
                <span className="text-[10px] text-muted-foreground">{hint}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Provider card ─────────────────────────────────────────────────────────────

function ProviderCard({
  selected, recommended, name, badge, description, onSelect,
}: {
  selected: boolean
  recommended?: boolean
  name: string
  badge?: string | null
  description: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative w-full text-left rounded-xl border p-4 transition-all',
        selected
          ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
          : 'border-border hover:border-muted-foreground/40 hover:bg-muted/30',
      )}
    >
      {selected && (
        <span className="absolute top-3 right-3 h-5 w-5 rounded-full bg-primary flex items-center justify-center">
          <Check className="h-3 w-3 text-primary-foreground" />
        </span>
      )}
      <div className="flex items-center gap-2 mb-1">
        <p className="font-medium text-sm">{name}</p>
        {badge && <Badge variant="secondary" className="text-xs">{badge}</Badge>}
        {recommended && !badge && <Badge variant="outline" className="text-xs text-primary border-primary/30">Recommended</Badge>}
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
    </button>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function VoiceConfigPage() {
  const queryClient = useQueryClient()
  const [section, setSection] = useState('llm')

  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })
  const { data: settings, isLoading } = useQuery({
    queryKey: ['tenant-settings', 'voice'],
    queryFn: async () => {
      if (!tenant) return null
      // Exclude voice_provider_credentials — keys never leave the server
      const { data } = await supabase
        .from('tenant_settings')
        .select('voice_llm_config,voice_stt_config,voice_tts_config,voice_language')
        .eq('tenant_id', tenant.id)
        .maybeSingle()
      return data
    },
    enabled: !!tenant,
    staleTime: 0,
  })

  // Credential existence flags — only booleans, never actual key values
  const { data: credExistence } = useQuery({
    queryKey: ['voice-cred-existence'],
    queryFn: async () => {
      const res = await fetch('/api/credentials?type=voice')
      return res.ok ? (await res.json() as Record<string, boolean>) : {}
    },
    enabled: !!tenant,
    staleTime: 30_000,
  })

  // ── LLM state ────────────────────────────────────────────────────────────
  const [llmProvider, setLlmProvider] = useState('groq')
  const [llmModel, setLlmModel] = useState('llama-3.3-70b-versatile')
  const [newLlmKey, setNewLlmKey] = useState('')

  // ── STT state ────────────────────────────────────────────────────────────
  const [sttProvider, setSttProvider] = useState('deepgram')
  const [newSttKey, setNewSttKey] = useState('')

  // ── TTS state ────────────────────────────────────────────────────────────
  const [ttsProvider, setTtsProvider] = useState('elevenlabs')
  const [ttsVoiceId, setTtsVoiceId] = useState('21m00Tcm4TlvDq8ikWAM')
  const [newTtsKey, setNewTtsKey] = useState('')

  // Seed state from DB
  useEffect(() => {
    if (!settings) return
    if (settings.voice_llm_config) {
      setLlmProvider(settings.voice_llm_config.provider || 'groq')
      setLlmModel(settings.voice_llm_config.model || 'llama-3.3-70b-versatile')
    }
    if (settings.voice_stt_config) {
      setSttProvider(settings.voice_stt_config.provider || 'deepgram')
    }
    if (settings.voice_tts_config) {
      setTtsProvider(settings.voice_tts_config.provider || 'elevenlabs')
      setTtsVoiceId(settings.voice_tts_config.voice_id || '21m00Tcm4TlvDq8ikWAM')
    }
  }, [settings])

  async function saveProviderKey(provider: string, key: string) {
    if (!key.trim()) return
    const res = await fetch('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, api_key: key.trim(), type: 'voice' }),
    })
    if (!res.ok) throw new Error('Failed to save API key')
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('Not logged in')
      const { error } = await supabase.from('tenant_settings').upsert({
        tenant_id: tenant.id,
        voice_llm_config: { provider: llmProvider, model: llmModel },
        voice_stt_config: { provider: sttProvider },
        voice_tts_config: { provider: ttsProvider, voice_id: ttsVoiceId },
      }, { onConflict: 'tenant_id' })
      if (error) throw error

      // Save API keys separately — never included in the main upsert
      await Promise.all([
        saveProviderKey(llmProvider, newLlmKey),
        saveProviderKey(sttProvider, newSttKey),
        saveProviderKey(ttsProvider, newTtsKey),
      ])
      setNewLlmKey('')
      setNewSttKey('')
      setNewTtsKey('')
    },
    onSuccess: () => {
      toast.success('Voice config saved')
      queryClient.invalidateQueries({ queryKey: ['tenant-settings', 'voice'] })
      queryClient.invalidateQueries({ queryKey: ['plugin-status'] })
      queryClient.invalidateQueries({ queryKey: ['voice-cred-existence'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const selectedLlmDef = VOICE_LLM_PROVIDERS.find((p) => p.provider === llmProvider)
  const selectedSttDef = VOICE_STT_PROVIDERS.find((p) => p.id === sttProvider)
  const selectedTtsDef = VOICE_TTS_PROVIDERS.find((p) => p.id === ttsProvider)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex gap-6 h-[calc(100vh-4rem)] -mx-6 -mt-6 -mb-6 overflow-hidden">

      {/* ── Left sidebar ── */}
      <div className="w-52 shrink-0 border-r border-border bg-card pt-6 pb-4 px-3 flex flex-col gap-0.5 overflow-y-auto">
        <p className="px-2 mb-3 text-[10px] font-semibold tracking-widest text-muted-foreground/70 uppercase select-none">
          Voice Agent
        </p>
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setSection(id)}
            className={cn(
              'flex items-center gap-3 px-2 py-2 text-sm font-medium rounded-lg transition-colors w-full text-left',
              section === id
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-8">

        {/* ── LLM section ── */}
        {section === 'llm' && (
          <div className="space-y-6 max-w-2xl">
            <div>
              <h2 className="text-xl font-semibold">LLM — Brain</h2>
              <p className="text-sm text-muted-foreground mt-1">
                The language model that understands callers and generates responses.
                Low-latency models give snappier conversations.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {VOICE_LLM_PROVIDERS.map((p) => (
                <ProviderCard
                  key={p.provider}
                  selected={llmProvider === p.provider}
                  recommended={p.recommended}
                  name={p.name}
                  badge={p.badge}
                  description={p.description}
                  onSelect={() => {
                    setLlmProvider(p.provider)
                    setLlmModel(p.models[0]?.id ?? '')
                  }}
                />
              ))}
            </div>

            {selectedLlmDef && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{selectedLlmDef.name} Settings</CardTitle>
                  <CardDescription>
                    Est. cost per voice call: <strong>{selectedLlmDef.estimatedCostPerCall}</strong>
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label>Model</Label>
                    <Select value={llmModel} onValueChange={(v) => v && setLlmModel(v)}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {selectedLlmDef.models.map((m) => (
                          <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="flex items-center gap-1.5">
                        <Key className="h-3.5 w-3.5" />
                        API Key
                        {credExistence?.[llmProvider] && !newLlmKey && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5 text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800">
                            <Check className="h-2.5 w-2.5" />Key saved
                          </Badge>
                        )}
                      </Label>
                      {selectedLlmDef.keyUrl && (
                        <a
                          href={selectedLlmDef.keyUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary flex items-center gap-1 hover:underline"
                        >
                          Get key <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <Input
                      type="password"
                      placeholder={credExistence?.[llmProvider] ? 'Enter new key to replace…' : selectedLlmDef.keyPlaceholder}
                      value={newLlmKey}
                      onChange={(e) => setNewLlmKey(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Stored server-side only. Never sent to the browser.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="gap-2">
              {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </div>
        )}

        {/* ── STT section ── */}
        {section === 'stt' && (
          <div className="space-y-6 max-w-2xl">
            <div>
              <h2 className="text-xl font-semibold">STT — Ears</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Speech-to-text converts caller audio into text for the AI to understand.
                Choose based on your primary language.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {VOICE_STT_PROVIDERS.map((p) => (
                <ProviderCard
                  key={p.id}
                  selected={sttProvider === p.id}
                  recommended={p.recommended}
                  name={p.name}
                  badge={p.badge}
                  description={p.description}
                  onSelect={() => setSttProvider(p.id)}
                />
              ))}
            </div>

            {selectedSttDef && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{selectedSttDef.name} Settings</CardTitle>
                  {selectedSttDef.supportsLanguages.length > 0 && (
                    <CardDescription>
                      Languages: {selectedSttDef.supportsLanguages.join(', ')}
                    </CardDescription>
                  )}
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="flex items-center gap-1.5">
                        <Key className="h-3.5 w-3.5" />
                        API Key
                        {credExistence?.[sttProvider] && !newSttKey && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5 text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800">
                            <Check className="h-2.5 w-2.5" />Key saved
                          </Badge>
                        )}
                      </Label>
                      {selectedSttDef.keyUrl && (
                        <a
                          href={selectedSttDef.keyUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary flex items-center gap-1 hover:underline"
                        >
                          Get key <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <Input
                      type="password"
                      placeholder={credExistence?.[sttProvider] ? 'Enter new key to replace…' : selectedSttDef.keyPlaceholder}
                      value={newSttKey}
                      onChange={(e) => setNewSttKey(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {sttProvider === 'groq'
                        ? 'Uses your Groq key from the LLM section — no extra cost.'
                        : 'Stored server-side only. Never sent to the browser.'}
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="gap-2">
              {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </div>
        )}

        {/* ── TTS section ── */}
        {section === 'tts' && (
          <div className="space-y-6 max-w-2xl">
            <div>
              <h2 className="text-xl font-semibold">TTS — Voice</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Text-to-speech converts Maya&apos;s text responses into spoken audio.
                ElevenLabs gives the most natural sound; Cartesia has the lowest latency.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              {VOICE_TTS_PROVIDERS.map((p) => (
                <ProviderCard
                  key={p.id}
                  selected={ttsProvider === p.id}
                  recommended={p.recommended}
                  name={p.name}
                  badge={p.badge}
                  description={p.description}
                  onSelect={() => {
                    setTtsProvider(p.id)
                    setTtsVoiceId(p.voices[0]?.id ?? '')
                  }}
                />
              ))}
            </div>

            {selectedTtsDef && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{selectedTtsDef.name} Settings</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {selectedTtsDef.voices.length > 0 && (
                    <div className="space-y-2">
                      <Label>Voice</Label>
                      <Select value={ttsVoiceId} onValueChange={(v) => v && setTtsVoiceId(v)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {selectedTtsDef.voices.map((v) => (
                            <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="flex items-center gap-1.5">
                        <Key className="h-3.5 w-3.5" />
                        API Key
                        {credExistence?.[ttsProvider] && !newTtsKey && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5 text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800">
                            <Check className="h-2.5 w-2.5" />Key saved
                          </Badge>
                        )}
                      </Label>
                      {selectedTtsDef.keyUrl && (
                        <a
                          href={selectedTtsDef.keyUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary flex items-center gap-1 hover:underline"
                        >
                          Get key <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <Input
                      type="password"
                      placeholder={credExistence?.[ttsProvider] ? 'Enter new key to replace…' : selectedTtsDef.keyPlaceholder}
                      value={newTtsKey}
                      onChange={(e) => setNewTtsKey(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Stored server-side only. Never sent to the browser.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="gap-2">
              {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </div>
        )}

        {/* ── Test section ── */}
        {section === 'test' && (
          <div className="space-y-6 max-w-3xl">
            <div>
              <h2 className="text-xl font-semibold">Test Voice Call</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Start a live call with Maya directly from here.
                The agent uses your VoiceAI backend with the current configuration.
              </p>
            </div>

            <Card>
              <CardContent className="pt-4">
                {tenant ? (
                  <VoiceTestWidget tenantId={tenant.id} />
                ) : (
                  <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
                    <Loader2 className="h-5 w-5 animate-spin mr-2" />
                    Loading…
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-amber-500/30 bg-amber-500/5">
              <CardContent className="pt-4">
                <p className="text-sm font-medium text-amber-700 dark:text-amber-400 mb-1">Requirements</p>
                <ul className="text-xs text-amber-600 dark:text-amber-500 space-y-1 list-disc list-inside">
                  <li>VoiceAI backend must be deployed and reachable</li>
                  <li>Set <code className="font-mono">VOICEAI_URL</code> in Vercel environment variables</li>
                  <li>LiveKit credentials configured in VoiceAI backend</li>
                  <li>Allow microphone access in your browser when prompted</li>
                </ul>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}
