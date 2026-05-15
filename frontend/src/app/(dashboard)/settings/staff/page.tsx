'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase, getCurrentTenant } from '@/lib/supabase'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { Loader2, Users, Copy, Trash2, UserPlus } from 'lucide-react'

type StaffMember = { id: string; user_id: string; full_name: string | null; role: string; created_at: string }
type Invite = { id: string; email: string; role: string; accepted_at: string | null; expires_at: string; token: string }

export default function StaffPage() {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('staff')
  const [inviteLink, setInviteLink] = useState('')

  const { data: tenant } = useQuery({ queryKey: ['tenant'], queryFn: getCurrentTenant })

  const { data: staff = [], isLoading: loadingStaff } = useQuery<StaffMember[]>({
    queryKey: ['staff', tenant?.id],
    enabled: !!tenant,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('staff_profiles')
        .select('id, user_id, full_name, role, created_at')
        .eq('tenant_id', tenant!.id)
        .order('created_at')
      if (error) throw error
      return data
    },
  })

  const { data: invites = [], isLoading: loadingInvites } = useQuery<Invite[]>({
    queryKey: ['invites', tenant?.id],
    enabled: !!tenant,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('staff_invites')
        .select('id, email, role, accepted_at, expires_at, token')
        .eq('tenant_id', tenant!.id)
        .is('accepted_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
      if (error) throw error
      return data
    },
  })

  const createInvite = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase
        .from('staff_invites')
        .insert({ tenant_id: tenant!.id, email: email.trim(), role })
        .select('token')
        .single()
      if (error) throw error
      return data.token as string
    },
    onSuccess: (token) => {
      const link = `${window.location.origin}/invite?token=${token}`
      setInviteLink(link)
      setEmail('')
      queryClient.invalidateQueries({ queryKey: ['invites', tenant?.id] })
      toast.success('Invite created')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const revokeInvite = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('staff_invites').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invites', tenant?.id] })
      toast.success('Invite revoked')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const removeStaff = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('staff_profiles').delete().eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staff', tenant?.id] })
      toast.success('Staff member removed')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  function copyLink(link: string) {
    navigator.clipboard.writeText(link)
    toast.success('Link copied to clipboard')
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    createInvite.mutate()
  }

  if (tenant?.role !== 'owner') {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Staff Management</h1>
          <p className="text-muted-foreground">Manage your team members</p>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Users className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-sm text-muted-foreground">Only clinic owners can manage staff.</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Staff Management</h1>
        <p className="text-muted-foreground">Invite and manage your team members</p>
      </div>

      {/* Invite form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><UserPlus className="h-5 w-5" /> Invite Staff</CardTitle>
          <CardDescription>Send an invite link for a team member to join this clinic.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleInvite} className="flex flex-col gap-4">
            <div className="flex gap-3 flex-wrap">
              <div className="flex-1 min-w-48 space-y-1">
                <Label>Email</Label>
                <Input
                  type="email"
                  placeholder="staff@example.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label>Role</Label>
                <Select value={role} onValueChange={(v) => v && setRole(v)}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="staff">Staff</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button type="submit" className="self-start" disabled={createInvite.isPending}>
              {createInvite.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Generate invite link
            </Button>
          </form>

          {inviteLink && (
            <div className="mt-4 p-3 bg-muted rounded-md flex items-center gap-2">
              <p className="text-sm font-mono truncate flex-1">{inviteLink}</p>
              <Button size="sm" variant="outline" onClick={() => copyLink(inviteLink)}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pending invites */}
      {(loadingInvites || invites.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle>Pending Invites</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingInvites ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : (
              <ul className="divide-y">
                {invites.map(inv => (
                  <li key={inv.id} className="flex items-center justify-between py-3 gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-sm truncate">{inv.email}</span>
                      <Badge variant="secondary" className="capitalize shrink-0">{inv.role}</Badge>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => copyLink(`${window.location.origin}/invite?token=${inv.token}`)}
                      >
                        <Copy className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => revokeInvite.mutate(inv.id)}
                        disabled={revokeInvite.isPending}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* Current staff */}
      <Card>
        <CardHeader>
          <CardTitle>Current Staff</CardTitle>
        </CardHeader>
        <CardContent>
          {loadingStaff ? (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          ) : staff.length === 0 ? (
            <p className="text-sm text-muted-foreground">No staff members yet.</p>
          ) : (
            <ul className="divide-y">
              {staff.map(member => (
                <li key={member.id} className="flex items-center justify-between py-3 gap-3">
                  <div className="flex items-center gap-3">
                    <span className="text-sm">{member.full_name ?? member.user_id}</span>
                    <Badge variant="secondary" className="capitalize">{member.role}</Badge>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => removeStaff.mutate(member.id)}
                    disabled={removeStaff.isPending}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
