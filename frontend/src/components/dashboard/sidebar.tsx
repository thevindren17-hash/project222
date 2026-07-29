'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import {
  LayoutDashboard, Calendar, ClipboardList, Phone, MessageSquare,
  BarChart3, Bot, Users, Building2, FlaskConical, Bell, UserRoundCheck, Star, Sheet,
  MessageSquareText,
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
      { name: 'Analytics', href: '/analytics',  icon: BarChart3 },
    ],
  },
  {
    label: 'CONFIGURE',
    items: [
      { name: 'Agent Config', href: '/settings/plugins/agent', icon: Bot,         statusKey: 'agent' },
      { name: 'Test Agent',   href: '/test-agent',           icon: FlaskConical },
    ],
  },
  {
    label: 'CAMPAIGNS',
    items: [
      { name: 'Appointment Reminder System', href: '/campaigns/reminders', icon: Bell },
      { name: 'Patient Recall System',       href: '/campaigns/recall',    icon: UserRoundCheck },
      { name: 'Feedback and Review System',  href: '/campaigns/feedback',  icon: Star },
      { name: 'Marketing Templates',         href: '/campaigns/templates', icon: MessageSquareText },
    ],
  },
  {
    label: 'CONNECT',
    items: [
      { name: 'WhatsApp', href: '/settings/plugins/whatsapp', icon: MessageSquare, statusKey: 'whatsapp' },
      { name: 'Google',   href: '/settings/plugins/google',   icon: Sheet,         statusKey: 'google' },
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

// On the mobile drawer, the clinic only wants a lean 3-item menu
// (everything else is still there at md+ — desktop is unchanged).
const MOBILE_NAV_HREFS = new Set(['/appointments', '/whatsapp', '/analytics'])

function usePluginStatus() {
  return useQuery({
    queryKey: ['plugin-status'],
    staleTime: 60_000,
    queryFn: async () => {
      const tenant = await getCurrentTenant()
      if (!tenant) return {}
      const { data: settings } = await supabase
        .from('tenant_settings')
        .select('llm_config,google_access_token,google_refresh_token,provider_credentials')
        .eq('tenant_id', tenant.id)
        .single()
      // Booking flow & safety rules are always active — the agent is only
      // blocked on having a working LLM provider key, not a saved prompt.
      const llmProvider = settings?.llm_config?.provider
      return {
        whatsapp: !!tenant.wa_phone_number_id,
        google:   !!(settings?.google_access_token || settings?.google_refresh_token),
        agent:    !!(llmProvider && (settings?.provider_credentials as Record<string, Record<string, string>> | undefined)?.[llmProvider]?.api_key),
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

interface SidebarProps {
  open?: boolean
  onClose?: () => void
}

export default function Sidebar({ open = false, onClose }: SidebarProps) {
  const pathname = usePathname()
  const { data: status } = usePluginStatus()

  // Close the mobile drawer automatically whenever navigation happens —
  // otherwise it stays open over the newly-loaded page.
  useEffect(() => {
    onClose?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={onClose}
        />
      )}
      <div
        className={cn(
          'w-60 bg-card border-r border-border flex flex-col shrink-0',
          'fixed inset-y-0 left-0 z-50 transition-transform duration-200 ease-in-out',
          'md:static md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full'
        )}
      >
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
          {sections.map((section, i) => {
            const hasMobileItem = section.items.some((item) => MOBILE_NAV_HREFS.has(item.href))
            return (
              <div key={i} className={cn(!hasMobileItem && 'hidden md:block')}>
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
                    const mobileVisible = MOBILE_NAV_HREFS.has(item.href)

                    return (
                      <Link
                        key={item.href + item.name}
                        href={item.href}
                        className={cn(
                          'items-center gap-3 px-2 py-2 text-sm font-medium rounded-lg transition-colors',
                          mobileVisible ? 'flex' : 'hidden md:flex',
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
            )
          })}
        </nav>

        <div className="p-4 border-t border-border">
          <p className="text-[10px] text-muted-foreground text-center">v1.0.0</p>
        </div>
      </div>
    </>
  )
}