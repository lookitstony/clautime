import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Plus, ExternalLink, Download, ArrowUp, ArrowDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { getDateRangeForPreset, formatUsd, resolveClientName } from '@/lib/format'
import { useClients } from '../clients/use-clients'
import { usePresentationMode } from '../settings/use-presentation-mode'
import type { LocalInvoice } from '../../../../shared/types/invoice'

type SortKey = 'date' | 'client' | 'period' | 'amount' | 'status'
type SortDir = 'asc' | 'desc'
type StatusFilter = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible'
type PeriodPreset = 'all' | 'this-week' | 'this-month' | 'last-month' | 'this-year' | 'custom'

const ALL_STATUSES: StatusFilter[] = ['open', 'paid', 'draft', 'void', 'uncollectible']
const DEFAULT_STATUSES: StatusFilter[] = ['open', 'paid']

const PERIOD_OPTIONS: { value: PeriodPreset; label: string }[] = [
  { value: 'all', label: 'All Time' },
  { value: 'this-week', label: 'This Week' },
  { value: 'this-month', label: 'This Month' },
  { value: 'last-month', label: 'Last Month' },
  { value: 'this-year', label: 'This Year' },
  { value: 'custom', label: 'Custom Range' }
]

/** Resolve a period preset to a [start, end] epoch-ms window, or null for "no date filter". */
function getPeriodRange(
  preset: PeriodPreset,
  customStart: string,
  customEnd: string
): { start: number; end: number } | null {
  if (preset === 'all') return null
  if (preset === 'custom') {
    if (!customStart || !customEnd) return null
    return {
      start: new Date(`${customStart}T00:00:00`).getTime(),
      end: new Date(`${customEnd}T23:59:59.999`).getTime()
    }
  }
  if (preset === 'last-month') {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
    return { start: start.getTime(), end: end.getTime() }
  }
  if (preset === 'this-year') {
    const now = new Date()
    return {
      start: new Date(now.getFullYear(), 0, 1).getTime(),
      end: new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999).getTime()
    }
  }
  const r = getDateRangeForPreset(preset)
  return { start: new Date(r.startDate).getTime(), end: new Date(r.endDate).getTime() }
}

/**
 * An invoice matches the window if its billing period overlaps it. Invoices with
 * no period fall back to their created date as a single point.
 */
function matchesPeriod(inv: LocalInvoice, range: { start: number; end: number } | null): boolean {
  if (!range) return true
  const startStr = inv.periodStart ?? inv.periodEnd ?? inv.createdAt.slice(0, 10)
  const endStr = inv.periodEnd ?? inv.periodStart ?? inv.createdAt.slice(0, 10)
  const invStart = new Date(startStr).getTime()
  const invEnd = new Date(`${endStr}T23:59:59.999`).getTime()
  return invStart <= range.end && invEnd >= range.start
}

const STATUS_STYLES: Record<string, string> = {
  paid: 'bg-green-500/20 text-green-400',
  open: 'bg-blue-500/20 text-blue-400',
  draft: 'bg-gray-500/20 text-gray-400',
  void: 'bg-red-500/20 text-red-400',
  uncollectible: 'bg-red-500/20 text-red-400',
  overdue: 'bg-amber-500/20 text-amber-400'
}

function getDisplayStatus(inv: LocalInvoice): string {
  if (inv.status === 'open' && inv.dueDate && new Date(inv.dueDate) < new Date()) {
    return 'overdue'
  }
  return inv.status
}

interface InvoiceListViewProps {
  onCreateNew: () => void
  onSelectInvoice: (id: number) => void
}

