import { useState, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowLeft, Sparkles, Plus, Trash2, Send, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { getDateRangeForPreset, resolveClientName, type DatePreset } from '@/lib/format'
import { usePresentationMode } from '../settings/use-presentation-mode'
import { projectAlias } from '../../../../shared/presentation-alias'
import type { Client, Project } from '../../../../shared/types/client-project'
import type { GeneratedLineItem, InvoiceOverlap } from '../../../../shared/types/invoice'

interface EditableLineItem {
  id: number
  lineDate: string
  description: string
  hours: string
  amount: string
  durationMinutes: number
  sessionIds: number[]
}

let nextId = 1

interface InvoiceCreateFlowProps {
  onBack: () => void
  onInvoiceCreated?: (draft: import('../../../../shared/types/invoice').DraftInvoice) => void
}

export function InvoiceCreateFlow({
  onBack,
  onInvoiceCreated
}: InvoiceCreateFlowProps): React.JSX.Element {
  const queryClient = useQueryClient()
  const { data: settingsData } = useQuery({
    queryKey: ['settings', 'all'],
    queryFn: async () => {
      const r = await window.api.settings.getAll()
      return r.success ? r.data : {}
    }
  })
  const weekStartDay = parseInt(settingsData?.['week_start_day'] ?? '1', 10)
  const presentationMode = usePresentationMode()
  const [selectedClientId, setSelectedClientId] = useState<number | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [lineItems, setLineItems] = useState<EditableLineItem[]>([])
  const [memo, setMemo] = useState('')
  const [daysUntilDue, setDaysUntilDue] = useState(30)
  const [achOnly, setAchOnly] = useState(() => localStorage.getItem('invoice-ach-only') === 'true')
  const [showAchError, setShowAchError] = useState(false)
  const [overlaps, setOverlaps] = useState<InvoiceOverlap[]>([])
  const [showOverlapWarning, setShowOverlapWarning] = useState(false)

  const { data: clients = [] } = useQuery({
    queryKey: ['clients'],
    queryFn: async () => {
      const r = await window.api.clients.getAll()
      return r.success ? r.data : []
    }
  })

  const { data: allProjects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: async () => {
      const r = await window.api.projects.getAll()
      return r.success ? r.data : []
    }
  })

  // Projects for the selected client
  const clientProjects = allProjects.filter((p: Project) => p.clientId === selectedClientId)

  const invoiceableClients = clients.filter((c: Client) => c.email && c.billableRate && c.isActive)
  const selectedClient = clients.find((c: Client) => c.id === selectedClientId) ?? null

  const totalAmount = lineItems.reduce((sum, item) => {
    const val = parseFloat(item.amount)
    return sum + (isNaN(val) ? 0 : val)
  }, 0)
  const totalHours = lineItems
    .reduce((sum, item) => {
      const h = parseFloat(item.hours)
      return sum + (isNaN(h) ? 0 : h)
    }, 0)
    .toFixed(2)

  const isGenerateReady = selectedClientId !== null && startDate && endDate && startDate <= endDate
  const isSendReady =
    lineItems.length > 0 &&
    lineItems.every((item) => item.description.trim() && parseFloat(item.amount) > 0)

  const doGenerate = useCallback(async () => {
    if (!selectedClientId || !startDate || !endDate) return null
    const r = await window.api.invoice.generateLineItems({
      clientId: selectedClientId,
      startDate,
      endDate,
      projectId: selectedProjectId ?? undefined
    })
    if (!r.success) throw new Error(r.error.message)
    // Handle both new { lineItems, memo } and legacy array format
    const result = r.data
    const generated =
      'lineItems' in result ? result.lineItems : (result as unknown as GeneratedLineItem[])
    const generatedMemo = 'memo' in result ? result.memo : null
    if (generated.length === 0) {
      toast.info('No billable sessions found for this period')
      return null
    }

    const items: EditableLineItem[] = generated.map((item: GeneratedLineItem) => ({
      id: nextId++,
      lineDate: item.lineDate,
      description: item.description,
      hours: (item.durationMinutes / 60).toFixed(2),
      amount: (item.amountCents / 100).toFixed(2),
      durationMinutes: item.durationMinutes,
      sessionIds: item.sessionIds
    }))
    setLineItems(items)
    if (generatedMemo) setMemo(generatedMemo)
    toast.success(`Generated ${items.length} line item${items.length > 1 ? 's' : ''}`)
    return items
  }, [selectedClientId, selectedProjectId, startDate, endDate])

  // Keep a ref so the mutation always calls the latest doGenerate
  const doGenerateRef = useRef(doGenerate)
  doGenerateRef.current = doGenerate

  // Generate line items from sessions
  const generate = useMutation({
    mutationFn: async () => {
      if (!selectedClientId || !startDate || !endDate) throw new Error('Missing fields')

      // Check for overlaps first
      const overlapResult = await window.api.invoice.checkOverlap({
        clientId: selectedClientId,
        startDate,
        endDate
      })
      if (overlapResult.success && overlapResult.data.length > 0) {
        setOverlaps(overlapResult.data)
        setShowOverlapWarning(true)
        return null // Will continue after user confirms
      }

      return doGenerateRef.current()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Generation failed')
  })

  const [isGenerating, setIsGenerating] = useState(false)
  const handleOverlapContinue = useCallback(async () => {
    setShowOverlapWarning(false)
    setIsGenerating(true)
    try {
      await doGenerate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Generation failed')
    } finally {
      setIsGenerating(false)
    }
  }, [doGenerate])

  const addLineItem = useCallback(() => {
    setLineItems((prev) => [
      ...prev,
      {
        id: nextId++,
        lineDate: '',
        description: '',
        hours: '',
        amount: '',
        durationMinutes: 0,
        sessionIds: []
      }
    ])
  }, [])

  const removeLineItem = useCallback((id: number) => {
    setLineItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const updateLineItem = useCallback(
    (id: number, field: 'description' | 'amount' | 'hours', value: string) => {
      setLineItems((prev) =>
        prev.map((item) => {
          if (item.id !== id) return item
          if (field === 'hours') {
            const hrs = parseFloat(value)
            const rate = selectedClient?.billableRate ?? 0
            const newAmount = !isNaN(hrs) && rate > 0 ? (hrs * rate).toFixed(2) : item.amount
            return {
              ...item,
              hours: value,
              amount: newAmount,
              durationMinutes: !isNaN(hrs) ? Math.round(hrs * 60) : item.durationMinutes
            }
          }
          return { ...item, [field]: value }
        })
      )
    },
    [selectedClient]
  )

  // Create draft (for preview)
  const createDraft = useMutation({
    mutationFn: async () => {
      if (!selectedClientId) throw new Error('No client selected')

      const rateCents = selectedClient?.billableRate
        ? Math.round(selectedClient.billableRate * 100)
        : 0
      const stripeLineItems = lineItems.map((item) => {
        const hours = parseFloat(item.hours)
        const hasHours = !isNaN(hours) && hours > 0 && rateCents > 0
        return {
          description: item.description.trim(),
          amountCents: Math.round(parseFloat(item.amount) * 100),
          hours: hasHours ? hours : undefined,
          rateCents: hasHours ? rateCents : undefined
        }
      })

      const lineMeta = lineItems.map((item) => ({
        lineDate: item.lineDate || undefined,
        durationMinutes: item.durationMinutes || undefined,
        sessionIds: item.sessionIds.length > 0 ? item.sessionIds : undefined
      }))

      const draftResult = await window.api.invoice.createDraftInvoice({
        clientId: selectedClientId,
        lineItems: stripeLineItems,
        memo: memo.trim() || undefined,
        daysUntilDue,
        periodStart: startDate || undefined,
        periodEnd: endDate || undefined,
        achOnly: achOnly || undefined,
        lineMeta
      })
      if (!draftResult.success) throw new Error(draftResult.error.message)
      return draftResult.data
    },
    onSuccess: (draft) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      // Navigate to the detail view for review before sending
      if (onInvoiceCreated) onInvoiceCreated(draft)
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : 'Failed to create draft'
      if (
        msg.toLowerCase().includes('us_bank_account') ||
        msg.toLowerCase().includes('ach') ||
        msg.toLowerCase().includes('payment_method')
      ) {
        setShowAchError(true)
      } else {
        toast.error(msg)
      }
    }
  })

  // Date presets
  const setPreset = useCallback(
    (preset: string) => {
      const presetMap: Record<string, DatePreset> = {
        thisWeek: 'this-week',
        lastWeek: 'last-week',
        thisMonth: 'this-month'
      }

      // Format a Date to YYYY-MM-DD using local components — avoids UTC drift
      // that would bump end-of-day dates to the next calendar day in negative offsets.
      const toLocalYmd = (d: Date): string => {
        const y = d.getFullYear()
        const m = String(d.getMonth() + 1).padStart(2, '0')
        const day = String(d.getDate()).padStart(2, '0')
        return `${y}-${m}-${day}`
      }

      if (preset === 'lastMonth') {
        const now = new Date()
        const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
        const end = new Date(now.getFullYear(), now.getMonth(), 0)
        setStartDate(toLocalYmd(start))
        setEndDate(toLocalYmd(end))
        return
      }

      const mapped = presetMap[preset]
      if (!mapped) return
      const range = getDateRangeForPreset(mapped, weekStartDay)
      setStartDate(toLocalYmd(new Date(range.startDate)))
      setEndDate(toLocalYmd(new Date(range.endDate)))
    },
    [weekStartDay]
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack} className="h-7 px-2">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">New Invoice</h2>
      </div>

      {/* Client & Date Range */}
      <section className="rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)] p-4 space-y-3">
        <div>
          <label className="mb-1 block text-[12px] font-semibold text-[var(--text-primary)]">
            Client
          </label>
          <select
            value={selectedClientId ?? ''}
            onChange={(e) => {
              setSelectedClientId(e.target.value ? Number(e.target.value) : null)
              setSelectedProjectId(null)
            }}
            className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          >
            <option value="">Select a client...</option>
            {invoiceableClients.map((c: Client) => (
              <option key={c.id} value={c.id}>
                {resolveClientName(c, presentationMode)} — ${c.billableRate}/hr
              </option>
            ))}
          </select>
        </div>

        {selectedClientId && clientProjects.length > 0 && (
          <div>
            <label className="mb-1 block text-[12px] font-semibold text-[var(--text-primary)]">
              Project
            </label>
            <select
              value={selectedProjectId ?? ''}
              onChange={(e) => setSelectedProjectId(e.target.value ? Number(e.target.value) : null)}
              className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            >
              <option value="">All projects</option>
              {clientProjects.map((p: Project) => (
                <option key={p.id} value={p.id}>
                  {presentationMode ? p.stageName || projectAlias(p.id) : (p.invoiceName ?? p.name)}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex gap-3">
          <div className="flex-1">
            <label className="mb-1 block text-[12px] font-semibold text-[var(--text-primary)]">
              Start Date
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </div>
          <div className="flex-1">
            <label className="mb-1 block text-[12px] font-semibold text-[var(--text-primary)]">
              End Date
            </label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-1">
          {['thisWeek', 'lastWeek', 'thisMonth', 'lastMonth'].map((preset) => (
            <Button
              key={preset}
              size="sm"
              variant="ghost"
              onClick={() => setPreset(preset)}
              className="h-6 px-2 text-[11px]"
            >
              {preset === 'thisWeek'
                ? 'This Week'
                : preset === 'lastWeek'
                  ? 'Last Week'
                  : preset === 'thisMonth'
                    ? 'This Month'
                    : 'Last Month'}
            </Button>
          ))}
        </div>

        <Button
          onClick={() => generate.mutate()}
          disabled={!isGenerateReady || generate.isPending || isGenerating}
          className="w-full bg-[var(--accent)] text-white hover:brightness-[1.15]"
        >
          {generate.isPending || isGenerating ? (
            <>
              <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> Generating...
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" /> Generate Line Items
            </>
          )}
        </Button>
      </section>

      {/* Line Items */}
      {lineItems.length > 0 && (
        <section className="rounded-lg border border-[var(--surface-border)] bg-[var(--background-elevated)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <label className="text-[12px] font-semibold text-[var(--text-primary)]">
              Line Items ({lineItems.length})
            </label>
            <Button size="sm" variant="ghost" onClick={addLineItem} className="h-7 text-[11px]">
              <Plus className="mr-1 h-3 w-3" /> Add Item
            </Button>
          </div>

          {/* Column headers */}
          <div className="mb-2 flex items-center gap-3 px-1">
            <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              Description
            </span>
            <span className="w-16 text-right text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              Hours
            </span>
            <span className="w-28 text-right text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              Amount
            </span>
            <span className="w-8" />
          </div>

          <div className="space-y-2">
            {lineItems.map((item) => (
              <div key={item.id} className="flex items-start gap-3">
                <textarea
                  value={item.description}
                  onChange={(e) => updateLineItem(item.id, 'description', e.target.value)}
                  rows={3}
                  className="flex-1 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-[13px] leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] resize-vertical"
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={item.hours}
                  onChange={(e) => updateLineItem(item.id, 'hours', e.target.value)}
                  className="w-16 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-2 py-1.5 text-right text-[13px] tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
                <div className="flex w-28 items-center justify-end gap-0.5 pt-1">
                  <span className="text-[13px] text-[var(--text-muted)]">$</span>
                  <span className="text-right text-[13px] tabular-nums text-[var(--text-primary)]">
                    {parseFloat(item.amount).toFixed(2)}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => removeLineItem(item.id)}
                  className="mt-1.5 h-7 w-8 p-0 text-[var(--text-muted)] hover:text-[var(--destructive)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>

          <div className="mt-3">
            <label className="mb-1 block text-[11px] font-semibold text-[var(--text-muted)]">
              Memo
            </label>
            <textarea
              rows={3}
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Invoice memo (auto-generated with line items)"
              className="w-full rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-3 py-2 text-[13px] leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] resize-vertical"
            />
          </div>

          <div className="mt-4 border-t border-[var(--surface-border)] pt-3">
            <div className="flex items-center gap-3">
              <span className="flex-1 text-right text-[13px] font-semibold text-[var(--text-primary)]">
                Total
              </span>
              <span className="w-16 text-right text-[13px] font-semibold tabular-nums text-[var(--text-primary)]">
                {totalHours}h
              </span>
              <span className="w-28 text-right text-[14px] font-semibold tabular-nums text-[var(--text-primary)]">
                ${totalAmount.toFixed(2)}
              </span>
              <span className="w-8" />
            </div>
            <div className="mt-3 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <label
                    htmlFor="daysUntilDue"
                    className="text-[12px] text-[var(--text-secondary)] select-none"
                  >
                    Due in
                  </label>
                  <input
                    id="daysUntilDue"
                    type="number"
                    min={1}
                    max={365}
                    value={daysUntilDue}
                    onChange={(e) =>
                      setDaysUntilDue(Math.max(1, parseInt(e.target.value, 10) || 30))
                    }
                    className="w-14 rounded border border-[var(--surface-border)] bg-[var(--background-primary)] px-2 py-1 text-center text-[12px] tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                  />
                  <span className="text-[12px] text-[var(--text-muted)]">days</span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="achOnly"
                    checked={achOnly}
                    onChange={(e) => {
                      setAchOnly(e.target.checked)
                      localStorage.setItem('invoice-ach-only', String(e.target.checked))
                    }}
                    className="h-4 w-4 rounded border-[var(--surface-border)] accent-[var(--accent)]"
                  />
                  <label
                    htmlFor="achOnly"
                    className="text-[12px] text-[var(--text-secondary)] select-none"
                  >
                    ACH only
                  </label>
                </div>
              </div>
              <Button
                onClick={() => createDraft.mutate()}
                disabled={!isSendReady || createDraft.isPending}
                className="bg-[var(--accent)] text-white hover:brightness-[1.15]"
              >
                {createDraft.isPending ? (
                  <>
                    <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> Creating Draft...
                  </>
                ) : (
                  <>
                    <Send className="mr-2 h-4 w-4" /> Review Draft
                  </>
                )}
              </Button>
            </div>
          </div>
        </section>
      )}

      {/* Overlap Warning Dialog */}
      <ConfirmDialog
        open={showOverlapWarning}
        title="Overlapping Invoice Period"
        description={`This period overlaps with ${overlaps.length} existing invoice${overlaps.length > 1 ? 's' : ''} (${overlaps.map((o) => `$${(o.amountDueCents / 100).toFixed(2)}`).join(', ')}). Continue anyway?`}
        confirmLabel="Continue"
        cancelLabel="Cancel"
        onConfirm={handleOverlapContinue}
        onCancel={() => setShowOverlapWarning(false)}
      />

      {/* ACH Not Enabled Error */}
      <Dialog open={showAchError} onOpenChange={setShowAchError}>
        <DialogContent className="max-w-md bg-[var(--background-elevated)] border-[var(--surface-border)]">
          <DialogHeader>
            <DialogTitle className="text-[var(--text-primary)]">
              ACH Payments Not Enabled
            </DialogTitle>
            <DialogDescription className="text-[var(--text-secondary)]">
              Your Stripe account doesn&apos;t have ACH Direct Debit enabled. You need to enable it
              in your Stripe dashboard before sending ACH-only invoices.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Button
              onClick={() => {
                window.open('https://dashboard.stripe.com/settings/payment_methods', '_blank')
              }}
              className="w-full bg-[var(--accent)] text-white hover:brightness-[1.15]"
            >
              Open Stripe Payment Settings
            </Button>
            <Button variant="ghost" onClick={() => setShowAchError(false)} className="w-full">
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
