'use client'

import { useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { toast } from 'sonner'
import type { Escalation } from '@/lib/types'

// Synthesized two-tone alert -- no audio file to ship or fetch, and it's
// audible the first time a tab is open (no network round-trip to wait on).
// Wrapped in try/catch: browsers block audio until the user has interacted
// with the page at least once, which would otherwise throw on a fresh load.
function playAlertTone() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    const now = ctx.currentTime
    ;[880, 660].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const start = now + i * 0.18
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(0.35, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.18)
    })
    setTimeout(() => ctx.close(), 500)
  } catch {
    // Sound is a bonus on top of the toast + badge, not load-bearing.
  }
}

export function useEscalations() {
  const queryClient = useQueryClient()
  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })

  const { data: escalations = [] } = useQuery({
    queryKey: ['escalations', tenant?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('escalations')
        .select('*')
        .eq('tenant_id', tenant!.id)
        .eq('resolved', false)
        .order('created_at', { ascending: false })
        .limit(20)
      if (error) throw error
      return data as Escalation[]
    },
    enabled: !!tenant?.id,
    refetchInterval: 60_000,
  })

  // 'INSERT' only fires for rows created while this subscription is live,
  // so it never re-alerts for escalations that already existed on load.
  useEffect(() => {
    if (!tenant?.id) return
    const channel = supabase
      .channel(`escalations-${tenant.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'escalations',
        filter: `tenant_id=eq.${tenant.id}`,
      }, (payload) => {
        const row = payload.new as Escalation
        queryClient.invalidateQueries({ queryKey: ['escalations', tenant.id] })
        playAlertTone()
        toast.warning(`Needs a human: ${row.reason}`, {
          description: row.context || undefined,
          duration: 10000,
        })
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [tenant?.id, queryClient])

  const resolveMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('escalations').update({ resolved: true }).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['escalations', tenant?.id] }),
  })

  return { escalations, resolve: resolveMutation.mutate }
}
