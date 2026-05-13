'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import {
  LayoutDashboard, Calendar, ClipboardList, Phone, MessageSquare,
  BarChart3, Bot, Sparkles, Users, Building2, FlaskConical,
} from 'lucide-react'

type SectionItem = {
  name: string
  href: string
  icon: React.ElementType
  statusKey?: string
}

type Section = {
  label: string | null
  items: SectionItem[]
}

const sections: Section[] = [
  {
    label: null,
    items: [
      { name: 'Overview',      href: '/overview',      icon: LayoutDashboard },
      { name: 'Calendar',      href: '/calendar',       icon: Calendar },
      { name: 'Appointments',  href: '/appointments',   icon: ClipboardList },
    ],
  },
  {
    label: 'MONITOR',
    items: [
      { name: 'WhatsApp',  href: '/whatsapp',   icon: MessageSquare },
      { name: 'Call Logs', href: '/call-logs',  icon: Phone },
      { name: 'Analytics', href: '/analytics',  icon: BarChart3 },
    ],
  },
  {
    label: 'CONFIGURE',
    items: [
      { name: 'Agent Config', href: '/settings/plugins/agent',        icon: Bot,           statusKey: 'agent' },
      { name: 'AI Providers', href: '/settings/plugins/ai-providers', icon: Sparkles,      statusKey: 'ai' },
      { name: 'Test Agent',   href: '/test-agent',                    icon: FlaskConical },
    ],
  },
  {
    label: 'CONNECT',
    items: [
      { name: 'WhatsApp',        href: '/settings/plugins/whatsapp',    icon: MessageSquare, statusKey: 'whatsapp' },
      { name: 'Phone / SIP',     href: '/settings/plugins/phone',       icon: Phone,         statusKey: 'phone' },
      { name: 'Google Calendar', href: '/settings/plugins/calendar',    icon: Calendar,      statusKey: 'calendar' },
    ],
  },
  {
    label: 'MANAGE',
    items: [
      { name: 'Clinic Info', href: '/settings/clinic-info', icon: Building2 },
      { name: 'Staff',       href: '/settings/staff',       icon: Users },
    ],
  },
]

function usePluginStatus() {
  return useQuery({
    queryKey: ['plugin-status'],
    staleTime: 60_000,
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) return {}
      const { data: settings } = await supabase
        .from('tenant_settings')
        .select('system_prompt,google_calendar_id,provider_credentials')
        .eq('tenant_id', tenant.id)
        .single()
      return {
        whatsapp: !!tenant.wa_phone_number_id,
        phone:    !!tenant.sip_uri,
        calendar: !!settings?.google_calendar_id,
        agent:    !!settings?.system_prompt,
        ai:       !!settings?.provider_credentials,
      }
    },
  })
}

function StatusDot({ connected }: { connected: boolean | undefined }) {
  if (connected === undefined) return null
  return (
    <span
      className={cn(
        'ml-auto h-2 w-2 rounded-full shrink-0',
        connected ? 'bg-green-500' : 'bg-muted-foreground/40'
      )}
    />
  )
}

export default function Sidebar() {
  const pathname = usePathname()
  const { data: status } = usePluginStatus()

  return (
    <div className="w-60 bg-card border-r border-border flex flex-col shrink-0">
      {/* Logo */}
      <div className="h-16 flex items-center px-5 border-b border-border gap-3">
        <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
          <Phone className="h-4 w-4 text-primary-foreground" />
        </div>
        <div className="leading-tight min-w-0">
          <p className="text-sm font-semibold truncate">AI Receptionist</p>
          <p className="text-[10px] text-muted-foreground truncate">Workspace</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 overflow-y-auto space-y-5">
        {sections.map((section, i) => (
          <div key={i}>
            {section.label && (
              <p className="px-2 mb-1 text-[10px] font-semibold tracking-widest text-muted-foreground/70 uppercase select-none">
                {section.label}
              </p>
            )}
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href.length > 1 && pathname.startsWith(item.href))
                const connected = item.statusKey
                  ? status?.[item.statusKey as keyof typeof status]
                  : undefined

                return (
                  <Link
                    key={item.href + item.name}
                    href={item.href}
                    className={cn(
                      'flex items-center gap-3 px-2 py-2 text-sm font-medium rounded-lg transition-colors',
                      isActive
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className="flex-1 truncate">{item.name}</span>
                    <StatusDot connected={connected} />
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="p-4 border-t border-border">
        <p className="text-[10px] text-muted-foreground text-center">v1.0.0</p>
      </div>
    </div>
  )
}