'use client'

import { useEffect, useState, Suspense } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { initiateGoogleOAuth, disconnectGoogle } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { CheckCircle2, XCircle, Calendar, Sheet, Loader2, ExternalLink, Key, Copy, RefreshCw } from 'lucide-react'
import { format } from 'date-fns'

const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL || '').trim()
const REDIRECT_URI = BACKEND_URL ? `${BACKEND_URL.replace(/\/$/, '')}/api/integrations/google/callback` : ''

function OAuthResultHandler() {
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()

  useEffect(() => {
    const success = searchParams.get('success')
    const error = searchParams.get('error')
    if (success === 'true') {
      toast.success('Google connected — Calendar sync and a new Sheets spreadsheet are ready')
      queryClient.invalidateQueries({ queryKey: ['tenant-settings', 'google'] })
      window.history.replaceState({}, '', window.location.pathname)
    } else if (error) {
      const messages: Record<string, string> = {
        access_denied: 'Access was denied. Please try again and allow access.',
        storage_failed: 'Connected but failed to save. Please try again.',
        missing_params: 'Something went wrong. Please try again.',
        google_client_not_configured: 'Save your Google Client ID and Secret below first, then connect.',
      }
      toast.error(messages[error] || `Connection failed: ${decodeURIComponent(error)}`)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [searchParams, queryClient])

  return null
}

export default function GoogleIntegrationPage() {
  const queryClient = useQueryClient()

  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })

  const { data: settings, isLoading } = useQuery({
    queryKey: ['tenant-settings', 'google'],
    queryFn: async () => {
      if (!tenant) return null
      const { data } = await supabase
        .from('tenant_settings')
        .select('google_access_token, google_refresh_token, google_calendar_id, google_sheets_id, google_sheets_tab, updated_at')
        .eq('tenant_id', tenant.id)
        .maybeSingle()
      return data
    },
    enabled: !!tenant,
  })

  const { data: credExistence } = useQuery({
    queryKey: ['agent-cred-existence'],
    queryFn: async () => {
      const res = await fetch('/api/credentials?type=agent')
      return res.ok ? (await res.json() as Record<string, boolean>) : {}
    },
    enabled: !!tenant,
    staleTime: 30_000,
  })

  const hasOwnClient = !!credExistence?.google
  const isConnected = !!(settings?.google_access_token || settings?.google_refresh_token)
  const spreadsheetUrl = settings?.google_sheets_id
    ? `https://docs.google.com/spreadsheets/d/${settings.google_sheets_id}/edit`
    : null

  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')

  const saveClientMutation = useMutation({
    mutationFn: async () => {
      if (!clientId.trim() || !clientSecret.trim()) throw new Error('Enter both Client ID and Client Secret')
      const res = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'google',
          type: 'agent',
          fields: { client_id: clientId.trim(), client_secret: clientSecret.trim() },
        }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to save')
    },
    onSuccess: () => {
      toast.success('Google Client ID saved')
      setClientId(''); setClientSecret('')
      queryClient.invalidateQueries({ queryKey: ['agent-cred-existence'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      await disconnectGoogle(tenant.id)
    },
    onSuccess: () => {
      toast.success('Google disconnected')
      queryClient.invalidateQueries({ queryKey: ['tenant-settings', 'google'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const [sheetLink, setSheetLink] = useState('')

  const selectSheetMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      if (!sheetLink.trim()) throw new Error('Paste a Google Sheets link first')
      const res = await fetch('/api/integrations/google/select-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenant.id, sheet_link: sheetLink.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not use that spreadsheet')
      return data as { title: string; tab_name: string }
    },
    onSuccess: (data) => {
      toast.success(`Now using the "${data.tab_name}" tab in "${data.title}"`)
      setSheetLink('')
      queryClient.invalidateQueries({ queryKey: ['tenant-settings', 'google'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  function copyRedirectUri() {
    navigator.clipboard.writeText(REDIRECT_URI)
    toast.success('Copied')
  }

  return (
    <div className="max-w-4xl space-y-6">
      <Suspense fallback={null}>
        <OAuthResultHandler />
      </Suspense>

      <div>
        <h1 className="text-3xl font-bold">Google Integration</h1>
        <p className="text-muted-foreground">
          One connection powers Calendar sync and automatic Google Sheets patient logging — connect once
        </p>
      </div>

      {/* Step 1: bring your own OAuth client */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Key className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Your Google OAuth Client</CardTitle>
              <CardDescription>
                Uses your own Google Cloud project — not a shared app — so your connection is fully under
                your control.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-md border bg-muted/40 p-3">
            <div>
              <p className="text-sm font-medium">Client ID / Secret</p>
              <p className="text-xs text-muted-foreground">
                {hasOwnClient ? 'Saved — you can update it below if needed' : 'Not set yet'}
              </p>
            </div>
            <Badge variant={hasOwnClient ? 'default' : 'secondary'} className="gap-1">
              {hasOwnClient
                ? <><CheckCircle2 className="h-4 w-4" />Saved</>
                : <><XCircle className="h-4 w-4" />Missing</>}
            </Badge>
          </div>

          <div className="rounded-md border bg-muted/40 p-3 space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              In your Google Cloud OAuth Client, set this as an Authorized redirect URI:
            </p>
            <div className="flex items-center gap-2">
              <code className="text-xs bg-background border rounded px-2 py-1 flex-1 overflow-x-auto whitespace-nowrap">
                {REDIRECT_URI || 'Backend URL not configured'}
              </code>
              {REDIRECT_URI && (
                <Button variant="outline" size="sm" onClick={copyRedirectUri}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Client ID</Label>
              <Input
                placeholder="xxxxxxxx.apps.googleusercontent.com"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Client Secret</Label>
              <Input
                type="password"
                placeholder={hasOwnClient ? '••••••••••••' : 'GOCSPX-...'}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                className="font-mono text-sm"
              />
            </div>
          </div>
          <Button size="sm" onClick={() => saveClientMutation.mutate()} disabled={saveClientMutation.isPending}>
            {saveClientMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Client ID
          </Button>
        </CardContent>
      </Card>

      {/* Step 2: connect */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Connection Status</CardTitle>
              <CardDescription>
                {isLoading ? 'Checking...' : isConnected ? 'Google is connected' : 'Not connected'}
              </CardDescription>
            </div>
            <Badge variant={isConnected ? 'default' : 'secondary'} className="gap-1">
              {isConnected
                ? <><CheckCircle2 className="h-4 w-4" />Connected</>
                : <><XCircle className="h-4 w-4" />Disconnected</>}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isConnected && settings ? (
            <>
              <p className="text-sm">
                <span className="font-medium">Last updated:</span>{' '}
                {settings.updated_at ? format(new Date(settings.updated_at), 'MMM dd, yyyy HH:mm') : 'Unknown'}
              </p>
              <div className="flex flex-wrap gap-2">
                <span className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                  <Calendar className="mr-2 h-4 w-4" />Calendar syncing
                </span>
                {spreadsheetUrl && (
                  <a
                    href={spreadsheetUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    <Sheet className="mr-2 h-4 w-4" />
                    Open your spreadsheet
                    <ExternalLink className="ml-2 h-3.5 w-3.5" />
                  </a>
                )}
              </div>
              <Separator />
              <Button
                variant="destructive"
                size="sm"
                onClick={() => disconnectMutation.mutate()}
                disabled={disconnectMutation.isPending}
              >
                {disconnectMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Disconnect Google
              </Button>
            </>
          ) : (
            <Button
              size="lg"
              className="w-full"
              onClick={() => tenant && initiateGoogleOAuth(tenant.id)}
              disabled={!tenant || !hasOwnClient}
            >
              Connect Google
            </Button>
          )}
          {!hasOwnClient && !isConnected && (
            <p className="text-xs text-muted-foreground text-center">Save your Client ID and Secret above first.</p>
          )}
        </CardContent>
      </Card>

      {/* Step 3: choose which spreadsheet */}
      {isConnected && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Sheet className="h-5 w-5 text-primary" />
              <div>
                <CardTitle>Spreadsheet</CardTitle>
                <CardDescription>
                  By default we created a new spreadsheet for you. To use your own instead — even one you
                  already use for something else, like inventory — paste its link below. No fixed layout:
                  we match your existing column headers by name (however you've named them), so your own
                  structure is never changed. Just make sure the tab you want already has a header row
                  (Name, Phone, Service, etc. — whatever you use). To target one specific tab in a
                  multi-tab file, copy the link while that tab is open (it includes #gid=...); otherwise
                  the first tab is used.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {spreadsheetUrl && (
              <p className="text-xs text-muted-foreground">
                Currently using{settings?.google_sheets_tab ? ` the "${settings.google_sheets_tab}" tab in` : ''}:{' '}
                <a href={spreadsheetUrl} target="_blank" rel="noopener noreferrer" className="underline">
                  {spreadsheetUrl}
                </a>
              </p>
            )}
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                placeholder="https://docs.google.com/spreadsheets/d/..."
                value={sheetLink}
                onChange={(e) => setSheetLink(e.target.value)}
                className="font-mono text-sm flex-1"
              />
              <Button
                size="sm"
                onClick={() => selectSheetMutation.mutate()}
                disabled={selectSheetMutation.isPending}
                className="shrink-0"
              >
                {selectSheetMutation.isPending
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : <RefreshCw className="mr-2 h-4 w-4" />}
                Use this Sheet
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* How it works */}
      <Card>
        <CardHeader>
          <CardTitle>How It Works</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {[
            ['Create your own Google Cloud OAuth Client', 'In your Google Cloud project, create an OAuth Client ID (Web application) and add the redirect URI shown above.'],
            ['Save the Client ID and Secret here', 'Paste them into the fields above — this connects through your own app, not a shared one.'],
            ['Connect once', 'One click authorizes both Calendar and Sheets together — no separate steps.'],
            ['Everything just works', 'Bookings sync to your Google Calendar automatically, and every new lead, booking, reschedule, and cancellation is mirrored as a row in Sheets — either the one we create for you, or your own if you point us at it below.'],
          ].map(([title, desc], i) => (
            <div key={i} className="flex gap-3">
              <div className="h-6 w-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold shrink-0">
                {i + 1}
              </div>
              <div>
                <p className="font-medium">{title}</p>
                <p className="text-sm text-muted-foreground">{desc}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
