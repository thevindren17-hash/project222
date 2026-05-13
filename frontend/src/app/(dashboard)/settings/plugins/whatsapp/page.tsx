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
import { CheckCircle2, XCircle, Copy, ExternalLink, Loader2, RefreshCw, AlertCircle } from 'lucide-react'

export default function WhatsAppPluginPage() {
  const queryClient = useQueryClient()
  const [phoneNumberId, setPhoneNumberId] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [businessAccountId, setBusinessAccountId] = useState('')
  const [accessToken, setAccessToken] = useState('')

  const { data: tenant, isLoading, error, refetch } = useQuery({
    queryKey: ['tenant'],
    queryFn: getCurrentTenant,
    retry: 2,
    staleTime: 0,
  })

  const isConnected = !!tenant?.wa_phone_number_id

  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || ''
  const webhookUrl = tenant ? `${backendUrl}/webhook/whatsapp/${tenant.id}` : ''
  const verifyToken = tenant
    ? (tenant.wa_verify_token || `wa_${tenant.id.replace(/-/g, '').slice(0, 16)}`)
    : ''

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      const derivedToken = `wa_${tenant.id.replace(/-/g, '').slice(0, 16)}`
      const { error } = await supabase.from('tenants').update({
        wa_phone_number: phoneNumber || null,
        wa_phone_number_id: phoneNumberId,
        wa_business_account_id: businessAccountId,
        wa_access_token: accessToken,
        wa_verify_token: derivedToken,
      }).eq('id', tenant.id)
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('WhatsApp connected')
      queryClient.invalidateQueries({ queryKey: ['tenant'] })
      queryClient.invalidateQueries({ queryKey: ['plugin-status'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      const { error } = await supabase.from('tenants').update({
        wa_phone_number: null,
        wa_phone_number_id: null,
        wa_business_account_id: null,
        wa_access_token: null,
      }).eq('id', tenant.id)
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('WhatsApp disconnected')
      queryClient.invalidateQueries({ queryKey: ['tenant'] })
      queryClient.invalidateQueries({ queryKey: ['plugin-status'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  function copy(text: string) {
    navigator.clipboard.writeText(text)
    toast.success('Copied!')
  }

  // ── Loading state ──────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="max-w-4xl space-y-6">
        <div>
          <h1 className="text-3xl font-bold">WhatsApp Plugin</h1>
          <p className="text-muted-foreground">Connect your WhatsApp Business account</p>
        </div>
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mr-2" />
            <span className="text-muted-foreground">Loading your account...</span>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Error / no tenant state ────────────────────────────────────────────────
  if (error || !tenant) {
    return (
      <div className="max-w-4xl space-y-6">
        <div>
          <h1 className="text-3xl font-bold">WhatsApp Plugin</h1>
          <p className="text-muted-foreground">Connect your WhatsApp Business account</p>
        </div>
        <Card className="border-destructive/50">
          <CardContent className="flex flex-col items-center justify-center py-12 gap-4">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <div className="text-center">
              <p className="font-medium">Could not load your clinic account</p>
              <p className="text-sm text-muted-foreground mt-1">
                {error ? `Error: ${(error as Error).message}` : 'No clinic account found for your login.'}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Make sure you are logged in with the correct account.
              </p>
            </div>
            <Button variant="outline" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Main page ──────────────────────────────────────────────────────────────
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">WhatsApp Plugin</h1>
        <p className="text-muted-foreground">Connect your WhatsApp Business account</p>
      </div>

      {/* Status card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Connection Status</CardTitle>
              <CardDescription>{isConnected ? 'Your WhatsApp is connected' : 'Not connected yet'}</CardDescription>
            </div>
            <Badge variant={isConnected ? 'default' : 'secondary'} className="gap-1">
              {isConnected
                ? <><CheckCircle2 className="h-4 w-4" />Connected</>
                : <><XCircle className="h-4 w-4" />Disconnected</>}
            </Badge>
          </div>
        </CardHeader>
        {isConnected && (
          <CardContent className="space-y-2">
            {tenant.wa_phone_number && (
              <p className="text-sm"><span className="font-medium">Phone Number:</span> {tenant.wa_phone_number}</p>
            )}
            <p className="text-sm"><span className="font-medium">Phone Number ID:</span> {tenant.wa_phone_number_id}</p>
            <p className="text-sm"><span className="font-medium">Business Account ID:</span> {tenant.wa_business_account_id || '—'}</p>
            <Button variant="destructive" size="sm" className="mt-4"
              onClick={() => disconnectMutation.mutate()} disabled={disconnectMutation.isPending}>
              {disconnectMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Disconnect
            </Button>
          </CardContent>
        )}
      </Card>

      {!isConnected && (
        <Card>
          <CardHeader>
            <CardTitle>Connect WhatsApp Business</CardTitle>
            <CardDescription>Follow the steps below</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">

            {/* Step 1 */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="h-6 w-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">1</div>
                <h3 className="font-semibold">Get credentials from Meta</h3>
              </div>
              <p className="text-sm text-muted-foreground ml-8">
                Go to{' '}
                <a href="https://developers.facebook.com" target="_blank" rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1">
                  developers.facebook.com <ExternalLink className="h-3 w-3" />
                </a>{' '}→ your App → WhatsApp → API Setup
              </p>
            </div>

            <Separator />

            {/* Step 2 — Webhook (shown first so user can verify before saving creds) */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="h-6 w-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">2</div>
                <h3 className="font-semibold">Configure webhook in Meta</h3>
              </div>
              <div className="space-y-4 ml-8">
                <p className="text-sm text-muted-foreground">In Meta Developer Portal → your App → WhatsApp → Configuration → Webhooks</p>
                <div className="space-y-2">
                  <Label>Callback URL</Label>
                  <div className="flex gap-2">
                    <Input value={webhookUrl} readOnly className="font-mono text-xs bg-muted" />
                    <Button variant="outline" size="icon" onClick={() => copy(webhookUrl)}><Copy className="h-4 w-4" /></Button>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Verify Token</Label>
                  <div className="flex gap-2">
                    <Input value={verifyToken} readOnly className="font-mono text-xs bg-muted" />
                    <Button variant="outline" size="icon" onClick={() => copy(verifyToken)}><Copy className="h-4 w-4" /></Button>
                  </div>
                  <p className="text-xs text-muted-foreground">After verifying, subscribe to the <span className="font-medium">messages</span> webhook field.</p>
                </div>
              </div>
            </div>

            <Separator />

            {/* Step 3 — Credentials */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="h-6 w-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold">3</div>
                <h3 className="font-semibold">Paste your credentials</h3>
              </div>
              <div className="space-y-4 ml-8">
                <div className="space-y-2">
                  <Label>WhatsApp Phone Number</Label>
                  <Input autoComplete="off" placeholder="+60123456789" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} />
                  <p className="text-xs text-muted-foreground">The actual phone number shown to users (e.g. +60123456789)</p>
                </div>
                <div className="space-y-2">
                  <Label>Phone Number ID</Label>
                  <Input
                    autoComplete="off"
                    placeholder="123456789012345"
                    value={phoneNumberId}
                    onChange={(e) => {
                      // Strip URLs — extract the first long numeric sequence
                      const raw = e.target.value.trim()
                      const match = raw.match(/\d{10,}/)
                      setPhoneNumberId(match ? match[0] : raw)
                    }}
                  />
                  <p className="text-xs text-muted-foreground">Found in Meta → WhatsApp → API Setup → Phone Number ID (numbers only, e.g. 1044148438779639)</p>
                </div>
                <div className="space-y-2">
                  <Label>WhatsApp Business Account ID</Label>
                  <Input autoComplete="off" placeholder="987654321098765" value={businessAccountId} onChange={(e) => setBusinessAccountId(e.target.value)} />
                  <p className="text-xs text-muted-foreground">Found in Meta → WhatsApp → API Setup → WhatsApp Business Account ID</p>
                </div>
                <div className="space-y-2">
                  <Label>Permanent Access Token</Label>
                  <Input autoComplete="new-password" type="password" placeholder="EAA..." value={accessToken} onChange={(e) => setAccessToken(e.target.value)} />
                  <p className="text-xs text-muted-foreground">Generate a permanent token from Meta System Users (not the temp token)</p>
                </div>
                <Button onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending || !phoneNumberId || !businessAccountId || !accessToken}>
                  {saveMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save & Connect
                </Button>
              </div>
            </div>

          </CardContent>
        </Card>
      )}
    </div>
  )
}
