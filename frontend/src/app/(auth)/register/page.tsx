'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'
import { Loader2, Phone } from 'lucide-react'

export default function RegisterPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [clinicName, setClinicName] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const { data: authData, error: authError } = await supabase.auth.signUp({ email, password })
      if (authError) throw authError
      if (!authData.user) throw new Error('User creation failed')

      const { error: tenantError } = await supabase.from('tenants').insert({
        owner_id: authData.user.id,
        name: clinicName,
        agent_name: 'Maya',
        is_active: true,
      })
      if (tenantError) throw tenantError

      toast.success('Account created! Please check your email to verify.')
      router.push('/login')
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <div className="flex items-center justify-center mb-4">
          <Phone className="h-10 w-10 text-primary" />
        </div>
        <CardTitle className="text-2xl text-center">Create account</CardTitle>
        <CardDescription className="text-center">Start your AI receptionist in minutes</CardDescription>
      </CardHeader>
      <form onSubmit={handleRegister}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="clinic-name">Clinic Name</Label>
            <Input id="clinic-name" placeholder="Gigi Maju Dental Clinic" value={clinicName}
              onChange={(e) => setClinicName(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" placeholder="clinic@example.com" value={email}
              onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" placeholder="Min. 8 characters" value={password}
              onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          </div>
        </CardContent>
        <CardFooter className="flex flex-col space-y-4">
          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create account
          </Button>
          <p className="text-sm text-center text-muted-foreground">
            Already have an account?{' '}
            <Link href="/login" className="text-primary hover:underline">Sign in</Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  )
}
