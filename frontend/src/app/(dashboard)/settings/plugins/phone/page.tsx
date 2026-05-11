'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { CheckCircle2, XCircle, Copy, Loader2 } from 'lucide-react'

export default function PhonePluginPage() {
  const queryClient = useQueryClient()
  const [sipUri, setSipUri] = useState('')
  const [escalationNumber, setEscalationNumber] = useState('')

  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })
  const isConnected = !!tenant?.sip_uri

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      const { error } = await supabase.from('tenants').update({
        sip_uri: sipUri,
        escalation_number: escalationNumber || null,
      }).eq('id', tenant.id)
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Phone settings saved')
      queryClient.invalidateQueries({ queryKey: ['tenant'] })
      queryClient.invalidateQueries({ queryKey: ['plugin-status'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  function copy(text: string) {
    navigator.clipboard.writeText(text)
    toast.success('Copied!')
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Phone / SIP Plugin</h1>
        <p className="text-muted-foreground">Connect a phone number for AI voice calls via LiveKit SIP</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Connection Status</CardTitle>
              <CardDescription>{isConnected ? `SIP URI: ${tenant?.sip_uri}` : 'No phone number configured'}</CardDescription>
            </div>
            <Badge variant={isConnected ? 'default' : 'secondary'} className="gap-1">
              {isConnected ? <><CheckCircle2 className="h-4 w-4" />Connected</> : <><XCircle className="h-4 w-4" />Not set</>}
            </Badge>
          </div>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>LiveKit SIP Configuration</CardTitle>
          <CardDescription>The AI agent listens for calls routed to your SIP URI</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="bg-muted/50 rounded-md p-4 text-sm space-y-2">
            <p className="font-medium">How it works:</p>
            <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
              <li>Purchase a phone number from your VoIP provider (Twilio, Vonage, etc.)</li>
              <li>Configure your VoIP provider to forward calls to your LiveKit SIP trunk</li>
              <li>Enter the SIP URI below so the AI agent can identify your clinic</li>
            </ol>
          </div>

          <Separator />

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>SIP URI / Phone Number</Label>
              <Input
                placeholder="+60123456789 or sip:clinic@example.com"
                value={sipUri || (isConnected ? tenant?.sip_uri || '' : '')}
                onChange={(e) => setSipUri(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">This is the number callers will dial</p>
            </div>
            <div className="space-y-2">
              <Label>Escalation Number</Label>
              <Input
                placeholder="+60123456789"
                value={escalationNumber || (tenant?.escalation_number || '')}
                onChange={(e) => setEscalationNumber(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Calls transferred to a human will go here</p>
            </div>
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || (!sipUri && !isConnected)}>
              {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>LiveKit Agent Worker URL</Label>
            <div className="flex gap-2">
              <Input value={`${process.env.NEXT_PUBLIC_BACKEND_URL || 'https://your-backend.railway.app'}` } readOnly className="font-mono text-xs" />
              <Button variant="outline" size="icon" onClick={() => copy(process.env.NEXT_PUBLIC_BACKEND_URL || '')}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Configure your LiveKit project to use this backend URL</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
