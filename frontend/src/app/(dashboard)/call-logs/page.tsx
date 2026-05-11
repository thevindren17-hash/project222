'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { format } from 'date-fns'
import type { CallLog } from '@/lib/types'

function durationStr(s: number) {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}m ${sec}s`
}

export default function CallLogsPage() {
  const [selected, setSelected] = useState<CallLog | null>(null)

  const { data: calls } = useQuery({
    queryKey: ['call-logs'],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) return []
      const { data } = await supabase
        .from('call_logs')
        .select('*, contact:contacts(name,phone)')
        .eq('tenant_id', tenant.id)
        .order('started_at', { ascending: false })
        .limit(100)
      return (data || []) as CallLog[]
    },
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Call Logs</h1>
        <p className="text-muted-foreground">{calls?.length || 0} recent calls</p>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Caller</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Language</TableHead>
                <TableHead>Turns</TableHead>
                <TableHead>Escalated</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {calls?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">No call logs yet</TableCell>
                </TableRow>
              )}
              {calls?.map((c: any) => (
                <TableRow key={c.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setSelected(c)}>
                  <TableCell>
                    <p className="font-medium">{c.contact?.name || c.caller_number}</p>
                    <p className="text-xs text-muted-foreground">{c.caller_number}</p>
                  </TableCell>
                  <TableCell>{durationStr(c.duration_seconds || 0)}</TableCell>
                  <TableCell className="uppercase">{c.language_detected}</TableCell>
                  <TableCell>{c.turn_count}</TableCell>
                  <TableCell>
                    <Badge variant={c.auto_escalated ? 'destructive' : 'secondary'}>
                      {c.auto_escalated ? 'Yes' : 'No'}
                    </Badge>
                  </TableCell>
                  <TableCell>{format(new Date(c.started_at), 'MMM d, h:mm a')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!selected} onOpenChange={() => setSelected(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Call Detail</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div><p className="text-muted-foreground">Caller</p><p className="font-medium">{(selected as any).contact?.name || selected.caller_number}</p></div>
                <div><p className="text-muted-foreground">Duration</p><p className="font-medium">{durationStr(selected.duration_seconds)}</p></div>
                <div><p className="text-muted-foreground">Language</p><p className="font-medium uppercase">{selected.language_detected}</p></div>
                <div><p className="text-muted-foreground">Turns</p><p className="font-medium">{selected.turn_count}</p></div>
                <div><p className="text-muted-foreground">STT</p><p className="font-medium">{selected.stt_provider}</p></div>
                <div><p className="text-muted-foreground">LLM</p><p className="font-medium">{selected.llm_provider}</p></div>
                <div><p className="text-muted-foreground">TTS</p><p className="font-medium">{selected.tts_provider}</p></div>
                <div><p className="text-muted-foreground">Escalated</p><Badge variant={selected.auto_escalated ? 'destructive' : 'secondary'}>{selected.auto_escalated ? 'Yes' : 'No'}</Badge></div>
              </div>
              {selected.escalation_reason && (
                <div><p className="text-muted-foreground">Escalation Reason</p><p>{selected.escalation_reason}</p></div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
