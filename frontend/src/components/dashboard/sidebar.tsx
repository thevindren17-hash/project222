'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { LayoutDashboard, Calendar, ClipboardList, Phone, MessageSquare, BarChart3, Settings } from 'lucide-react'

const navigation = [
  { name: 'Overview', href: '/overview', icon: LayoutDashboard },
  { name: 'Calendar', href: '/calendar', icon: Calendar },
  { name: 'Appointments', href: '/appointments', icon: ClipboardList },
  { name: 'Call Logs', href: '/call-logs', icon: Phone },
  { name: 'WhatsApp', href: '/whatsapp', icon: MessageSquare },
  { name: 'Analytics', href: '/analytics', icon: BarChart3 },
  { name: 'Settings', href: '/settings', icon: Settings },
]

export default function Sidebar() {
  const pathname = usePathname()
  return (
    <div className="w-64 bg-card border-r border-border flex flex-col shrink-0">
      <div className="h-16 flex items-center px-6 border-b border-border">
        <Phone className="h-8 w-8 text-primary" />
        <span className="ml-3 text-lg font-semibold">AI Receptionist</span>
      </div>
      <nav className="flex-1 px-4 py-6 space-y-1">
        {navigation.map((item) => {
          const isActive = pathname.startsWith(item.href)
          return (
            <Link key={item.name} href={item.href}
              className={cn(
                'flex items-center px-3 py-2 text-sm font-medium rounded-md transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <item.icon className="h-5 w-5 mr-3" />
              {item.name}
            </Link>
          )
        })}
      </nav>
      <div className="p-4 border-t border-border">
        <p className="text-xs text-muted-foreground text-center">v1.0.0</p>
      </div>
    </div>
  )
}
