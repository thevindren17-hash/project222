import { Card, CardContent } from '@/components/ui/card'
import { ArrowDown, ArrowUp, Phone, Calendar, Clock, MessageSquare, Bot, AlertTriangle, Star } from 'lucide-react'
import { AreaChart, Area, Tooltip, ResponsiveContainer } from 'recharts'
import { cn } from '@/lib/utils'

interface StatCardProps {
  title: string
  value: string | number
  subtitle?: string
  change?: string
  trend?: 'up' | 'down'
  changeLabel?: string
  icon?: 'phone' | 'calendar' | 'clock' | 'message' | 'bot' | 'alert' | 'star'
  /** Colors the icon chip and sparkline by what the metric means, not just "primary" for everything. */
  tone?: 'primary' | 'success' | 'warning' | 'info'
  /** Recent values, oldest first — renders as a tiny trend sparkline next to the number. */
  sparkline?: number[]
}

const icons = { phone: Phone, calendar: Calendar, clock: Clock, message: MessageSquare, bot: Bot, alert: AlertTriangle, star: Star }

const toneClasses: Record<NonNullable<StatCardProps['tone']>, string> = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-[--color-success]/10 text-[--color-success]',
  warning: 'bg-[--color-warning]/10 text-[--color-warning]',
  info: 'bg-[--color-chart-2]/10 text-[--color-chart-2]',
}

const toneStroke: Record<NonNullable<StatCardProps['tone']>, string> = {
  primary: 'var(--color-primary)',
  success: 'var(--color-success)',
  warning: 'var(--color-warning)',
  info: 'var(--color-chart-2)',
}

export default function StatCard({
  title, value, subtitle, change, trend, changeLabel = 'vs last period',
  icon = 'phone', tone = 'primary', sparkline,
}: StatCardProps) {
  const Icon = icons[icon]
  const sparkData = sparkline?.map((v, i) => ({ i, v }))
  const gradientId = `spark-${title.replace(/[^a-zA-Z0-9]/g, '')}`

  return (
    <Card className="stat-card-glow hover:shadow-md transition-shadow">
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <div className={cn('h-10 w-10 rounded-full flex items-center justify-center', toneClasses[tone])}>
            <Icon className="h-5 w-5" />
          </div>
        </div>

        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="text-3xl font-bold">{value}</p>
            {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
          </div>

          {sparkData && sparkData.length > 1 && (
            <div className="h-10 w-20 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={sparkData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={toneStroke[tone]} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={toneStroke[tone]} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Tooltip
                    cursor={{ stroke: 'var(--color-border)', strokeWidth: 1 }}
                    content={({ active, payload }) =>
                      active && payload?.length ? (
                        <div className="rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-sm">
                          {payload[0].value}
                        </div>
                      ) : null
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke={toneStroke[tone]}
                    strokeWidth={2}
                    fill={`url(#${gradientId})`}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {change && trend && (
          <div className="flex items-center gap-1 mt-2">
            {trend === 'up'
              ? <ArrowUp className="h-4 w-4 text-[--color-success]" />
              : <ArrowDown className="h-4 w-4 text-destructive" />}
            <span className={cn('text-sm font-medium', trend === 'up' ? 'text-[--color-success]' : 'text-destructive')}>
              {change}
            </span>
            <span className="text-xs text-muted-foreground ml-1">{changeLabel}</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
