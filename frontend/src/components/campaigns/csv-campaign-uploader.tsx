'use client'

import { useState, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { Loader2, Send } from 'lucide-react'

const NAME_CANDIDATES  = ['name', 'nama', 'patient', 'full name', 'patient name', 'pesakit']
const PHONE_CANDIDATES = ['phone', 'mobile', 'tel', 'contact', 'number', 'no', 'telefon', 'hp', 'handphone']

export type CampaignType = 'reminder' | 'feedback' | 'recall' | 'marketing'

export interface ExtraColumn {
  key: string
  label: string
  candidates: string[]
}

interface CsvResultDetail { name: string; phone: string; status: 'skipped' | 'failed'; reason: string }
interface CsvResult { sent: number; skipped: number; failed: number; details?: CsvResultDetail[] }

function detectCol(headers: string[], candidates: string[]): string {
  const lower = headers.map(h => h.toLowerCase().trim())
  for (const c of candidates) {
    const idx = lower.findIndex(h => h.includes(c))
    if (idx !== -1) return headers[idx]
  }
  return ''
}

export default function CsvCampaignUploader({
  type,
  tenantId,
  isConnected,
  messageTemplate,
  extraColumns = [],
  intervalMonths,
  templateId,
}: {
  type: CampaignType
  tenantId: string
  isConnected: boolean
  messageTemplate: string
  extraColumns?: ExtraColumn[]
  intervalMonths?: number
  /** Required when type === 'marketing' -- identifies which approved whatsapp_templates row to send. */
  templateId?: string
}) {
  const [csvHeaders, setCsvHeaders] = useState<string[]>([])
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([])
  const [nameCol, setNameCol] = useState('')
  const [phoneCol, setPhoneCol] = useState('')
  const [extraCols, setExtraCols] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<CsvResult | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const parseFile = useCallback(async (file: File) => {
    setResult(null)
    setCsvHeaders([])
    setCsvRows([])
    setExtraCols({})

    // Reject oversized files before handing them to Papa.parse/XLSX.read —
    // both parse entirely on the main thread, so a huge or malformed file
    // (accidental or malicious) can freeze the tab before the 300-contact
    // cap ever gets a chance to apply (that cap only kicks in server-side,
    // after parsing already completed).
    const MAX_FILE_BYTES = 8 * 1024 * 1024 // 8 MB — generous for a few hundred contact rows
    if (file.size > MAX_FILE_BYTES) {
      toast.error('File is too large (max 8MB) — please split it into smaller batches')
      return
    }

    try {
      if (file.name.endsWith('.csv') || file.type === 'text/csv') {
        const Papa = (await import('papaparse')).default
        Papa.parse<Record<string, string>>(file, {
          header: true,
          skipEmptyLines: true,
          complete: (res) => {
            const headers = res.meta.fields || []
            setCsvHeaders(headers)
            setCsvRows(res.data as Record<string, string>[])
            setNameCol(detectCol(headers, NAME_CANDIDATES))
            setPhoneCol(detectCol(headers, PHONE_CANDIDATES))
            const detected: Record<string, string> = {}
            for (const col of extraColumns) detected[col.key] = detectCol(headers, col.candidates)
            setExtraCols(detected)
          },
        })
      } else {
        const XLSX = await import('xlsx')
        const buf = await file.arrayBuffer()
        const wb  = XLSX.read(buf, { type: 'array' })
        const ws  = wb.Sheets[wb.SheetNames[0]]
        const data = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: '' })
        if (!data.length) { toast.error('Spreadsheet appears to be empty'); return }
        const headers = Object.keys(data[0])
        setCsvHeaders(headers)
        setCsvRows(data)
        setNameCol(detectCol(headers, NAME_CANDIDATES))
        setPhoneCol(detectCol(headers, PHONE_CANDIDATES))
        const detected: Record<string, string> = {}
        for (const col of extraColumns) detected[col.key] = detectCol(headers, col.candidates)
        setExtraCols(detected)
      }
    } catch {
      toast.error('Could not read file — make sure it is a valid CSV or Excel file')
    }
  }, [extraColumns])

  async function sendCsvCampaign() {
    if (!tenantId || !nameCol || !phoneCol || !csvRows.length) return
    setSending(true)
    setResult(null)
    try {
      const contacts = csvRows
        .map(r => {
          const contact: Record<string, string> = {
            name: String(r[nameCol] || '').trim(),
            phone: String(r[phoneCol] || '').trim(),
          }
          for (const col of extraColumns) {
            const header = extraCols[col.key]
            if (header) contact[col.key] = String(r[header] || '').trim()
          }
          return contact
        })
        .filter(c => c.phone.length >= 6)

      const res = await fetch('/api/campaigns/send-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: tenantId,
          type,
          contacts,
          message_template: messageTemplate.trim() || undefined,
          interval_months: intervalMonths,
          template_id: templateId,
        }),
      })
      const data = await res.json()
      if (!res.ok) { toast.error(data.error || 'Send failed'); return }
      setResult(data)
    } catch {
      toast.error('Network error')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Drop zone */}
      <div
        className={`relative border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${
          dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-accent/30'
        }`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer.files[0]
          if (file) parseFile(file)
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) parseFile(f); e.target.value = '' }}
        />
        <p className="text-sm text-muted-foreground">
          {csvRows.length > 0
            ? <span className="text-foreground font-medium">{csvRows.length} rows loaded — click to replace</span>
            : <>Drag & drop or <span className="text-primary underline">browse</span> to upload</>}
        </p>
      </div>

      {/* Column mapping + preview */}
      {csvHeaders.length > 0 && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Name column</Label>
              <select
                value={nameCol}
                onChange={(e) => setNameCol(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">— select —</option>
                {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Phone column</Label>
              <select
                value={phoneCol}
                onChange={(e) => setPhoneCol(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">— select —</option>
                {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
            {extraColumns.map((col) => (
              <div key={col.key} className="space-y-1.5">
                <Label className="text-xs">{col.label} column <span className="text-muted-foreground font-normal">(optional)</span></Label>
                <select
                  value={extraCols[col.key] || ''}
                  onChange={(e) => setExtraCols({ ...extraCols, [col.key]: e.target.value })}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">— none —</option>
                  {csvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>

          {/* Preview table */}
          {nameCol && phoneCol && (
            <div className="rounded-md border overflow-hidden overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted/60">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Name</th>
                    <th className="text-left px-3 py-2 font-medium text-muted-foreground">Phone</th>
                    {extraColumns.filter(c => extraCols[c.key]).map(c => (
                      <th key={c.key} className="text-left px-3 py-2 font-medium text-muted-foreground">{c.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {csvRows.slice(0, 5).map((r, i) => (
                    <tr key={i} className="border-t">
                      <td className="px-3 py-2">{r[nameCol] || '—'}</td>
                      <td className="px-3 py-2 font-mono">{r[phoneCol] || '—'}</td>
                      {extraColumns.filter(c => extraCols[c.key]).map(c => (
                        <td key={c.key} className="px-3 py-2">{r[extraCols[c.key]] || '—'}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {csvRows.length > 5 && (
                <p className="px-3 py-2 text-[11px] text-muted-foreground border-t bg-muted/30">
                  …and {csvRows.length - 5} more rows
                </p>
              )}
            </div>
          )}

          <Button
            onClick={sendCsvCampaign}
            disabled={sending || !nameCol || !phoneCol || !isConnected}
            size="sm"
            className="w-full sm:w-auto"
          >
            {sending
              ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Sending…</>
              : <><Send className="mr-2 h-4 w-4" />Send to {csvRows.length} contacts</>}
          </Button>
          {!isConnected && (
            <p className="text-xs text-destructive">WhatsApp must be connected before sending.</p>
          )}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg bg-green-500/10 border border-green-500/20 p-3">
              <p className="text-xl font-bold text-green-600 dark:text-green-400">{result.sent}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Sent</p>
            </div>
            <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/20 p-3">
              <p className="text-xl font-bold text-yellow-600 dark:text-yellow-400">{result.skipped}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Already contacted</p>
            </div>
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3">
              <p className="text-xl font-bold text-destructive">{result.failed}</p>
              <p className="text-xs text-muted-foreground mt-0.5">Failed</p>
            </div>
          </div>

          {!!result.details?.length && (
            <div className="rounded-md border overflow-hidden">
              <div className="px-3 py-2 text-xs font-medium text-muted-foreground bg-muted/60 border-b">
                Skipped / failed contacts — fix and re-upload just these rows if needed
              </div>
              <div className="max-h-56 overflow-y-auto">
                <table className="w-full text-xs">
                  <tbody>
                    {result.details.map((d, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-3 py-2 whitespace-nowrap">{d.name}</td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap">{d.phone}</td>
                        <td className={`px-3 py-2 ${d.status === 'failed' ? 'text-destructive' : 'text-yellow-600 dark:text-yellow-400'}`}>
                          {d.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
