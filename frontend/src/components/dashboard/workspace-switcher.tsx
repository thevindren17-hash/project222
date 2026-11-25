'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronsUpDown, Check, Plus, Loader2 } from 'lucide-react'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import {
  supabase, getCurrentUser, getAccessibleTenants, getCurrentTenant, setActiveTenant,
} from '@/lib/supabase'

// Lives where the sidebar logo block used to have a static "Workspace"
// label. Only an agency login with more than one accessible clinic sees
// switcher chrome at all -- a single-clinic owner just sees their clinic
// name, same as before.
export default function WorkspaceSwitcher() {
  const queryClient = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const { data: tenants } = useQuery({ queryKey: ['accessible-tenants'], queryFn: getAccessibleTenants })
  const { data: active } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })

  if (!tenants || tenants.length === 0) return null

  // Wiping the whole cache (instead of targeting individual query keys) is
  // deliberate: most queries across the app key off ['tenant'] results
  // without tenant.id in their own key, so a partial invalidate would risk
  // leaving one clinic's numbers on screen under another clinic's name.
  function switchTo(tenantId: string) {
    if (tenantId === active?.id) return
    setActiveTenant(tenantId)
    queryClient.clear()
  }

  async function handleAddClinic(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    try {
      const user = await getCurrentUser()
      if (!user) throw new Error('Not logged in')
      const { data, error } = await supabase
        .from('tenants')
        .insert({ owner_id: user.id, name: newName, is_active: true })
        .select('id')
        .single()
      if (error) throw error

      setAddOpen(false)
      setNewName('')
      setActiveTenant(data.id)
      queryClient.clear()
      toast.success(`${newName} added`)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not add clinic')
    } finally {
      setCreating(false)
    }
  }

  if (tenants.length === 1) {
    return (
      <div className="leading-tight min-w-0">
        <p className="text-sm font-semibold truncate">{tenants[0].name}</p>
        <p className="text-[10px] text-muted-foreground truncate">Workspace</p>
      </div>
    )
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex items-center gap-1.5 min-w-0 flex-1 text-left rounded-md -mx-1 px-1 py-0.5 hover:bg-muted transition-colors">
          <div className="leading-tight min-w-0">
            <p className="text-sm font-semibold truncate">{active?.name || 'Select clinic'}</p>
            <p className="text-[10px] text-muted-foreground truncate capitalize">{active?.role || 'Workspace'}</p>
          </div>
          <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground shrink-0 ml-auto" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuLabel>Your clinics</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {tenants.map((t) => (
            <DropdownMenuItem key={t.id} onClick={() => switchTo(t.id)} className="justify-between">
              <span className="truncate">{t.name}</span>
              {t.id === active?.id
                ? <Check className="h-4 w-4 text-primary shrink-0" />
                : <Badge variant="secondary" className="text-[10px] capitalize shrink-0">{t.role}</Badge>}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add another clinic
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <form onSubmit={handleAddClinic}>
            <DialogHeader>
              <DialogTitle>Add another clinic</DialogTitle>
              <DialogDescription>
                Creates a new, separate workspace under your login — its own data, its own
                WhatsApp/Google connections, kept apart from your other clinics.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2">
              <Label htmlFor="new-clinic-name">Clinic name</Label>
              <Input
                id="new-clinic-name"
                placeholder="Gigi Maju Dental Clinic"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={creating || !newName.trim()}>
                {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create clinic
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
