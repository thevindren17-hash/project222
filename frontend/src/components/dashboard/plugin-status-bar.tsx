'use client'

import { useQuery } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CheckCircle2, XCircle, Settings } from 'lucide-react'
import Link from 'next/link'

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
        phone: !!tenant.sip_uri,
        calendar: !!settings?.google_calendar_id,
        agent: !!settings?.system_prompt,
      }
    },
  })

  const plugins = [
    { name: 'WhatsApp', connected: status?.whatsapp, href: '/settings/plugins/whatsapp' },
    { name: 'Phone', connected: status?.phone, href: '/settings/plugins/phone' },
    { name: 'Calendar', connected: status?.calendar, href: '/settings/plugins/calendar' },
    { name: 'Agent', connected: status?.agent, href: '/settings/plugins/agent' },
  ]

  const disconnectedCount = plugins.filter((p) => !p.connected).length
  if (disconnectedCount === 0) return null

  return (
    <Card className="border-[--color-warning] bg-[--color-warning]/10">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-semibold">
              {disconnectedCount} Plugin{disconnectedCount !== 1 ? 's' : ''} Not Connected
            </p>
            <div className="flex gap-2 mt-2 flex-wrap">
              {plugins.map((plugin) => (
                <Badge key={plugin.name} variant={plugin.connected ? 'default' : 'secondary'} className="gap-1">
                  {plugin.connected
                    ? <CheckCircle2 className="h-3 w-3" />
                    : <XCircle className="h-3 w-3" />}
                  {plugin.name}
                </Badge>
              ))}
            </div>
          </div>
          <Link href="/settings">
            <Button variant="outline" size="sm">
              <Settings className="h-4 w-4 mr-2" />Configure
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
