'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Phone } from 'lucide-react'
import { supabase, getCurrentTenant } from '@/lib/supabase'

export default function LiveIndicator() {
  const [activeCalls, setActiveCalls] = useState(0)

  useEffect(() => {
    let cleanup: (() => void) | undefined

    async function subscribe() {
      const tenant = await getCurrentTenant()
      if (!tenant) return

      const channel = supabase
        .channel('active_calls')
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'call_logs',
          filter: `tenant_id=eq.${tenant.id}`,
        }, (payload) => {
          if (payload.eventType === 'INSERT') setActiveCalls((p) => p + 1)
          if (payload.eventType === 'DELETE') setActiveCalls((p) => Math.max(0, p - 1))
        })
        .subscribe()

      cleanup = () => { supabase.removeChannel(channel) }
    }

    subscribe()
    return () => cleanup?.()
  }, [])

  if (activeCalls === 0) return null

  return (
    <Card className="border-[--color-success] bg-[--color-success]/10">
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Phone className="h-6 w-6 text-[--color-success]" />
            <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-[--color-success] animate-pulse" />
          </div>
          <div>
            <p className="font-semibold text-[--color-success]">
              {activeCalls} Active Call{activeCalls !== 1 ? 's' : ''}
            </p>
            <p className="text-sm opacity-80">AI is handling incoming calls right now</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
