'use client'

import { useTheme } from 'next-themes'
import { Bell, Sun, Moon, Settings, LogOut, Menu, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { supabase } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useQuery } from '@tanstack/react-query'
import { useEscalations } from '@/hooks/use-escalations'

interface NavbarProps {
  onMenuClick?: () => void
}

export default function Navbar({ onMenuClick }: NavbarProps) {
  const router = useRouter()
  const { theme, setTheme } = useTheme()
  const { escalations, resolve } = useEscalations()

  const { data: user } = useQuery({
    queryKey: ['auth-user'],
    queryFn: async () => {
      const { data } = await supabase.auth.getUser()
      return data.user
    },
  })

  async function handleLogout() {
    await supabase.auth.signOut()
    toast.success('Logged out')
    router.push('/login')
  }

  const email = user?.email || ''
  const initials = email ? email[0].toUpperCase() : '?'

  return (
    <header className="h-16 border-b border-border bg-card flex items-center justify-between px-4 md:px-6 shrink-0">
      <div className="flex-1 flex items-center">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onMenuClick}>
          <Menu className="h-5 w-5" />
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <Popover>
          <PopoverTrigger render={
            <Button variant="ghost" size="icon" className="relative">
              <Bell className="h-5 w-5" />
              {escalations.length > 0 && (
                <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
                  {escalations.length > 9 ? '9+' : escalations.length}
                </span>
              )}
            </Button>
          } />
          <PopoverContent align="end" className="w-80 p-0">
            <div className="px-3 py-2 border-b border-border">
              <p className="text-sm font-medium">Needs a human</p>
            </div>
            {escalations.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                Nothing waiting on you right now.
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                {escalations.map((e) => (
                  <div key={e.id} className="flex items-start justify-between gap-2 px-3 py-2 hover:bg-muted/50 border-b border-border last:border-0">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{e.reason}</p>
                      {e.context && <p className="text-xs text-muted-foreground truncate">{e.context}</p>}
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {new Date(e.created_at).toLocaleString()}
                      </p>
                    </div>
                    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0"
                      onClick={() => resolve(e.id)} title="Mark resolved">
                      <Check className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>

        <DropdownMenu>
          <DropdownMenuTrigger className="cursor-pointer rounded-full p-0.5 hover:ring-2 hover:ring-primary/30 transition-all">
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-primary text-primary-foreground text-sm font-semibold">
                {initials}
              </AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {/* Account info header */}
            <div className="px-3 py-2">
              <p className="text-sm font-medium truncate">{email || 'My Account'}</p>
              <p className="text-xs text-muted-foreground">Clinic Admin</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push('/settings/clinic-info')}>
              <Settings className="h-4 w-4 mr-2" />
              Clinic Settings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              {theme === 'dark'
                ? <><Sun className="h-4 w-4 mr-2" />Light Mode</>
                : <><Moon className="h-4 w-4 mr-2" />Dark Mode</>}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout} variant="destructive">
              <LogOut className="h-4 w-4 mr-2" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
