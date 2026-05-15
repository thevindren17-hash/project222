'use client'

import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { format, isToday, isYesterday, formatDistanceToNow } from 'date-fns'
import {
  Send, Bot, User, Phone, MessageSquare, Mic,
  Search, Copy, Check, Pencil, X, Tag, Plus, Wifi, WifiOff, Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WhatsAppThread } from '@/lib/types'

interface Message {
  id: string
  thread_id: string
  tenant_id: string
  role: string
  handled_by: string
  body: string
  message_type?: string
  created_at: string
}

const PRESET_TAGS = ['Urgent', 'Follow Up', 'Interested', 'No Show', 'VIP', 'Resolved', 'Warm', 'Cold']

function formatThreadTime(date: string) {
  const d = new Date(date)
  if (isToday(d)) return format(d, 'h:mm a')
  if (isYesterday(d)) return 'Yesterday'
  return format(d, 'MMM d')
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button onClick={copy} className="text-muted-foreground hover:text-foreground transition-colors ml-1">
      {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

export default function WhatsAppPage() {
  const [selected, setSelected] = useState<WhatsAppThread | null>(null)
  const [reply, setReply] = useState('')
  const [search, setSearch] = useState('')
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [showTagInput, setShowTagInput] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()

  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })

  const { data: threads = [], isLoading: threadsLoading } = useQuery({
    queryKey: ['wa-threads'],
    queryFn: async () => {
      const t = await getCurrentTenant()
      if (!t) return []
      const { data } = await supabase
        .from('whatsapp_threads')
        .select('*, contact:contacts(name,phone)')
        .eq('tenant_id', t.id)
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

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  useEffect(() => {
    if (selected && threads.length) {
      const updated = threads.find((t) => t.id === selected.id)
      if (updated) setSelected(updated)
    }
  }, [threads])

  const contactName = (t: WhatsAppThread) =>
    (t as any).contact?.name || t.contact_name || t.wa_contact_name || ''

  const contactPhone = (t: WhatsAppThread) =>
    (t as any).contact?.phone || t.contact_number || ''

  const displayName = (t: WhatsAppThread) => contactName(t) || contactPhone(t) || 'Unknown'

  const filteredThreads = threads.filter((t) => {
    if (!search) return true
    const q = search.toLowerCase()
    return displayName(t).toLowerCase().includes(q) || contactPhone(t).includes(q)
  })

  const takeoverMutation = useMutation({
    mutationFn: async (threadId: string) => {
      const { error } = await supabase.from('whatsapp_threads').update({ status: 'human_takeover' }).eq('id', threadId)
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('You\'ve taken over this conversation')
      queryClient.invalidateQueries({ queryKey: ['wa-threads'] })
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

  const saveNameMutation = useMutation({
    mutationFn: async () => {
      if (!selected) return
      const name = nameInput.trim()
      if (!name) return
      if (selected.contact_id) {
        const { error } = await supabase.from('contacts').update({ name }).eq('id', selected.contact_id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('whatsapp_threads').update({ contact_name: name }).eq('id', selected.id)
        if (error) throw error
      }
    },
    onSuccess: () => {
      toast.success('Name saved')
      setEditingName(false)
      queryClient.invalidateQueries({ queryKey: ['wa-threads'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const updateTagsMutation = useMutation({
    mutationFn: async (tags: string[]) => {
      if (!selected) return
      const { error } = await supabase.from('whatsapp_threads').update({ tags }).eq('id', selected.id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['wa-threads'] }),
    onError: (e: Error) => toast.error(e.message),
  })

  const deleteConversationMutation = useMutation({
    mutationFn: async () => {
      if (!selected) return
      const res = await fetch('/api/whatsapp/delete-conversation', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: selected.id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Delete failed')
    },
    onSuccess: () => {
      toast.success('Conversation deleted')
      setSelected(null)
      setShowDeleteConfirm(false)
      queryClient.invalidateQueries({ queryKey: ['wa-threads'] })
      queryClient.removeQueries({ queryKey: ['wa-messages', selected?.id] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  function addTag(tag: string) {
    if (!selected) return
    const t = tag.trim()
    if (!t) return
    const current = selected.tags || []
    if (current.includes(t)) return
    updateTagsMutation.mutate([...current, t])
    setTagInput('')
    setShowTagInput(false)
  }

  function removeTag(tag: string) {
    if (!selected) return
    updateTagsMutation.mutate((selected.tags || []).filter((t) => t !== tag))
  }

  function startEditName() {
    setNameInput(selected ? contactName(selected) : '')
    setEditingName(true)
  }

  const aiCount = threads.filter((t) => t.status === 'ai').length
  const humanCount = threads.filter((t) => t.status === 'human_takeover').length

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)]">
      {/* Page header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div>
          <h1 className="text-3xl font-bold">WhatsApp</h1>
          <div className="flex items-center gap-2 mt-1">
            {/* Connected number pill */}
            {tenant?.wa_phone_number_id ? (
              <div className="flex items-center gap-1.5 bg-green-500/10 border border-green-500/30 rounded-full px-2.5 py-0.5">
                <Wifi className="h-3 w-3 text-green-500" />
                <span className="text-xs font-medium text-green-700 dark:text-green-400">
                  {tenant.wa_phone_number || tenant.wa_phone_number_id}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 bg-muted rounded-full px-2.5 py-0.5">
                <WifiOff className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">No number connected</span>
              </div>
            )}
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
      </div>

      {/* Three-panel layout */}
      <div className="flex gap-3 flex-1 min-h-0">

        {/* ── Left: Thread list ── */}
        <div className="w-64 shrink-0 flex flex-col border rounded-xl bg-card overflow-hidden">
          <div className="px-3 py-2.5 border-b">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Conversations</p>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-7 text-xs bg-muted/40 border-0 focus-visible:ring-1"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {threadsLoading && (
              <div className="flex items-center justify-center py-12 text-muted-foreground text-xs">Loading...</div>
            )}
            {!threadsLoading && filteredThreads.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                <MessageSquare className="h-7 w-7 opacity-20" />
                <p className="text-xs">{search ? 'No matches' : 'No conversations yet'}</p>
              </div>
            )}
            {filteredThreads.map((t) => {
              const name = displayName(t)
              const phone = contactPhone(t)
              const isSelected = selected?.id === t.id
              return (
                <button
                  key={t.id}
                  onClick={() => setSelected(t)}
                  className={cn(
                    'w-full text-left px-3 py-3 border-b transition-colors hover:bg-muted/40 group',
                    isSelected ? 'bg-primary/8 border-l-2 border-l-primary' : ''
                  )}
                >
                  <div className="flex items-start gap-2.5">
                    <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold shrink-0 mt-0.5">
                      {name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1 mb-0.5">
                        <p className="font-medium text-xs truncate">{name}</p>
                        <span className="text-[10px] text-muted-foreground shrink-0">{formatThreadTime(t.last_message_at)}</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground truncate mb-1">{phone}</p>
                      <div className="flex items-center gap-1">
                        {t.status === 'ai' && (
                          <Badge variant="default" className="text-[9px] px-1 py-0 h-3.5 gap-0.5 leading-none">
                            <Bot className="h-2 w-2" />AI
                          </Badge>
                        )}
                        {t.status === 'human_takeover' && (
                          <Badge variant="secondary" className="text-[9px] px-1 py-0 h-3.5 gap-0.5 leading-none">
                            <User className="h-2 w-2" />Staff
                          </Badge>
                        )}
                        {t.status === 'resolved' && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 leading-none">Done</Badge>
                        )}
                        {(t.tags || []).slice(0, 1).map((tag) => (
                          <Badge key={tag} variant="outline" className="text-[9px] px-1 py-0 h-3.5 leading-none max-w-[60px] truncate">{tag}</Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* ── Middle: Chat ── */}
        <div className="flex-1 flex flex-col border rounded-xl bg-card overflow-hidden min-w-0">
          {selected ? (
            <>
              {/* Compact header */}
              <div className="px-4 py-2.5 border-b bg-muted/20 flex items-center gap-3 shrink-0">
                <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-sm font-semibold shrink-0">
                  {displayName(selected).charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate">{displayName(selected)}</p>
                  <p className="text-xs text-muted-foreground">{contactPhone(selected)}</p>
                </div>
                {selected.status === 'ai' && (
                  <Badge variant="default" className="gap-1 shrink-0 text-xs">
                    <Bot className="h-3 w-3" />AI Handling
                  </Badge>
                )}
                {selected.status === 'human_takeover' && (
                  <Badge variant="secondary" className="gap-1 shrink-0 text-xs">
                    <User className="h-3 w-3" />Staff Handling
                  </Badge>
                )}
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
                {messages.length === 0 && (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-sm">No messages yet</div>
                )}
                {messages.map((m) => {
                  const isOutbound = m.role !== 'user'
                  const isStaff = isOutbound && m.handled_by === 'staff'
                  return (
                    <div key={m.id} className={cn('flex gap-2', isOutbound ? 'justify-end' : 'justify-start')}>
                      {!isOutbound && (
                        <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-semibold shrink-0 mt-auto">
                          {displayName(selected).charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div className={cn(
                        'max-w-[70%] rounded-2xl px-3.5 py-2',
                        !isOutbound
                          ? 'bg-muted rounded-bl-sm'
                          : isStaff
                            ? 'bg-orange-500 text-white rounded-br-sm'
                            : 'bg-primary text-primary-foreground rounded-br-sm'
                      )}>
                        {isOutbound && (
                          <p className={cn('text-[10px] font-medium mb-0.5 opacity-75')}>
                            {isStaff ? 'You' : 'AI Agent'}
                          </p>
                        )}
                        {m.message_type === 'audio' ? (
                          <div className="flex items-center gap-2">
                            <Mic className="h-3.5 w-3.5 opacity-70 shrink-0" />
                            {m.body
                              ? <p className="text-sm italic opacity-90">"{m.body}"</p>
                              : <p className="text-sm opacity-60">Voice message</p>}
                          </div>
                        ) : (
                          <p className="text-sm leading-relaxed">{m.body}</p>
                        )}
                        <p className={cn('text-[10px] mt-0.5', isOutbound ? 'text-right opacity-60' : 'text-muted-foreground')}>
                          {format(new Date(m.created_at), 'h:mm a')}
                        </p>
                      </div>
                      {isOutbound && (
                        <div className={cn(
                          'h-6 w-6 rounded-full flex items-center justify-center shrink-0 mt-auto',
                          isStaff ? 'bg-orange-100 dark:bg-orange-900' : 'bg-primary/10'
                        )}>
                          {isStaff
                            ? <User className="h-3 w-3 text-orange-500" />
                            : <Bot className="h-3 w-3 text-primary" />}
                        </div>
                      )}
                    </div>
                  )
                })}
                <div ref={bottomRef} />
              </div>

              {/* Input */}
              {selected.status === 'human_takeover' ? (
                <div className="px-3 py-2.5 border-t bg-muted/10 flex gap-2 shrink-0">
                  <Input
                    placeholder="Type or drag and drop attachments..."
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMutation.mutate() } }}
                    className="bg-background text-sm"
                  />
                  <Button size="icon" onClick={() => sendMutation.mutate()} disabled={!reply.trim() || sendMutation.isPending}>
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="px-4 py-2.5 border-t bg-muted/10 shrink-0">
                  <p className="text-xs text-center text-muted-foreground">
                    {selected.status === 'ai'
                      ? 'AI is handling this conversation — click "Continue Chat Yourself" in the panel →'
                      : 'This conversation is resolved'}
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
              <MessageSquare className="h-12 w-12 opacity-15" />
              <p className="font-medium">Select a conversation</p>
              <p className="text-sm text-center max-w-xs opacity-70">Choose a conversation from the left to view messages and manage AI or staff handling</p>
            </div>
          )}
        </div>

        {/* ── Right: Info panel ── */}
        <div className="w-64 shrink-0 flex flex-col border rounded-xl bg-card overflow-hidden">
          {selected ? (
            <div className="flex-1 overflow-y-auto">
              {/* Contact header */}
              <div className="px-4 pt-5 pb-4 flex flex-col items-center text-center border-b">
                <div className="flex items-center justify-center gap-2 mb-3">
                  <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center ring-2 ring-primary/20">
                    <Bot className="h-5 w-5 text-primary" />
                  </div>
                  <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center ring-2 ring-border text-sm font-semibold -ml-2">
                    {displayName(selected).charAt(0).toUpperCase()}
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground mb-1">Conversation between</p>
                <p className="text-xs font-semibold">AI Agent &amp; {displayName(selected)}</p>
              </div>

              <div className="px-3 py-3 space-y-3">
                {/* Contact name edit */}
                {editingName ? (
                  <div className="flex gap-1.5">
                    <Input
                      value={nameInput}
                      onChange={(e) => setNameInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveNameMutation.mutate() }}
                      placeholder="Contact name..."
                      className="h-7 text-xs flex-1"
                      autoFocus
                    />
                    <Button size="icon" className="h-7 w-7 shrink-0" onClick={() => saveNameMutation.mutate()} disabled={saveNameMutation.isPending}>
                      <Check className="h-3 w-3" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => setEditingName(false)}>
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ) : contactName(selected) ? (
                  <button onClick={startEditName} className="w-full flex items-center gap-2 p-2 rounded-lg hover:bg-muted/50 transition-colors group text-left">
                    <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs flex-1 truncate">{contactName(selected)}</span>
                    <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                  </button>
                ) : (
                  <button onClick={startEditName} className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-dashed text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors">
                    <Plus className="h-3 w-3" />Add User Name
                  </button>
                )}

                {/* Phone */}
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-muted/30">
                  <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-xs flex-1 truncate font-mono">{contactPhone(selected)}</span>
                  <CopyButton text={contactPhone(selected)} />
                </div>

                {/* Transcript URL */}
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-muted/30">
                  <MessageSquare className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-xs flex-1 truncate text-muted-foreground">Transcript URL</span>
                  <CopyButton text={`${typeof window !== 'undefined' ? window.location.origin : ''}/whatsapp/transcript/${selected.id}`} />
                </div>

                <Separator />

                {/* AI / Human status + takeover */}
                {selected.status === 'ai' && (
                  <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full bg-green-400 shrink-0" />
                      <p className="text-xs font-semibold">Chat is being handled by AI</p>
                    </div>
                    <Button
                      size="sm"
                      className="w-full bg-primary hover:bg-primary/90 text-primary-foreground text-xs h-8"
                      onClick={() => takeoverMutation.mutate(selected.id)}
                      disabled={takeoverMutation.isPending}
                    >
                      {takeoverMutation.isPending
                        ? <span className="h-3 w-3 mr-1.5 animate-spin rounded-full border-2 border-white border-t-transparent inline-block" />
                        : <User className="h-3.5 w-3.5 mr-1.5" />}
                      Continue Chat Yourself
                    </Button>
                    <p className="text-[10px] text-muted-foreground text-center">You can pass the chat back to AI.</p>
                  </div>
                )}

                {selected.status === 'human_takeover' && (
                  <div className="rounded-xl border border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-950/30 p-3 space-y-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-2 rounded-full bg-orange-400 shrink-0" />
                      <p className="text-xs font-semibold text-orange-800 dark:text-orange-300">You are handling this chat</p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full text-xs h-8"
                      onClick={() => handbackMutation.mutate(selected.id)}
                      disabled={handbackMutation.isPending}
                    >
                      {handbackMutation.isPending
                        ? <span className="h-3 w-3 mr-1.5 animate-spin rounded-full border-2 border-current border-t-transparent inline-block" />
                        : <Bot className="h-3.5 w-3.5 mr-1.5" />}
                      Pass Back to AI
                    </Button>
                  </div>
                )}

                {selected.status === 'resolved' && (
                  <div className="rounded-xl border bg-muted/40 p-3 text-center">
                    <p className="text-xs text-muted-foreground">Conversation resolved</p>
                  </div>
                )}

                {/* Last activity */}
                <p className="text-[10px] text-muted-foreground text-center">
                  Last message{' '}
                  {formatDistanceToNow(new Date(selected.last_message_at), { addSuffix: true })}
                </p>

                <Separator />

                {/* Tags */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold flex items-center gap-1.5">
                      <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                      Tags {(selected.tags || []).length > 0 && <span className="text-muted-foreground font-normal">({(selected.tags || []).length})</span>}
                    </p>
                    <button
                      onClick={() => setShowTagInput((v) => !v)}
                      className="text-[10px] text-primary hover:underline"
                    >
                      + Add
                    </button>
                  </div>

                  {showTagInput && (
                    <div className="space-y-1.5">
                      <div className="flex gap-1">
                        <Input
                          value={tagInput}
                          onChange={(e) => setTagInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') addTag(tagInput) }}
                          placeholder="Tag name..."
                          className="h-6 text-xs flex-1"
                          autoFocus
                        />
                        <Button size="icon" className="h-6 w-6 shrink-0" onClick={() => addTag(tagInput)}>
                          <Check className="h-3 w-3" />
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {PRESET_TAGS.filter((pt) => !(selected.tags || []).includes(pt)).map((pt) => (
                          <button
                            key={pt}
                            onClick={() => addTag(pt)}
                            className="text-[9px] px-1.5 py-0.5 rounded border hover:bg-primary hover:text-primary-foreground hover:border-primary transition-colors text-muted-foreground"
                          >
                            {pt}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {(selected.tags || []).length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {(selected.tags || []).map((tag) => (
                        <div key={tag} className="flex items-center gap-0.5 bg-muted rounded-md px-2 py-0.5">
                          <span className="text-[10px]">{tag}</span>
                          <button onClick={() => removeTag(tag)} className="ml-0.5 text-muted-foreground hover:text-destructive transition-colors leading-none">
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {!showTagInput && (selected.tags || []).length === 0 && (
                    <p className="text-[10px] text-muted-foreground">Add or remove tags associated with this conversation.</p>
                  )}
                </div>

                <Separator />

                {/* Delete conversation */}
                {showDeleteConfirm ? (
                  <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 space-y-2">
                    <p className="text-xs font-semibold text-destructive">Delete this conversation?</p>
                    <p className="text-[10px] text-muted-foreground">All messages will be permanently removed. This cannot be undone.</p>
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        variant="destructive"
                        className="flex-1 h-7 text-xs"
                        onClick={() => deleteConversationMutation.mutate()}
                        disabled={deleteConversationMutation.isPending}
                      >
                        {deleteConversationMutation.isPending
                          ? <span className="h-3 w-3 mr-1 animate-spin rounded-full border-2 border-white border-t-transparent inline-block" />
                          : null}
                        Yes, delete
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 h-7 text-xs"
                        onClick={() => setShowDeleteConfirm(false)}
                        disabled={deleteConversationMutation.isPending}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5 shrink-0" />
                    Delete conversation
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted-foreground px-4 text-center">
              <MessageSquare className="h-8 w-8 opacity-15" />
              <p className="text-xs">Select a conversation to see details</p>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
