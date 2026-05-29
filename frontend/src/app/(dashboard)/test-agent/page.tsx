'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getCurrentTenant } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { Send, RotateCcw, Bot, User, Wrench, AlertCircle, Loader2, ChevronDown, ChevronUp, Phone, PhoneOff, Mic, MicOff, MessageSquare } from 'lucide-react'

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  toolCalls?: { tool: string; args: Record<string, unknown>; result: string }[]
}

interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
}

// ─── Voice Call Tab ────────────────────────────────────────────────────────────

type CallState = 'idle' | 'connecting' | 'connected' | 'error'

interface TranscriptLine {
  id: string
  speaker: 'user' | 'agent'
  text: string
  isFinal: boolean
}

function VoiceCallTab({ tenantId }: { tenantId: string }) {
  const [callState, setCallState] = useState<CallState>('idle')
  const [agentSpeaking, setAgentSpeaking] = useState(false)
  const [micMuted, setMicMuted] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [errorMsg, setErrorMsg] = useState('')
  const [transcript, setTranscript] = useState<TranscriptLine[]>([])
  const roomRef = useRef<import('livekit-client').Room | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const audioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map())

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript])

  useEffect(() => {
    return () => {
      timerRef.current && clearInterval(timerRef.current)
      roomRef.current?.disconnect()
    }
  }, [])

  const startCall = useCallback(async () => {
    setCallState('connecting')
    setErrorMsg('')
    setElapsed(0)
    setTranscript([])

    try {
      const { Room, RoomEvent } = await import('livekit-client')

      const res = await fetch('/api/voice-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenantId, participant_name: 'Dashboard Test' }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `Token error ${res.status}`)
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

      // Detect agent speaking via active speakers
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers: import('livekit-client').Participant[]) => {
        const localId = room.localParticipant.identity
        setAgentSpeaking(speakers.some((s) => s.identity !== localId))
      })

      room.on(RoomEvent.Disconnected, () => {
        audioElementsRef.current.forEach((el) => el.remove())
        audioElementsRef.current.clear()
        setCallState('idle')
        setAgentSpeaking(false)
        timerRef.current && clearInterval(timerRef.current)
      })

      // Attach remote audio tracks so we can hear the agent
      room.on(RoomEvent.TrackSubscribed, (track: import('livekit-client').RemoteTrack) => {
        if (track.kind === 'audio') {
          const el = track.attach() as HTMLAudioElement
          el.autoplay = true
          document.body.appendChild(el)
          audioElementsRef.current.set(track.sid, el)
        }
      })
      room.on(RoomEvent.TrackUnsubscribed, (track: import('livekit-client').RemoteTrack) => {
        if (track.kind === 'audio') {
          track.detach()
          const el = audioElementsRef.current.get(track.sid)
          if (el) {
            el.remove()
            audioElementsRef.current.delete(track.sid)
          }
        }
      })

      await room.connect(url, token)
      await room.localParticipant.setMicrophoneEnabled(true)

      setCallState('connected')
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to start call')
      setCallState('error')
    }
  }, [tenantId])

  const endCall = useCallback(async () => {
    timerRef.current && clearInterval(timerRef.current)
    await roomRef.current?.disconnect()
    roomRef.current = null
    audioElementsRef.current.forEach((el) => el.remove())
    audioElementsRef.current.clear()
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

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

  const showTranscript = callState === 'connected' || transcript.length > 0

  return (
    <div className={cn(
      'flex-1 flex gap-6 px-6 py-8',
      showTranscript ? 'items-start justify-center' : 'items-center justify-center'
    )}>
      {/* Call card */}
      <Card className="w-full max-w-sm shrink-0">
        <CardHeader className="text-center pb-2">
          <div className="flex justify-center mb-3">
            <div className={cn(
              'h-20 w-20 rounded-full flex items-center justify-center transition-all duration-300',
              callState === 'connected' && agentSpeaking
                ? 'bg-primary/20 ring-4 ring-primary/30 animate-pulse'
                : callState === 'connected'
                ? 'bg-primary/10'
                : 'bg-muted'
            )}>
              <Bot className={cn('h-10 w-10', callState === 'connected' ? 'text-primary' : 'text-muted-foreground')} />
            </div>
          </div>
          <CardTitle className="text-lg">Maya — Voice Receptionist</CardTitle>
          <p className="text-sm text-muted-foreground">
            {callState === 'idle' && 'Click to start a live voice call'}
            {callState === 'connecting' && 'Connecting to Maya…'}
            {callState === 'connected' && !agentSpeaking && `Connected · ${fmt(elapsed)}`}
            {callState === 'connected' && agentSpeaking && `Maya is speaking · ${fmt(elapsed)}`}
            {callState === 'error' && 'Connection failed'}
          </p>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4 pt-4">
          {callState === 'error' && errorMsg && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-lg w-full">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {errorMsg}
            </div>
          )}

          {callState === 'connected' && (
            <div className="flex gap-3 w-full">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 gap-2"
                onClick={toggleMic}
              >
                {micMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                {micMuted ? 'Unmute' : 'Mute'}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="flex-1 gap-2"
                onClick={endCall}
              >
                <PhoneOff className="h-4 w-4" />
                End Call
              </Button>
            </div>
          )}

          {(callState === 'idle' || callState === 'error') && (
            <Button className="w-full gap-2" onClick={startCall}>
              <Phone className="h-4 w-4" />
              Start Voice Call
            </Button>
          )}

          {callState === 'connecting' && (
            <Button disabled className="w-full gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Connecting…
            </Button>
          )}

          <p className="text-xs text-muted-foreground text-center">
            Speaks in English, Malay, Tamil or Mandarin — just talk naturally.
          </p>
        </CardContent>
      </Card>

      {/* Transcript panel */}
      {showTranscript && (
        <div className="flex flex-col w-full max-w-md h-[calc(100vh-12rem)] min-h-64">
          <div className="flex items-center justify-between mb-2 shrink-0">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Live Transcript</p>
            {callState === 'connected' && (
              <span className="flex items-center gap-1.5 text-xs text-emerald-500">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Live
              </span>
            )}
          </div>
          <div className="flex-1 rounded-lg border border-border bg-muted/30 overflow-y-auto p-4">
            {transcript.length === 0 ? (
              <p className="text-xs text-muted-foreground italic text-center pt-8">
                Transcript will appear here as you speak…
              </p>
            ) : (
              <div className="space-y-3">
                {transcript.map((line) => (
                  <div
                    key={line.id}
                    className={cn(
                      'flex gap-2',
                      line.speaker === 'user' ? 'flex-row-reverse' : 'flex-row'
                    )}
                  >
                    <div className={cn(
                      'h-5 w-5 rounded-full flex items-center justify-center shrink-0 mt-0.5',
                      line.speaker === 'user' ? 'bg-primary text-primary-foreground' : 'bg-background border border-border'
                    )}>
                      {line.speaker === 'user'
                        ? <User className="h-3 w-3" />
                        : <Bot className="h-3 w-3 text-primary" />}
                    </div>
                    <p className={cn(
                      'text-sm leading-snug max-w-[85%] px-3 py-1.5 rounded-xl',
                      line.speaker === 'user'
                        ? 'bg-primary text-primary-foreground rounded-tr-sm'
                        : 'bg-background border border-border rounded-tl-sm',
                      !line.isFinal && 'opacity-60 italic'
                    )}>
                      {line.text}
                    </p>
                  </div>
                ))}
                <div ref={transcriptEndRef} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function TestAgentPage() {
  const [activeTab, setActiveTab] = useState<'text' | 'voice'>('text')
  const [messages, setMessages] = useState<Message[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [providerInfo, setProviderInfo] = useState<{ provider: string; model: string } | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const queryClient = useQueryClient()
  const { data: tenant, isLoading: tenantLoading } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })
  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: async () => {
      if (!tenant) return null
      const { data } = await (await import('@/lib/supabase')).supabase
        .from('tenant_settings')
        .select('system_prompt,agent_name,llm_config,provider_credentials')
        .eq('tenant_id', tenant.id)
        .maybeSingle()
      return data
    },
    enabled: !!tenant,
  })
  const isLoadingConfig = tenantLoading || (!!tenant && settingsLoading)

  // Proxy route handles the actual backend call — works on both Vercel and local
  const agentTestUrl = '/api/agent/test'

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendMessage() {
    const text = input.trim()
    if (!text || !tenant || loading) return

    setInput('')
    setError('')
    setLoading(true)

    const userMsg: Message = { role: 'user', content: text }
    setMessages((prev) => [...prev, userMsg])

    try {
      const res = await fetch(agentTestUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenant.id, message: text, history }),
      })

      if (!res.ok) {
        const body = await res.text()
        let detail: string
        try {
          const err = JSON.parse(body)
          if (err.detail && typeof err.detail === 'string') {
            detail = err.detail
          } else if (Array.isArray(err.detail)) {
            detail = `Validation error (${res.status})`
          } else {
            detail = `Error ${res.status}`
          }
        } catch {
          detail = `Error ${res.status}: ${body.slice(0, 120) || res.statusText}`
        }
        throw new Error(detail)
      }

      const data = await res.json()

      setProviderInfo({ provider: data.provider, model: data.model })
      setHistory(data.history)

      const assistantMsg: Message = {
        role: 'assistant',
        content: data.reply,
        toolCalls: data.tool_calls?.length ? data.tool_calls : undefined,
      }
      setMessages((prev) => [...prev, assistantMsg])

      const bookingTools = ['book_appointment', 'cancel_appointment', 'reschedule_appointment']
      if (data.tool_calls?.some((tc: { tool: string }) => bookingTools.includes(tc.tool))) {
        queryClient.invalidateQueries({ queryKey: ['bookings'] })
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to reach the backend'
      setError(msg)
      setMessages((prev) => prev.slice(0, -1))
      setInput(text)
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  function reset() {
    setMessages([])
    setHistory([])
    setError('')
    setProviderInfo(null)
    inputRef.current?.focus()
  }

  const agentName = settings?.agent_name || 'Maya'
  const systemPrompt = settings?.system_prompt || ''
  const hasConfig = !!systemPrompt
  const activeProvider = settings?.llm_config?.provider || 'groq'
  const activeModel = settings?.llm_config?.model || ''
  const hasApiKey = !!(settings?.provider_credentials as Record<string, Record<string, string>> | null)?.[activeProvider]?.api_key

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] -mx-6 -mt-6 -mb-6">

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border bg-card shrink-0">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center">
            <Bot className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="font-semibold text-sm">{agentName}</p>
            <p className="text-xs text-muted-foreground">Test Environment — no data is saved</p>
          </div>
          {activeTab === 'text' && (providerInfo || settings?.llm_config) && (
            <Badge variant="secondary" className="text-xs capitalize ml-1">
              {providerInfo?.provider ?? activeProvider}
              {(providerInfo?.model ?? activeModel) ? ` · ${providerInfo?.model ?? activeModel}` : ''}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Tab switcher */}
          <div className="flex items-center rounded-lg border border-border bg-muted p-0.5 gap-0.5">
            <button
              onClick={() => setActiveTab('text')}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                activeTab === 'text' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <MessageSquare className="h-3.5 w-3.5" />Text
            </button>
            <button
              onClick={() => setActiveTab('voice')}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                activeTab === 'voice' ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Phone className="h-3.5 w-3.5" />Voice
            </button>
          </div>
          {activeTab === 'text' && (
            <>
              <Button variant="ghost" size="sm" className="text-xs gap-1.5" onClick={() => setShowPrompt((p) => !p)}>
                {showPrompt ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                System Prompt
              </Button>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={reset} disabled={messages.length === 0}>
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </Button>
            </>
          )}
        </div>
      </div>

      {/* ── Voice Tab ── */}
      {activeTab === 'voice' && tenant && (
        <VoiceCallTab tenantId={tenant.id} />
      )}
      {activeTab === 'voice' && !tenant && (
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>
      )}

      {/* ── Text Tab content (hidden when on voice tab) ── */}
      {activeTab === 'text' && <>

      {/* ── System prompt preview ── */}
      {showPrompt && (
        <div className="px-6 py-3 border-b border-border bg-muted/40 shrink-0">
          {systemPrompt ? (
            <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground max-h-40 overflow-y-auto leading-relaxed">
              {systemPrompt}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground italic">No system prompt configured — go to Agent Config first.</p>
          )}
        </div>
      )}

      {/* ── No config warning ── */}
      {!isLoadingConfig && !hasConfig && (
        <div className="mx-6 mt-4 shrink-0">
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <AlertCircle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-700 dark:text-amber-400">No agent configured</p>
              <p className="text-xs text-amber-600 dark:text-amber-500 mt-0.5">
                Set a system prompt in <strong>Agent Config → Instructions</strong> and click <strong>Save Changes</strong> before testing.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Missing API key warning ── */}
      {!isLoadingConfig && hasConfig && !hasApiKey && (
        <div className="mx-6 mt-4 shrink-0">
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <AlertCircle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                No API key for <span className="capitalize">{activeProvider}</span>
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-500 mt-0.5">
                Go to <strong>Agent Config → Model Settings</strong>, enter your {activeProvider === 'groq' ? 'Groq' : activeProvider === 'google' ? 'Google' : activeProvider === 'anthropic' ? 'Anthropic' : activeProvider === 'mistral' ? 'Mistral' : 'OpenAI'} API key, and click <strong>Save Changes</strong>.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Messages ── */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">

        {messages.length === 0 && hasConfig && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground select-none">
            <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Bot className="h-8 w-8 text-primary/60" />
            </div>
            <p className="text-sm font-medium">Send a message to start testing</p>
            <p className="text-xs max-w-xs text-center">Simulate a patient conversation exactly as it would happen on WhatsApp. Tools are active.</p>
            <div className="flex flex-wrap gap-2 justify-center mt-2">
              {[
                'Hi, I want to book a checkup',
                'What are your opening hours?',
                'Can I cancel my appointment?',
                'I need to speak to someone urgently',
              ].map((s) => (
                <button
                  key={s}
                  onClick={() => { setInput(s); inputRef.current?.focus() }}
                  className="text-xs px-3 py-1.5 rounded-full border border-border hover:bg-muted transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={cn('flex gap-3', msg.role === 'user' ? 'flex-row-reverse' : 'flex-row')}>

            {/* Avatar */}
            <div className={cn(
              'h-7 w-7 rounded-full flex items-center justify-center shrink-0 mt-0.5',
              msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
            )}>
              {msg.role === 'user'
                ? <User className="h-3.5 w-3.5" />
                : <Bot className="h-3.5 w-3.5 text-primary" />}
            </div>

            <div className={cn('flex flex-col gap-1.5 max-w-[72%]', msg.role === 'user' && 'items-end')}>
              {/* Bubble */}
              <div className={cn(
                'rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground rounded-tr-sm'
                  : 'bg-muted rounded-tl-sm'
              )}>
                {msg.content}
              </div>

              {/* Tool calls */}
              {msg.toolCalls?.map((tc, j) => (
                <div key={j} className="flex items-start gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs">
                  <Wrench className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                  <div>
                    <span className="font-mono font-semibold">{tc.tool}</span>
                    {Object.keys(tc.args).length > 0 && (
                      <span className="text-muted-foreground ml-1">
                        ({Object.entries(tc.args).map(([k, v]) => `${k}: ${v}`).join(', ')})
                      </span>
                    )}
                    <p className="text-muted-foreground mt-0.5">{tc.result}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Loading bubble */}
        {loading && (
          <div className="flex gap-3">
            <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
              <Bot className="h-3.5 w-3.5 text-primary" />
            </div>
            <div className="rounded-2xl rounded-tl-sm bg-muted px-4 py-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Error ── */}
      {error && (
        <div className="mx-6 mb-2 shrink-0">
          <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        </div>
      )}

      {/* ── Input ── */}
      <div className="px-6 py-4 border-t border-border bg-card shrink-0">
        <form
          onSubmit={(e) => { e.preventDefault(); sendMessage() }}
          className="flex gap-2"
        >
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={hasConfig ? 'Type a message as a patient…' : 'Configure your agent first'}
            disabled={loading || isLoadingConfig || !tenant || !hasConfig}
            className="flex-1"
            autoFocus
          />
          <Button type="submit" disabled={!input.trim() || loading || isLoadingConfig || !tenant || !hasConfig} size="icon">
            <Send className="h-4 w-4" />
          </Button>
        </form>
        <p className="text-xs text-muted-foreground mt-2 text-center">
          Messages are processed using your live agent configuration. Nothing is saved to the database.
        </p>
      </div>

      </> /* end activeTab === 'text' */}
    </div>
  )
}
