'use client'

import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { format, isToday, isYesterday } from 'date-fns'
import { Send, Bot, User, Phone, MessageSquare, RefreshCw, Mic } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WhatsAppThread } from '@/lib/types'

interface Message {
  id: string
  thread_id: string
  tenant_id: string
  role: string
  handled_by: string
  body: string
  created_at: string
}

function formatThreadTime(date: string) {
  const d = new Date(date)
  if (isToday(d)) return format(d, 'h:mm a')
  if (isYesterday(d)) return 'Yesterday'
  return format(d, 'MMM d')
}

export default function WhatsAppPage() {
  const [selected, setSelected] = useState<WhatsAppThread | null>(null)
  const [reply, setReply] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()

  const { data: threads = [], isLoading: threadsLoading, refetch: refetchThreads } = useQuery({
    queryKey: ['wa-threads'],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) return []
      const { data } = await supabase
        .from('whatsapp_threads')
        .select('*, contact:contacts(name,phone)')
        .eq('tenant_id', tenant.id)
        .order('last_message_at', { ascending: false })
      return (data || []) as WhatsAppThread[]
    },
    refetchInterval: 10000,
  })

  const { data: messages = [] } = useQuery({
    queryKey: ['wa-messages', selected?.id],
    queryFn: async () => {
      if (!selected) return []
      const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('thread_id', selected.id)
        .order('created_at', { ascending: true })
      return (data || []) as Message[]
    },
    enabled: !!selected,
    refetchInterval: selected ? 5000 : false,
  })

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Keep selected thread in sync when threads refresh
  useEffect(() => {
    if (selected && threads.length) {
      const updated = threads.find((t) => t.id === selected.id)
      if (updated) setSelected(updated)
    }
  }, [threads])

  const takeoverMutation = useMutation({
    mutationFn: async (threadId: string) => {
      const { error } = await supabase.from('whatsapp_threads').update({ status: 'human_takeover' }).eq('id', threadId)
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('You\'ve taken over this conversation')
      queryClient.invalidateQueries({ queryKey: ['wa-threads'] })
      queryClient.invalidateQueries({ queryKey: ['wa-messages', selected?.id] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const handbackMutation = useMutation({
    mutationFn: async (threadId: string) => {
      const { error } = await supabase.from('whatsapp_threads').update({ status: 'ai' }).eq('id', threadId)
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Handed back to AI')
      queryClient.invalidateQueries({ queryKey: ['wa-threads'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!selected || !reply.trim()) return
      const tenant = await getCurrentTenant()
      if (!tenant) throw new Error('No tenant')
      const { error } = await supabase.from('messages').insert({
        thread_id: selected.id,
        tenant_id: tenant.id,
        role: 'assistant',
        handled_by: 'staff',
        body: reply.trim(),
      })
      if (error) throw error
      setReply('')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['wa-messages', selected?.id] }),
    onError: (e: Error) => toast.error(e.message),
  })

  const contactName = (t: WhatsAppThread) =>
    (t as any).contact?.name || (t as any).contact?.phone || t.contact_number || 'Unknown'

  const contactPhone = (t: WhatsAppThread) =>
    (t as any).contact?.phone || t.contact_number || ''

  const aiCount = threads.filter((t) => t.status === 'ai').length
  const humanCount = threads.filter((t) => t.status === 'human_takeover').length

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] gap-0">
      {/* ── Page header ── */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div>
          <h1 className="text-3xl font-bold">WhatsApp</h1>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-sm text-muted-foreground">{threads.length} conversations</span>
            {aiCount > 0 && (
              <Badge variant="default" className="gap-1 text-xs">
                <Bot className="h-3 w-3" />{aiCount} AI active
              </Badge>
            )}
            {humanCount > 0 && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <User className="h-3 w-3" />{humanCount} staff handling
              </Badge>
            )}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetchThreads()} className="gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" />Refresh
        </Button>
      </div>

      {/* ── Main grid ── */}
      <div className="flex gap-4 flex-1 min-h-0">

        {/* Thread list */}
        <div className="w-72 shrink-0 flex flex-col border rounded-xl bg-card overflow-hidden">
          <div className="px-4 py-3 border-b bg-muted/30">
            <p className="text-sm font-semibold">Conversations</p>
          </div>
          <div className="flex-1 overflow-y-auto">
            {threadsLoading && (
              <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">Loading...</div>
            )}
            {!threadsLoading && threads.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 gap-3 text-muted-foreground">
                <MessageSquare className="h-8 w-8 opacity-25" />
                <p className="text-sm">No conversations yet</p>
                <p className="text-xs text-center px-4">Messages from WhatsApp will appear here once customers start chatting</p>
              </div>
            )}
            {threads.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelected(t)}
                className={cn(
                  'w-full text-left px-4 py-3 border-b transition-colors hover:bg-muted/40',
                  selected?.id === t.id ? 'bg-primary/5 border-l-2 border-l-primary' : ''
                )}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold shrink-0">
                      {contactName(t).charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{contactName(t)}</p>
                      <p className="text-xs text-muted-foreground truncate">{contactPhone(t)}</p>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0 ml-2">
                    <span className="text-xs text-muted-foreground">{formatThreadTime(t.last_message_at)}</span>
                    {t.status === 'ai' && (
                      <Badge variant="default" className="text-xs px-1.5 py-0 h-4 gap-1">
                        <Bot className="h-2.5 w-2.5" />AI
                      </Badge>
                    )}
                    {t.status === 'human_takeover' && (
                      <Badge variant="secondary" className="text-xs px-1.5 py-0 h-4 gap-1">
                        <User className="h-2.5 w-2.5" />Staff
                      </Badge>
                    )}
                    {t.status === 'resolved' && (
                      <Badge variant="outline" className="text-xs px-1.5 py-0 h-4">Done</Badge>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Conversation view */}
        <div className="flex-1 flex flex-col border rounded-xl bg-card overflow-hidden min-w-0">
          {selected ? (
            <>
              {/* Conversation header */}
              <div className="px-5 py-3 border-b bg-muted/20 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center text-sm font-semibold">
                    {contactName(selected).charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="font-semibold text-sm">{contactName(selected)}</p>
                    <div className="flex items-center gap-1.5">
                      <Phone className="h-3 w-3 text-muted-foreground" />
                      <p className="text-xs text-muted-foreground">{contactPhone(selected)}</p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {selected.status === 'ai' ? (
                    <>
                      <Badge variant="default" className="gap-1">
                        <Bot className="h-3 w-3" />AI Handling
                      </Badge>
                      <Button size="sm" onClick={() => takeoverMutation.mutate(selected.id)}
                        disabled={takeoverMutation.isPending}
                        className="bg-orange-500 hover:bg-orange-600 text-white border-0"
                      >
                        {takeoverMutation.isPending && <span className="mr-1 h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent inline-block" />}
                        Take Over
                      </Button>
                    </>
                  ) : selected.status === 'human_takeover' ? (
                    <>
                      <Badge variant="secondary" className="gap-1">
                        <User className="h-3 w-3" />Staff Handling
                      </Badge>
                      <Button size="sm" variant="outline" onClick={() => handbackMutation.mutate(selected.id)}
                        disabled={handbackMutation.isPending}
                      >
                        {handbackMutation.isPending && <span className="mr-1 h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent inline-block" />}
                        Hand Back to AI
                      </Button>
                    </>
                  ) : (
                    <Badge variant="outline">Resolved</Badge>
                  )}
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.length === 0 && (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                    No messages yet
                  </div>
                )}
                {messages.map((m) => {
                  const isOutbound = m.role !== 'user'
                  const isStaff = isOutbound && m.handled_by === 'staff'
                  return (
                    <div key={m.id} className={cn('flex gap-2', isOutbound ? 'justify-end' : 'justify-start')}>
                      {!isOutbound && (
                        <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center text-xs font-semibold shrink-0 mt-auto">
                          {contactName(selected).charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div className={cn(
                        'max-w-[72%] rounded-2xl px-4 py-2.5',
                        !isOutbound
                          ? 'bg-muted rounded-bl-sm'
                          : isStaff
                            ? 'bg-orange-500 text-white rounded-br-sm'
                            : 'bg-primary text-primary-foreground rounded-br-sm'
                      )}>
                        {isOutbound && (
                          <p className={cn('text-xs font-medium mb-0.5', isStaff ? 'text-orange-100' : 'text-primary-foreground/70')}>
                            {isStaff ? 'Staff' : 'AI'}
                          </p>
                        )}
                        {(m as any).message_type === 'audio' ? (
                          <div className="flex items-center gap-2 py-0.5">
                            <Mic className="h-4 w-4 opacity-70 shrink-0" />
                            <div className="flex-1">
                              {m.body ? (
                                <p className="text-sm leading-relaxed italic opacity-90">"{m.body}"</p>
                              ) : (
                                <p className="text-sm opacity-60">Voice message</p>
                              )}
                            </div>
                          </div>
                        ) : (
                          <p className="text-sm leading-relaxed">{m.body}</p>
                        )}
                        <p className={cn('text-xs mt-1', isOutbound ? 'text-right opacity-70' : 'text-muted-foreground')}>
                          {format(new Date(m.created_at), 'h:mm a')}
                        </p>
                      </div>
                      {isOutbound && (
                        <div className={cn(
                          'h-7 w-7 rounded-full flex items-center justify-center shrink-0 mt-auto',
                          isStaff ? 'bg-orange-100 dark:bg-orange-900' : 'bg-primary/10'
                        )}>
                          {isStaff
                            ? <User className="h-3.5 w-3.5 text-orange-500" />
                            : <Bot className="h-3.5 w-3.5 text-primary" />}
                        </div>
                      )}
                    </div>
                  )
                })}
                <div ref={bottomRef} />
              </div>

              {/* Input area */}
              {selected.status === 'human_takeover' ? (
                <div className="px-4 py-3 border-t bg-muted/20 flex gap-2 shrink-0">
                  <Input
                    placeholder="Type a message as staff..."
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMutation.mutate() } }}
                    className="bg-background"
                  />
                  <Button size="icon" onClick={() => sendMutation.mutate()} disabled={!reply.trim() || sendMutation.isPending}>
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="px-4 py-3 border-t bg-muted/10 shrink-0">
                  <p className="text-xs text-center text-muted-foreground">
                    {selected.status === 'ai'
                      ? 'AI is handling this conversation — click Take Over to respond as staff'
                      : 'This conversation is resolved'}
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
              <MessageSquare className="h-12 w-12 opacity-20" />
              <p className="font-medium">Select a conversation</p>
              <p className="text-sm text-center max-w-xs">Choose a conversation from the left to view messages and manage AI or staff handling</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
