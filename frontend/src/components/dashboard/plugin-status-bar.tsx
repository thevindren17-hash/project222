'use client'

import { useQuery } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, XCircle, ArrowRight } from 'lucide-react'
import Link from 'next/link'

const PLUGINS = [
  { name: 'WhatsApp', key: 'whatsapp', href: '/settings/plugins/whatsapp' },
  { name: 'Calendar', key: 'calendar', href: '/settings/plugins/calendar' },
  { name: 'Agent',    key: 'agent',    href: '/settings/plugins/agent' },
] as const

export default function PluginStatusBar() {
  const { data: status } = useQuery({
    queryKey: ['plugin-status'],
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) return null
      const { data: settings } = await supabase
        .from('tenant_settings')
        .select('system_prompt,google_calendar_id,provider_credentials')
        .eq('tenant_id', tenant.id)
        .single()
      return {
        whatsapp: !!tenant.wa_phone_number_id,
        calendar: !!settings?.google_calendar_id,
        agent:    !!settings?.system_prompt,
      }
    },
  })

  const plugins = PLUGINS.map((p) => ({
    ...p,
    connected: status ? !!status[p.key as keyof typeof status] : undefined,
  }))

  const firstDisconnected = plugins.find((p) => p.connected === false)
  if (!firstDisconnected) return null

  const disconnectedCount = plugins.filter((p) => p.connected === false).length

  return (
    <Card className="border-amber-500/40 bg-amber-500/5">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-semibold text-sm">
              {disconnectedCount} integration{disconnectedCount !== 1 ? 's' : ''} not connected
            </p>
            <div className="flex gap-2 mt-2 flex-wrap">
              {plugins.map((plugin) => (
                <Link key={plugin.name} href={plugin.href}>
                  <Badge
                    variant={plugin.connected ? 'default' : 'secondary'}
                    className="gap-1 cursor-pointer hover:opacity-80 transition-opacity"
                  >
                    {plugin.connected
                      ? <CheckCircle2 className="h-3 w-3" />
                      : <XCircle className="h-3 w-3" />}
                    {plugin.name}
                  </Badge>
                </Link>
              ))}
            </div>
          </div>
          <Link href={firstDisconnected.href}>
            <Button variant="outline" size="sm" className="shrink-0">
              Set up <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
