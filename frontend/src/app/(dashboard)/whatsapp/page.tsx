'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { Send, Bot, User } from 'lucide-react'
import type { WhatsAppThread, WhatsAppMessage } from '@/lib/types'

export default function WhatsAppPage() {
  const [selected, setSelected] = useState<WhatsAppThread | null>(null)
  const [reply, setReply] = useState('')
  const queryClient = useQueryClient()

  const { data: threads } = useQuery({
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
  })

  const { data: messages } = useQuery({
    queryKey: ['wa-messages', selected?.id],
    queryFn: async () => {
      if (!selected) return []
      const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('thread_id', selected.id)
        .order('created_at', { ascending: true })
      return (data || []) as WhatsAppMessage[]
    },
    enabled: !!selected,
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
  })

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!selected || !reply.trim()) return
      const tenant = await getCurrentTenant()
      if (!tenant) throw new Error('No tenant')
      const { error } = await supabase.from('messages').insert({
        thread_id: selected.id,
        tenant_id: tenant.id,
        direction: 'outbound',
        body: reply.trim(),
      })
      if (error) throw error
      setReply('')
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['wa-messages', selected?.id] }),
    onError: (e: Error) => toast.error(e.message),
  })

  const statusBadge = (status: string) => ({
    ai: <Badge variant="default" className="gap-1"><Bot className="h-3 w-3" />AI</Badge>,
    human_takeover: <Badge variant="secondary" className="gap-1"><User className="h-3 w-3" />Staff</Badge>,
    resolved: <Badge variant="outline">Resolved</Badge>,
  }[status] || <Badge variant="secondary">{status}</Badge>)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">WhatsApp</h1>
        <p className="text-muted-foreground">{threads?.length || 0} conversations</p>
      </div>

      <div className="grid grid-cols-3 gap-6 h-[calc(100vh-220px)]">
        {/* Thread list */}
        <Card className="overflow-hidden flex flex-col">
          <CardHeader className="pb-3"><CardTitle className="text-base">Conversations</CardTitle></CardHeader>
          <CardContent className="p-0 flex-1 overflow-y-auto">
            {threads?.map((t: any) => (
              <div key={t.id}
                className={`p-4 border-b cursor-pointer hover:bg-muted/50 transition-colors ${selected?.id === t.id ? 'bg-primary/5 border-l-2 border-l-primary' : ''}`}
                onClick={() => setSelected(t)}
              >
                <div className="flex items-center justify-between mb-1">
                  <p className="font-medium text-sm">{t.contact?.name || t.contact?.phone || 'Unknown'}</p>
                  {statusBadge(t.status)}
                </div>
                <p className="text-xs text-muted-foreground">{format(new Date(t.last_message_at), 'MMM d, h:mm a')}</p>
              </div>
            ))}
            {threads?.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">No conversations yet</p>
            )}
          </CardContent>
        </Card>

        {/* Conversation view */}
        <Card className="col-span-2 flex flex-col overflow-hidden">
          {selected ? (
            <>
              <CardHeader className="pb-3 border-b">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">{(selected as any).contact?.name || (selected as any).contact?.phone}</CardTitle>
                    <p className="text-xs text-muted-foreground">{(selected as any).contact?.phone}</p>
                  </div>
                  <div className="flex gap-2">
                    {selected.status === 'ai' ? (
                      <Button size="sm" variant="outline" onClick={() => takeoverMutation.mutate(selected.id)}>
                        Take Over
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => handbackMutation.mutate(selected.id)}>
                        Hand Back to AI
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages?.map((m: any) => (
                  <div key={m.id} className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-xs rounded-lg px-3 py-2 text-sm ${m.direction === 'outbound' ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                      <p>{m.body}</p>
                      <p className={`text-xs mt-1 ${m.direction === 'outbound' ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                        {format(new Date(m.created_at), 'h:mm a')}
                      </p>
                    </div>
                  </div>
                ))}
              </CardContent>
              {selected.status === 'human_takeover' && (
                <div className="p-4 border-t flex gap-2">
                  <Input placeholder="Type a message..." value={reply} onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && sendMutation.mutate()} />
                  <Button size="icon" onClick={() => sendMutation.mutate()} disabled={!reply.trim()}>
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </>
          ) : (
            <CardContent className="flex-1 flex items-center justify-center text-muted-foreground">
              Select a conversation to view messages
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  )
}
