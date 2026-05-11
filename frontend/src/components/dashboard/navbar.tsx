'use client'

import { Bell, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { supabase } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

export default function Navbar() {
  const router = useRouter()

  async function handleLogout() {
    await supabase.auth.signOut()
    toast.success('Logged out')
    router.push('/login')
  }

  return (
    <header className="h-16 border-b border-border bg-card flex items-center justify-between px-6 shrink-0">
      <div className="flex-1" />
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger className="cursor-pointer rounded-md p-1 hover:bg-muted transition-colors">
            <Avatar className="h-8 w-8">
              <AvatarFallback><User className="h-4 w-4" /></AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>My Account</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Profile</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout}>Log out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
