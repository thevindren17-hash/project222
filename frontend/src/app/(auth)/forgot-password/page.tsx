'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { supabase } from '@/lib/supabase'
import { toast } from 'sonner'
import { Loader2, Phone } from 'lucide-react'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)

  async function handleReset(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      if (error) throw error
      setSent(true)
      toast.success('Reset link sent — check your email')
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'Failed to send reset email')
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
        <CardTitle className="text-2xl text-center">Reset password</CardTitle>
        <CardDescription className="text-center">
          {sent ? "Check your email for a reset link" : "Enter your email to receive a reset link"}
        </CardDescription>
      </CardHeader>
      {!sent && (
        <form onSubmit={handleReset}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" placeholder="clinic@example.com" value={email}
                onChange={(e) => setEmail(e.target.value)} required />
            </div>
          </CardContent>
          <CardFooter className="flex flex-col space-y-4">
            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send reset link
            </Button>
            <Link href="/login" className="text-sm text-center text-primary hover:underline">
              Back to sign in
            </Link>
          </CardFooter>
        </form>
      )}
      {sent && (
        <CardFooter>
          <Link href="/login" className="w-full">
            <Button variant="outline" className="w-full">Back to sign in</Button>
          </Link>
        </CardFooter>
      )}
    </Card>
  )
}
