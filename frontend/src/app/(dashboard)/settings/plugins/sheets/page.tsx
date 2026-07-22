'use client'

import { useEffect, Suspense } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'next/navigation'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { initiateGoogleSheetsOAuth, disconnectGoogleSheets } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button, buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { CheckCircle2, XCircle, Sheet, Loader2, ExternalLink } from 'lucide-react'
import { format } from 'date-fns'

function OAuthResultHandler() {
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()

  useEffect(() => {
    const success = searchParams.get('success')
    const error = searchParams.get('error')
    if (success === 'true') {
      toast.success('Google Sheets connected — a new spreadsheet has been created for you')
      queryClient.invalidateQueries({ queryKey: ['tenant-settings', 'sheets'] })
      window.history.replaceState({}, '', window.location.pathname)
    } else if (error) {
      const messages: Record<string, string> = {
        access_denied: 'Access was denied. Please try again and allow Sheets access.',
        storage_failed: 'Connected but failed to save. Please try again.',
        missing_params: 'Something went wrong. Please try again.',
      }
      toast.error(messages[error] || `Connection failed: ${decodeURIComponent(error)}`)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [searchParams, queryClient])

  return null
}

export default function SheetsPluginPage() {
  const queryClient = useQueryClient()

  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })

  const { data: settings, isLoading } = useQuery({
    queryKey: ['tenant-settings', 'sheets'],
    queryFn: async () => {
      if (!tenant) return null
      const { data } = await supabase
        .from('tenant_settings')
        .select('google_sheets_token, google_sheets_refresh, google_sheets_id, updated_at')
        .eq('tenant_id', tenant.id)
        .maybeSingle()
      return data
    },
    enabled: !!tenant,
  })

  const isConnected = !!(settings?.google_sheets_token || settings?.google_sheets_refresh)
  const spreadsheetUrl = settings?.google_sheets_id
    ? `https://docs.google.com/spreadsheets/d/${settings.google_sheets_id}/edit`
    : null

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      await disconnectGoogleSheets(tenant.id)
    },
    onSuccess: () => {
      toast.success('Google Sheets disconnected')
      queryClient.invalidateQueries({ queryKey: ['tenant-settings', 'sheets'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <div className="max-w-4xl space-y-6">
      <Suspense fallback={null}>
        <OAuthResultHandler />
      </Suspense>

      <div>
        <h1 className="text-3xl font-bold">Google Sheets Plugin</h1>
        <p className="text-muted-foreground">
          Automatically mirror every patient your AI receptionist collects into your own spreadsheet
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Connection Status</CardTitle>
              <CardDescription>
                {isLoading ? 'Checking...' : isConnected ? 'Your Google Sheet is connected' : 'Not connected'}
              </CardDescription>
            </div>
            <Badge variant={isConnected ? 'default' : 'secondary'} className="gap-1">
              {isConnected
                ? <><CheckCircle2 className="h-4 w-4" />Connected</>
                : <><XCircle className="h-4 w-4" />Disconnected</>}
            </Badge>
          </div>
        </CardHeader>
        {isConnected && settings && (
          <CardContent className="space-y-4">
            <p className="text-sm">
              <span className="font-medium">Last updated:</span>{' '}
              {settings.updated_at ? format(new Date(settings.updated_at), 'MMM dd, yyyy HH:mm') : 'Unknown'}
            </p>
            {spreadsheetUrl && (
              <a
                href={spreadsheetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Open your spreadsheet
              </a>
            )}
            <Separator />
            <Button
              variant="destructive"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
            >
              {disconnectMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Disconnect Sheets
            </Button>
          </CardContent>
        )}
      </Card>

      {!isConnected && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sheet className="h-5 w-5 text-primary" />How It Works
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {[
                ['Connect Your Google Account', 'Click below to sign in with Google and grant Sheets access'],
                ['A New Spreadsheet Is Created For You', 'We automatically create a spreadsheet titled with your clinic name — no setup needed'],
                ['Every Patient Event Logged Automatically', 'New leads, bookings, reschedules, and cancellations are added as rows — this never replaces your real data in the dashboard, it\'s a one-way convenience copy'],
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

          <Card>
            <CardContent className="pt-6">
              <Button
                size="lg"
                className="w-full"
                onClick={() => tenant && initiateGoogleSheetsOAuth(tenant.id)}
                disabled={!tenant}
              >
                <Sheet className="mr-2 h-5 w-5" />
                Connect Google Sheets
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
