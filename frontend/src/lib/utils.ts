import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Asia/Kuala_Lumpur is a fixed UTC+8 offset year-round (no DST) -- the
// backend (backend/shared/utils.py: to_db_timestamp/from_db_timestamp)
// correctly converts a clinic-local wall-clock time to a real UTC instant
// before writing to Postgres's TIMESTAMPTZ scheduled_at column, and Supabase
// returns that column as a genuine UTC ISO string (e.g. "...T12:30:00+00:00").
// Naively slicing off the offset and parsing the remaining digits as if they
// were already local time (`parseISO(iso.slice(0, 19))`, the pattern this
// replaces) silently displayed every appointment 8 hours off from its real
// booked time -- confirmed live against the database, not assumed.
//
// This converts the true UTC instant to Malaysia wall-clock digits, then
// builds a Date whose LOCAL fields equal those digits -- so date-fns'
// format() (which always reads local/browser fields) prints the correct
// clinic time regardless of the viewer's own browser timezone.
const CLINIC_UTC_OFFSET_MS = 8 * 60 * 60 * 1000

export function parseClinicLocal(iso: string): Date {
  const utcMs = new Date(iso).getTime()
  const s = new Date(utcMs + CLINIC_UTC_OFFSET_MS)
  return new Date(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate(), s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds())
}
