'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { CheckCircle2, XCircle, Copy, Loader2, RefreshCw, AlertCircle, Bot, Zap } from 'lucide-react'

export default function WhatsAppPluginPage() {
  const queryClient = useQueryClient()
  const [phoneNumberId, setPhoneNumberId] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [businessAccountId, setBusinessAccountId] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [credError, setCredError] = useState<string | null>(null)
  const [credValid, setCredValid] = useState<{ phone: string; name: string } | null>(null)

  const { data: tenant, isLoading, error, refetch } = useQuery({
    queryKey: ['tenant'],
    queryFn: getCurrentTenant,
    retry: 2,
    staleTime: 0,
  })

  const { data: agentSettings } = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: async () => {
      if (!tenant) return null
      const { data } = await supabase.from('tenant_settings').select(
        'llm_config,agent_name,custom_instructions,provider_credentials'
      ).eq('tenant_id', tenant.id).maybeSingle()
      return data
    },
    enabled: !!tenant,
  })

  const isConnected = !!tenant?.wa_phone_number_id

  // Determine AI agent readiness
  const llmProvider = agentSettings?.llm_config?.provider || ''
  const llmModel = agentSettings?.llm_config?.model || ''
  const agentName = agentSettings?.agent_name || 'Maya'
  // Booking flow, escalation, and safety rules are always active by
  // default — this just reflects whether the clinic added optional notes.
  const hasCustomInstructions = !!agentSettings?.custom_instructions
  const hasLlmKey = !!(agentSettings?.provider_credentials?.[llmProvider]?.api_key)
  const agentReady = !!(llmProvider && hasLlmKey)

  const backendUrl = (process.env.NEXT_PUBLIC_BACKEND_URL || '').trim().replace(/\/+$/, '')
  const webhookUrl = tenant ? `${backendUrl}/webhook/whatsapp/${tenant.id}` : ''
  const verifyToken = tenant ? `wa_${tenant.id.replace(/-/g, '').slice(0, 16)}` : ''

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      setCredError(null)
      setCredValid(null)

      // Validate Phone Number ID with Meta before saving
      const valRes = await fetch('/api/whatsapp/validate-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenant.id, phone_number_id: phoneNumberId, access_token: accessToken }),
      })
      const valData = await valRes.json()
      if (!valData.valid) {
        throw new Error(valData.error || 'Invalid credentials')
      }
      setCredValid({ phone: valData.display_phone_number, name: valData.verified_name })

      const derivedToken = `wa_${tenant.id.replace(/-/g, '').slice(0, 16)}`
      const { error } = await supabase.from('tenants').update({
        wa_phone_number: phoneNumber || valData.display_phone_number || null,
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
    onError: (e: Error) => {
      setCredError(e.message)
      toast.error('Save failed — check credentials')
    },
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

      {/* AI Agent Connection status */}
      <Card className={agentReady && isConnected ? 'border-green-500/40' : ''}>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>AI Agent</CardTitle>
                <CardDescription>The AI model that will respond to your WhatsApp messages</CardDescription>
              </div>
            </div>
            <Badge variant={agentReady ? 'default' : 'secondary'} className="gap-1">
              {agentReady
                ? <><Zap className="h-3 w-3" />Active</>
                : <><AlertCircle className="h-3 w-3" />Not configured</>}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {agentReady ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 font-medium">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>
                  <span className="capitalize">{agentName}</span> is ready to handle WhatsApp messages
                  using <span className="font-semibold capitalize">{llmProvider}</span> · {llmModel}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  {hasCustomInstructions ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> : <XCircle className="h-3.5 w-3.5 text-yellow-500" />}
                  Custom notes {hasCustomInstructions ? 'added' : 'using default behavior'}
                </div>
                <div className="flex items-center gap-1.5">
                  {isConnected ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> : <XCircle className="h-3.5 w-3.5 text-yellow-500" />}
                  WhatsApp credentials {isConnected ? 'saved' : 'not saved'}
                </div>
              </div>
              {agentReady && isConnected && (
                <div className="rounded-md bg-green-500/10 border border-green-500/20 p-3 text-sm text-green-700 dark:text-green-400">
                  ✓ Your AI agent is fully connected and will automatically reply to all incoming WhatsApp messages.
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-yellow-500" />
              <span>
                No AI model configured. Go to{' '}
                <a href="/settings/plugins/agent" className="text-primary underline underline-offset-2">
                  Agent Config
                </a>{' '}
                to set up your LLM provider and API key first.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Webhook config — always visible so you can copy these at any time */}
      <Card>
        <CardHeader>
          <CardTitle>Webhook Configuration</CardTitle>
          <CardDescription>Paste these into Meta Developer Portal → your App → WhatsApp → Configuration → Webhooks</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
        </CardContent>
      </Card>

      {/* Credentials form — always visible for initial setup or re-configuration */}
      <Card>
        <CardHeader>
          <CardTitle>{isConnected ? 'Update Credentials' : 'Connect WhatsApp Business'}</CardTitle>
          <CardDescription>
            {isConnected
              ? 'Update your credentials if your token has changed or you need to re-connect'
              : 'Get these from Meta Developer Portal → your App → WhatsApp → API Setup'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>WhatsApp Phone Number</Label>
            <Input autoComplete="off" placeholder="+60123456789" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} />
            <p className="text-xs text-muted-foreground">The actual number shown to users (e.g. +60123456789)</p>
          </div>
          <div className="space-y-2">
            <Label>Phone Number ID</Label>
            <Input
              autoComplete="off"
              placeholder="123456789012345"
              value={phoneNumberId}
              onChange={(e) => {
                const raw = e.target.value.trim()
                const match = raw.match(/\d{10,}/)
                setPhoneNumberId(match ? match[0] : raw)
              }}
            />
            <p className="text-xs text-muted-foreground">Found in Meta → WhatsApp → API Setup → Phone Number ID</p>
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
            {isConnected ? 'Update & Reconnect' : 'Save & Connect'}
          </Button>

          {credError && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{credError}</span>
            </div>
          )}
          {credValid && (
            <div className="flex items-start gap-2 rounded-md bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-400">
              <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
              <span>Verified: <strong>{credValid.name}</strong> — {credValid.phone}</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
