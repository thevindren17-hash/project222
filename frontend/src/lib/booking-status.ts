// Single source of truth for booking status colors — used by the
// Appointments table, booking detail modal, and Calendar page so the same
// status always looks the same everywhere in the dashboard.
export const BOOKING_STATUS = {
  pending: {
    label: 'Pending',
    dot: '#f59e0b',
    bg: '#fef3c7',
    text: '#92400e',
    badgeClass: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-400 dark:border-amber-800',
  },
  confirmed: {
    label: 'Confirmed',
    dot: '#22c55e',
    bg: '#dcfce7',
    text: '#166534',
    badgeClass: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-400 dark:border-green-800',
  },
  cancelled: {
    label: 'Cancelled',
    dot: '#ef4444',
    bg: '#fee2e2',
    text: '#991b1b',
    badgeClass: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-800',
  },
  completed: {
    label: 'Completed',
    dot: '#3b82f6',
    bg: '#dbeafe',
    text: '#1e40af',
    badgeClass: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800',
  },
  no_show: {
    label: 'No-Show',
    dot: '#64748b',
    bg: '#f1f5f9',
    text: '#334155',
    badgeClass: 'bg-slate-50 text-slate-700 border-slate-200 dark:bg-slate-900/40 dark:text-slate-400 dark:border-slate-700',
  },
} as const

export type BookingStatusKey = keyof typeof BOOKING_STATUS
