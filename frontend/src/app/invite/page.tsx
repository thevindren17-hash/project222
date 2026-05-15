'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { Loader2, Phone, CheckCircle2 } from 'lucide-react'

type InviteInfo = { email: string; role: string; clinicName: string }

function InviteContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const token = searchParams.get('token') ?? ''

  const [invite, setInvite] = useState<InviteInfo | null>(null)
  const [inviteError, setInviteError] = useState('')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [password, setPassword] = useState('')

  useEffect(() => {
    if (!token) { setInviteError('No invite token found in URL.'); setLoading(false); return }

    fetch(`/api/invite/${token}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) setInviteError(data.error)
        else setInvite(data)
      })
      .catch(() => setInviteError('Failed to load invite'))
      .finally(() => setLoading(false))
  }, [token])

  async function handleAccept(e: React.FormEvent) {
    e.preventDefault()
    if (!invite) return
    setSubmitting(true)
    try {
      const { data: authData, error: signUpError } = await supabase.auth.signUp({
        email: invite.email,
        password,
      })
      if (signUpError) throw signUpError
      if (!authData.user) throw new Error('Sign up failed')

      const res = await fetch('/api/invite/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, userId: authData.user.id }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error)

      setDone(true)
      toast.success('Account created! Redirecting to dashboard…')
      setTimeout(() => router.push('/overview'), 2000)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  if (inviteError) {
    return (
      <Card>
        <CardHeader className="text-center">
          <Phone className="h-10 w-10 text-primary mx-auto mb-2" />
          <CardTitle>Invalid Invite</CardTitle>
          <CardDescription>{inviteError}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (done) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center gap-3">
          <CheckCircle2 className="h-12 w-12 text-green-500" />
          <p className="text-lg font-medium">You&apos;re in!</p>
          <p className="text-sm text-muted-foreground">Redirecting to your dashboard…</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <div className="flex items-center justify-center mb-4">
          <Phone className="h-10 w-10 text-primary" />
        </div>
        <CardTitle className="text-2xl text-center">You&apos;ve been invited</CardTitle>
        <CardDescription className="text-center">
          Join <span className="font-medium text-foreground">{invite!.clinicName}</span> as{' '}
          <Badge variant="secondary" className="capitalize">{invite!.role}</Badge>
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleAccept}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Email</Label>
            <Input value={invite!.email} disabled />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Set a password</Label>
            <Input
              id="password"
              type="password"
              placeholder="Min. 8 characters"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>
        </CardContent>
        <CardFooter>
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create account &amp; join clinic
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

export default function InvitePage() {
  return (
    <Suspense fallback={
      <Card>
        <CardContent className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    }>
      <InviteContent />
    </Suspense>
  )
}
