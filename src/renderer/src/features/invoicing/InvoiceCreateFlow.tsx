import { SharedInvoiceCoverage } from './SharedInvoiceCoverage'
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
import { useWorkspacePolicy } from '../settings/use-reporting-time-zone'
import {
  calendarDate,
  calendarDateKey,
  calendarDayStart
} from '../../../../shared/reporting-calendar'
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
  billedRanges?: GeneratedLineItem['billedRanges']
}

let nextId = 1

/** Results where Stripe may hold the invoice; a new draft ID must not replace the operation. */
const UNCERTAIN_CODES = new Set([
  'PROVIDER_OPERATION_UNCERTAIN',
  'INVOICE_OPERATION_PENDING',
  'PROVIDER_RESULT_CONFLICT',
  'PROVIDER_OPERATION_CONFLICT'
])

function codedError(error: { code: string; message: string }): Error {
  return Object.assign(new Error(error.message), { code: error.code })
}

interface InvoiceCreateFlowProps {
  onBack: () => void
  onInvoiceCreated?: (draft: import('../../../../shared/types/invoice').DraftInvoice) => void
}

export function InvoiceCreateFlow({
  onBack,
  onInvoiceCreated
}: InvoiceCreateFlowProps): React.JSX.Element {
  const queryClient = useQueryClient()
  const pendingOperations = useQuery({
    queryKey: ['invoices', 'pending-operations'],
    queryFn: async () => {
      const result = await window.api.invoice.getPendingOperations()
      if (!result.success) throw new Error(result.error.message)
      return result.data
    }
  })
  const resumeDraft = useMutation({
    mutationFn: async (operationId: string) => {
      const result = await window.api.invoice.resumeDraftInvoice(operationId)
      if (!result.success) throw codedError(result.error)
      return result.data
    },
    onSuccess: (draft) => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      onInvoiceCreated?.(draft)
    },
    onError: (error) => {
      // A rejection is now listed with its reason and a Cancel action.
      queryClient.invalidateQueries({ queryKey: ['invoices', 'pending-operations'] })
      toast.error(error instanceof Error ? error.message : 'Unable to resume invoice')
    }
  })
  const [cancelTarget, setCancelTarget] = useState<string | null>(null)
  const cancelDraft = useMutation({
    mutationFn: async (operationId: string) => {
      const result = await window.api.invoice.cancelInvoiceOperation(operationId)
      if (!result.success) throw codedError(result.error)
      return { operationId, basis: result.data.basis }
    },
    onSuccess: ({ operationId, basis }) => {
      // Only this cancelled operation's ID is released; any other draft keeps its ID.
      for (const [fingerprint, id] of operationIds.current)
        if (id === operationId) operationIds.current.delete(fingerprint)
      setProviderNotice(null)
      setCancelTarget(null)
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      toast.success(
        basis === 'draft-deleted'
          ? 'Draft cancelled: Stripe confirmed its draft invoice was deleted. You can create it again.'
          : 'Draft cancelled: Stripe rejected it, so no invoice was created. You can edit and create it again.'
      )
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : 'Unable to cancel this draft')
  })
  const workspacePolicy = useWorkspacePolicy()
  const timeZone = workspacePolicy.data?.policy.reportingTimeZone
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

  const isGenerateReady =
    selectedClientId !== null &&
    startDate &&
    endDate &&
    startDate <= endDate &&
    !workspacePolicy.isPending &&
    !workspacePolicy.isError
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
      sessionIds: item.sessionIds,
      billedRanges: item.billedRanges
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

  // One operation ID per draft content: double-clicks and retries of an unchanged draft
  // resume the same Stripe invoice; an edited draft is a new attempt.
  const [providerNotice, setProviderNotice] = useState<string | null>(null)
  const operationIds = useRef(new Map<string, string>())
  const draftOperationId = (fingerprint: string): string => {
    let id = operationIds.current.get(fingerprint)
    if (!id) {
      id = crypto.randomUUID()
      operationIds.current.set(fingerprint, id)
    }
    return id
  }

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
        sessionIds: item.sessionIds.length > 0 ? item.sessionIds : undefined,
        billedRanges: item.billedRanges
      }))

      const request = {
        clientId: selectedClientId,
        lineItems: stripeLineItems,
        memo: memo.trim() || undefined,
        daysUntilDue,
        periodStart: startDate || undefined,
        periodEnd: endDate || undefined,
        achOnly: achOnly || undefined,
        lineMeta
      }
      const draftResult = await window.api.invoice.createDraftInvoice({
        ...request,
        operationId: draftOperationId(JSON.stringify(request))
      })
      if (!draftResult.success) throw codedError(draftResult.error)
      return draftResult.data
    },
    onSuccess: (draft) => {
      setProviderNotice(null)
      queryClient.invalidateQueries({ queryKey: ['invoices'] })
      // Navigate to the detail view for review before sending
      if (onInvoiceCreated) onInvoiceCreated(draft)
    },
    onError: (err) => {
      queryClient.invalidateQueries({ queryKey: ['invoices', 'pending-operations'] })
      const msg = err instanceof Error ? err.message : 'Failed to create draft'
      const code = (err as { code?: string }).code
      // Stripe may already hold this invoice: only Resume (same operation and keys) is safe.
      if (code && UNCERTAIN_CODES.has(code)) {
        setProviderNotice(msg)
        return
      }
      if (code === 'PROVIDER_OPERATION_CANCELLED') {
        // This content's operation was cancelled (maybe on another computer): a new attempt
        // gets a new ID; the server still refuses it while any unfinished draft remains.
        operationIds.current.clear()
        toast.error(`${msg} Select Review Draft again to create a new one.`)
        return
      }
      if (code === 'PROVIDER_OPERATION_REJECTED') setProviderNotice(null)
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
      if (workspacePolicy.isPending || workspacePolicy.isError) return
      const presetMap: Record<string, DatePreset> = {
        thisWeek: 'this-week',
        lastWeek: 'last-week',
        thisMonth: 'this-month'
      }

      if (preset === 'lastMonth') {
        const now = calendarDate(new Date(), timeZone)
        const start = calendarDayStart(now.getFullYear(), now.getMonth() - 1, 1, timeZone)
        const end = calendarDayStart(now.getFullYear(), now.getMonth(), 0, timeZone)
        setStartDate(calendarDateKey(start, timeZone))
        setEndDate(calendarDateKey(end, timeZone))
        return
      }

      const mapped = presetMap[preset]
      if (!mapped) return
      const range = getDateRangeForPreset(mapped, weekStartDay, timeZone)
      setStartDate(calendarDateKey(range.startDate, timeZone))
      setEndDate(calendarDateKey(range.endDate, timeZone))
    },
    [weekStartDay, timeZone, workspacePolicy.isPending, workspacePolicy.isError]
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
      <SharedInvoiceCoverage />
      {providerNotice && (
        <p role="alert" className="text-sm">
          Stripe may already have this invoice. {providerNotice} Use Resume draft under Unfinished
          invoices; starting a new draft could create a duplicate.
        </p>
      )}
      {pendingOperations.isError && (
        <p role="alert">Unable to load unfinished invoices. Retry before creating another draft.</p>
      )}
      {!!pendingOperations.data?.length && (
        <section
          className="rounded-lg border border-[var(--surface-border)] p-4 space-y-2"
          aria-label="Unfinished invoices"
        >
          <p className="text-sm">
            Resume an unfinished invoice using its saved amounts. It will open for review before
            sending. A draft Stripe rejected cannot change; cancel it, then create it again.
          </p>
          {pendingOperations.data.map((operation) => (
            <div key={operation.operationId} className="space-y-1 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span>
                  {presentationMode ? 'Saved client' : operation.clientName} ·{' '}
                  {operation.periodStart ?? 'Custom period'} · $
                  {(operation.amountCents / 100).toFixed(2)}
                  {operation.testMode ? ' · Test' : ''}
                </span>
                {operation.state === 'conflict' ? (
                  <span className="text-sm">Needs review</span>
                ) : operation.state === 'rejected' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={cancelDraft.isPending}
                    onClick={() => setCancelTarget(operation.operationId)}
                  >
                    Cancel draft
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={resumeDraft.isPending}
                    onClick={() => resumeDraft.mutate(operation.operationId)}
                  >
                    Resume draft
                  </Button>
                )}
              </div>
              {operation.state === 'conflict' && (
                <p role="alert" className="text-sm">
                  Shared records disagree about this draft. Sync your computers and review Shared
                  history in Settings before invoicing this work.
                </p>
              )}
              {operation.state === 'rejected' && (
                <p className="text-[12px] text-[var(--text-secondary)]">
                  Stripe rejected this draft: {operation.rejectionMessage}
                  {operation.providerInvoiceId
                    ? ` Its Stripe draft ${operation.providerInvoiceId} already exists: delete that draft (and any of its items) in Stripe before cancelling.`
                    : ''}
                </p>
              )}
            </div>
          ))}
        </section>
      )}
      <ConfirmDialog
        open={cancelTarget !== null}
        title="Cancel rejected draft"
        description="ClauTime cancels this draft only if Stripe shows it created nothing that remains. Its work becomes available to invoice again."
        confirmLabel="Cancel draft"
        cancelLabel="Keep"
        onConfirm={() => cancelTarget && cancelDraft.mutate(cancelTarget)}
        onCancel={() => setCancelTarget(null)}
      />
      {workspacePolicy.isError && (
        <p role="alert">Unable to load tracking policy. {workspacePolicy.error.message}</p>
      )}
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