export function InvoiceListView({
  onCreateNew,
  onSelectInvoice
}: InvoiceListViewProps): React.JSX.Element {
  const queryClient = useQueryClient()
  const { data: clients = [] } = useClients()
  const presentationMode = usePresentationMode()
  const [sortKey, setSortKey] = useState<SortKey>('period')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [activeStatuses, setActiveStatuses] = useState<Set<StatusFilter>>(new Set(DEFAULT_STATUSES))
  const [clientFilter, setClientFilter] = useState<string>('__all__')
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>('all')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')

  const toggleStatus = (status: StatusFilter) => {
    setActiveStatuses((prev) => {
      const next = new Set(prev)
      if (next.has(status)) {
        next.delete(status)
      } else {
        next.add(status)
      }
      return next
    })
  }

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const importFromStripe = useMutation({
    mutationFn: async () => {
      const r = await window.api.invoice.importFromStripe()
      if (!r.success) throw new Error(r.error.message)
      return r.data
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      toast.success(
        count > 0
          ? `Imported ${count} invoice${count > 1 ? 's' : ''} from Stripe`
          : 'No new invoices to import'
      )
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Import failed')
  })

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['invoices'],
    queryFn: async () => {
      // Auto-sync non-terminal invoice statuses from Stripe, then fetch all
      await window.api.invoice.syncAllStatuses().catch(() => {})
      const r = await window.api.invoice.getAll()
      return r.success ? r.data : []
    },
    staleTime: 30_000 // Re-sync at most every 30s
  })

  const sortedInvoices = useMemo(() => {
    const range = getPeriodRange(periodPreset, customStart, customEnd)
    const clientIdFilter = clientFilter === '__all__' ? null : Number(clientFilter)
    const filtered = invoices.filter((inv) => {
      if (activeStatuses.size > 0 && !activeStatuses.has(inv.status as StatusFilter)) return false
      if (clientIdFilter != null && inv.clientId !== clientIdFilter) return false
      if (!matchesPeriod(inv, range)) return false
      return true
    })
    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0
      switch (sortKey) {
        case 'date':
          cmp = a.createdAt.localeCompare(b.createdAt)
          break
        case 'client':
          cmp = a.clientName.localeCompare(b.clientName)
          break
        case 'period':
          cmp = (a.periodStart ?? '').localeCompare(b.periodStart ?? '')
          break
        case 'amount':
          cmp = a.amountDueCents - b.amountDueCents
          break
        case 'status':
          cmp = a.status.localeCompare(b.status)
          break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
    return sorted
  }, [invoices, sortKey, sortDir, activeStatuses, clientFilter, periodPreset, customStart, customEnd])

  // Totals over the currently-filtered set.
  const totals = useMemo(() => {
    const billed = sortedInvoices.reduce((s, i) => s + i.amountDueCents, 0)
    const paid = sortedInvoices.reduce((s, i) => s + i.amountPaidCents, 0)
    return {
      count: sortedInvoices.length,
      billed: billed / 100,
      paid: paid / 100,
      outstanding: Math.max(0, billed - paid) / 100
    }
  }, [sortedInvoices])

  if (isLoading) {
    return <div className="p-6 text-center text-[var(--text-muted)]">Loading invoices...</div>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">Invoices</h2>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => importFromStripe.mutate()}
            disabled={importFromStripe.isPending}
            className="text-[var(--text-secondary)]"
          >
            <Download className="mr-1 h-3.5 w-3.5" />{' '}
            {importFromStripe.isPending ? 'Importing...' : 'Import from Stripe'}
          </Button>
          <Button
            size="sm"
            onClick={onCreateNew}
            className="bg-[var(--accent)] text-white hover:brightness-[1.15]"
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> New Invoice
          </Button>
        </div>
      </div>

      {/* Client + Period Filters */}
      {invoices.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={clientFilter} onValueChange={setClientFilter}>
            <SelectTrigger className="h-8 w-[160px] text-[12px]">
              <SelectValue placeholder="All Clients" />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="__all__">All Clients</SelectItem>
              {clients.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {resolveClientName(c, presentationMode)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={periodPreset}
            onValueChange={(v) => setPeriodPreset(v as PeriodPreset)}
          >
            <SelectTrigger className="h-8 w-[140px] text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {PERIOD_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {periodPreset === 'custom' && (
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                className="h-8 rounded-md border border-[var(--surface-border)] bg-[var(--background-secondary)] px-2 text-[12px] text-[var(--text-primary)]"
              />
              <span className="text-[12px] text-[var(--text-muted)]">–</span>
              <input
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                className="h-8 rounded-md border border-[var(--surface-border)] bg-[var(--background-secondary)] px-2 text-[12px] text-[var(--text-primary)]"
              />
            </div>
          )}
        </div>
      )}

      {/* Status Filters */}
      <div className="flex items-center gap-1.5">
        {ALL_STATUSES.map((status) => (
          <button
            key={status}
            onClick={() => toggleStatus(status)}
            className={cn(
              'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
              activeStatuses.has(status)
                ? STATUS_STYLES[status]
                : 'bg-[var(--background-primary)] text-[var(--text-muted)] opacity-50 hover:opacity-75'
            )}
          >
            {status}
          </button>
        ))}
      </div>

      {/* Filtered totals */}
      {invoices.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(
            [
              ['Invoices', String(totals.count), 'text-[var(--text-primary)]'],
              ['Billed', formatUsd(totals.billed, 2), 'text-[var(--accent)]'],
              ['Paid', formatUsd(totals.paid, 2), 'text-green-400'],
              ['Outstanding', formatUsd(totals.outstanding, 2), 'text-amber-400']
            ] as const
          ).map(([label, value, valueClass]) => (
            <div
              key={label}
              className="rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)] px-3 py-2"
            >
              <p className="text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                {label}
              </p>
              <p className={cn('mt-0.5 font-mono text-[15px] font-bold', valueClass)}>{value}</p>
            </div>
          ))}
        </div>
      )}

      {invoices.length === 0 ? (
        <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)] p-8 text-center">
          <p className="text-[14px] text-[var(--text-primary)]">No invoices yet</p>
          <p className="mt-1 text-[12px] text-[var(--text-muted)]">
            Create your first invoice to get started.
          </p>
        </div>
      ) : sortedInvoices.length === 0 ? (
        <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)] p-8 text-center">
          <p className="text-[14px] text-[var(--text-primary)]">No invoices match your filters</p>
          <p className="mt-1 text-[12px] text-[var(--text-muted)]">
            Adjust the client, period, or status filters.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)]">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-[var(--surface-border)] text-left text-[11px] font-medium text-[var(--text-muted)]">
                {(
                  [
                    ['date', 'Date', ''],
                    ['client', 'Client', ''],
                    ['period', 'Period', ''],
                    ['amount', 'Amount', 'text-right'],
                    ['status', 'Status', '']
                  ] as const
                ).map(([key, label, extra]) => (
                  <th
                    key={key}
                    onClick={() => toggleSort(key)}
                    className={cn(
                      'px-4 py-2 cursor-pointer select-none hover:text-[var(--text-primary)] transition-colors',
                      extra
                    )}
                  >
                    <span className="inline-flex items-center gap-1">
                      {label}
                      {sortKey === key &&
                        (sortDir === 'asc' ? (
                          <ArrowUp className="h-3 w-3" />
                        ) : (
                          <ArrowDown className="h-3 w-3" />
                        ))}
                    </span>
                  </th>
                ))}
                <th className="px-4 py-2 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {sortedInvoices.map((inv: LocalInvoice) => {
                const displayStatus = getDisplayStatus(inv)
                return (
                  <tr
                    key={inv.id}
                    onClick={() => onSelectInvoice(inv.id)}
                    className="cursor-pointer border-b border-[var(--surface-border)] last:border-b-0 hover:bg-[var(--background-primary)] transition-colors"
                  >
                    <td className="px-4 py-2.5 text-[var(--text-secondary)]">
                      {new Date(inv.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-primary)]">{inv.clientName}</td>
                    <td className="px-4 py-2.5 text-[var(--text-secondary)]">
                      {inv.periodStart && inv.periodEnd
                        ? `${new Date(inv.periodStart).toLocaleDateString()} – ${new Date(inv.periodEnd).toLocaleDateString()}`
                        : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right text-[var(--text-primary)]">
                      ${(inv.amountDueCents / 100).toFixed(2)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.5 text-[11px] font-medium',
                          STATUS_STYLES[displayStatus] ?? STATUS_STYLES.draft
                        )}
                      >
                        {displayStatus}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {inv.hostedUrl && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            const url = inv.hostedUrl!
                            if (
                              url.startsWith('https://invoice.stripe.com/') ||
                              url.startsWith('https://pay.stripe.com/')
                            ) {
                              window.open(url, '_blank')
                            }
                          }}
                          className="text-[var(--text-muted)] hover:text-[var(--accent)]"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
