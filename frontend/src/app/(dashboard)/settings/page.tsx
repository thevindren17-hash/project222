'use client'

import { useQuery } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, XCircle, MessageSquare, Phone, Calendar, Bot, Sparkles, Users } from 'lucide-react'
import Link from 'next/link'

const plugins = [
  { name: 'WhatsApp', description: 'Receive and reply to WhatsApp messages via AI', icon: MessageSquare, href: '/settings/plugins/whatsapp', key: 'whatsapp' },
  { name: 'Phone / SIP', description: 'Handle incoming voice calls with your AI receptionist', icon: Phone, href: '/settings/plugins/phone', key: 'phone' },
  { name: 'Google Calendar', description: 'Sync bookings to your Google Calendar automatically', icon: Calendar, href: '/settings/plugins/calendar', key: 'calendar' },
  { name: 'AI Providers', description: 'Configure LLM, speech-to-text, and text-to-speech', icon: Sparkles, href: '/settings/plugins/ai-providers', key: 'ai' },
  { name: 'Agent Config', description: 'Customize your AI receptionist personality and instructions', icon: Bot, href: '/settings/plugins/agent', key: 'agent' },
]

const otherSettings = [
  { name: 'Clinic Info & Hours', description: 'Business hours, FAQ, location, and contact details', href: '/settings/clinic-info', icon: Phone },
  { name: 'Staff Management', description: 'Manage team members and permissions', href: '/settings/staff', icon: Users },
]

export default function SettingsPage() {
  const { data: status } = useQuery({
    queryKey: ['plugin-status'],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) return {}
      const { data: settings } = await supabase
        .from('tenant_settings')
        .select('system_prompt,google_calendar_id')
        .eq('tenant_id', tenant.id)
        .single()
      return {
        whatsapp: !!tenant.wa_phone_number_id,
        phone: !!tenant.sip_uri,
        calendar: !!settings?.google_calendar_id,
        ai: true,
        agent: !!settings?.system_prompt,
      }
    },
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Manage your clinic&apos;s plugins and configuration</p>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-4">Plugins</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {plugins.map((plugin) => {
            const connected = status?.[plugin.key as keyof typeof status]
            const Icon = plugin.icon
            return (
              <Card key={plugin.key} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                        <Icon className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <CardTitle className="text-base">{plugin.name}</CardTitle>
                        <CardDescription className="text-xs mt-0.5">{plugin.description}</CardDescription>
                      </div>
                    </div>
                    <Badge variant={connected ? 'default' : 'secondary'} className="gap-1 shrink-0">
                      {connected ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                      {connected ? 'Connected' : 'Not set'}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <Link href={plugin.href}>
                    <Button variant="outline" size="sm" className="w-full">
                      {connected ? 'Manage' : 'Configure'}
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-4">Other Settings</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {otherSettings.map((s) => {
            const Icon = s.icon
            return (
              <Card key={s.href} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
                      <Icon className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <CardTitle className="text-base">{s.name}</CardTitle>
                      <CardDescription className="text-xs mt-0.5">{s.description}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <Link href={s.href}>
                    <Button variant="outline" size="sm" className="w-full">Open</Button>
                  </Link>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>
    </div>
  )
}
