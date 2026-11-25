import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface EmptyStateAction {
  label: string
  href?: string
  onClick?: () => void
}

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  action?: EmptyStateAction
  className?: string
}

export default function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  const button = action && (
    <Button size="sm" variant="outline" className="mt-3" onClick={action.onClick}>
      {action.label}
    </Button>
  )

  return (
    <div className={cn('flex flex-col items-center justify-center gap-1 py-10 text-center', className)}>
      <div className="h-11 w-11 rounded-full bg-muted flex items-center justify-center mb-2">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="text-xs text-muted-foreground max-w-[22rem]">{description}</p>}
      {action && (action.href ? <Link href={action.href}>{button}</Link> : button)}
    </div>
  )
}
