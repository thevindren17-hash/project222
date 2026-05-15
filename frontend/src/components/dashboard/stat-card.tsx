import { Card, CardContent } from '@/components/ui/card'
import { ArrowDown, ArrowUp, Phone, Calendar, Clock, MessageSquare, Bot, AlertTriangle, Star } from 'lucide-react'
import { cn } from '@/lib/utils'

interface StatCardProps {
  title: string
  value: string | number
  subtitle?: string
  change?: string
  trend?: 'up' | 'down'
  icon?: 'phone' | 'calendar' | 'clock' | 'message' | 'bot' | 'alert' | 'star'
}

const icons = { phone: Phone, calendar: Calendar, clock: Clock, message: MessageSquare, bot: Bot, alert: AlertTriangle, star: Star }

export default function StatCard({ title, value, subtitle, change, trend, icon = 'phone' }: StatCardProps) {
  const Icon = icons[icon]
  return (
    <Card className="stat-card-glow hover:shadow-md transition-shadow">
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Icon className="h-5 w-5 text-primary" />
          </div>
        </div>
        <p className="text-3xl font-bold">{value}</p>
        {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
        {change && trend && (
          <div className="flex items-center gap-1 mt-2">
            {trend === 'up'
              ? <ArrowUp className="h-4 w-4 text-[--color-success]" />
              : <ArrowDown className="h-4 w-4 text-destructive" />}
            <span className={cn('text-sm font-medium', trend === 'up' ? 'text-[--color-success]' : 'text-destructive')}>
              {change}
            </span>
            <span className="text-xs text-muted-foreground ml-1">vs last week</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
