'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { initiateGoogleCalendarOAuth } from '@/lib/api'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { toast } from 'sonner'
import { CheckCircle2, XCircle, Calendar, Loader2 } from 'lucide-react'
import { format } from 'date-fns'

export default function CalendarPluginPage() {
  const queryClient = useQueryClient()
  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })

  const { data: settings } = useQuery({
    queryKey: ['tenant-settings'],
    queryFn: async () => {
      if (!tenant) return null
      const { data } = await supabase.from('tenant_settings').select('*').eq('tenant_id', tenant.id).maybeSingle()
      return data
    },
    enabled: !!tenant,
  })

  const isConnected = !!(settings?.google_calendar_token || settings?.google_calendar_refresh)

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      if (!tenant) throw new Error('No tenant')
      const { error } = await supabase.from('tenant_settings').update({
        google_calendar_id: null,
        google_sheets_id: null,
      }).eq('tenant_id', tenant.id)
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Google Calendar disconnected')
      queryClient.invalidateQueries({ queryKey: ['tenant-settings'] })
      queryClient.invalidateQueries({ queryKey: ['plugin-status'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Google Calendar Plugin</h1>
        <p className="text-muted-foreground">Sync appointments with your Google Calendar automatically</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Connection Status</CardTitle>
              <CardDescription>{isConnected ? `Calendar ID: ${settings?.google_calendar_id}` : 'Not connected'}</CardDescription>
            </div>
            <Badge variant={isConnected ? 'default' : 'secondary'} className="gap-1">
              {isConnected ? <><CheckCircle2 className="h-4 w-4" />Connected</> : <><XCircle className="h-4 w-4" />Disconnected</>}
            </Badge>
          </div>
        </CardHeader>
        {isConnected && settings && (
          <CardContent className="space-y-4">
            <p className="text-sm">
              <span className="font-medium">Last updated:</span>{' '}
              {settings.updated_at ? format(new Date(settings.updated_at), 'MMM dd, yyyy HH:mm') : 'Unknown'}
            </p>
            <Separator />
            <Button variant="destructive" onClick={() => disconnectMutation.mutate()} disabled={disconnectMutation.isPending}>
              {disconnectMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Disconnect Calendar
            </Button>
          </CardContent>
        )}
      </Card>

      {!isConnected && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Calendar className="h-5 w-5 text-primary" />How It Works</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {[
                ['Connect Your Google Account', 'Click below to sign in with Google and grant calendar access'],
                ['Automatic Booking Sync', 'Every appointment booked by AI is automatically added to your Google Calendar'],
                ['Blocked Time Detection', 'AI checks your calendar for blocked time and won\'t double-book'],
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
              <Button size="lg" className="w-full"
                onClick={() => tenant && initiateGoogleCalendarOAuth(tenant.id)}>
                <Calendar className="mr-2 h-5 w-5" />Connect Google Calendar
              </Button>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
