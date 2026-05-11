'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Users } from 'lucide-react'

export default function StaffPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Staff Management</h1>
        <p className="text-muted-foreground">Manage your team members and permissions</p>
      </div>
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <Users className="h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-lg font-medium">Coming Soon</p>
          <p className="text-sm text-muted-foreground mt-1">Staff management will be available in a future update</p>
        </CardContent>
      </Card>
    </div>
  )
}
