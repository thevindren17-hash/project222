'use client'

import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getCurrentTenant } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { Send, RotateCcw, Bot, User, Wrench, AlertCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react'

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  toolCalls?: { tool: string; args: Record<string, unknown>; result: string }[]
}

interface HistoryEntry {
  role: 'user' | 'assistant'
  content: string
}

export default function TestAgentPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [providerInfo, setProviderInfo] = useState<{ provider: string; model: string } | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })
  const { data: settings } = useQuery({
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

  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || ''

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
      const res = await fetch(`${backendUrl}/api/agent/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenant.id, message: text, history }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Unknown error' }))
        throw new Error(err.detail || `Server error ${res.status}`)
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
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to reach the backend')
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
          {(providerInfo || settings?.llm_config) && (
            <Badge variant="secondary" className="text-xs capitalize ml-1">
              {providerInfo?.provider ?? activeProvider}
              {(providerInfo?.model ?? activeModel) ? ` · ${providerInfo?.model ?? activeModel}` : ''}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="text-xs gap-1.5" onClick={() => setShowPrompt((p) => !p)}>
            {showPrompt ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            System Prompt
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={reset} disabled={messages.length === 0}>
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </Button>
        </div>
      </div>

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
      {!hasConfig && (
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
      {hasConfig && !hasApiKey && (
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
            disabled={loading || !tenant || !hasConfig}
            className="flex-1"
            autoFocus
          />
          <Button type="submit" disabled={!input.trim() || loading || !tenant || !hasConfig} size="icon">
            <Send className="h-4 w-4" />
          </Button>
        </form>
        <p className="text-xs text-muted-foreground mt-2 text-center">
          Messages are processed using your live agent configuration. Nothing is saved to the database.
        </p>
      </div>
    </div>
  )
}
