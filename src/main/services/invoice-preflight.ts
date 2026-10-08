import type Stripe from 'stripe'
import { eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { AppError } from '../../shared/types/ipc'
import type { InvoiceBillingRange } from '../../shared/types/invoice'
import type { FolderSyncState } from '../../shared/types/folder-sync'
import { folderSyncSettings } from '../db/schema/folder-sync'
import { sessions } from '../db/schema/sessions'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import { providerOperations, providerOperationResults } from '../db/schema/provider-operations'
import { assertSharedBillingReady } from './folder-sync-billing-guard'
import { billingRange, unbilledSessions } from './session-billing'
import type { LocalInvoiceBilling } from './invoice-portable-billing'
import {
  invoiceOperationId,
  OPERATION_METADATA,
  readFrozenInvoiceRequest,
  type FrozenInvoiceRequest,
  type StripeContext
} from './stripe-operation-service'
import { providerOperationResolution } from './provider-operation-store'
import { historySyncWorkspace } from './folder-sync-history-records'
import { readCanonicalIntervalSnapshot } from './canonical-intervals'
import {
  invoiceSyncId,
  readInvoiceRecordState,
  readProviderIntentState,
  activityBilledRanges
} from './folder-sync-invoice-records'

/*
 * Checks before a provider write (folder-sync-plan.md decision H): import the folder changes
 * that are available; then, for a NEW draft, refresh the client's Stripe invoices and, in the
 * transaction that retains the operation, re-check known gaps, the shared policy, affected
 * conflicts and billed-work exclusions. A retained operation is never re-checked or re-frozen:
 * its uncertain writes must remain resumable under the same keys.
 */

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>

/** The coordinator's state after an import pass (FolderSyncState subset). */
export type InvoiceImportStatus = Pick<FolderSyncState, 'status' | 'issues'>

export interface InvoicePreflightHooks {
  /**
   * Import the folder batches currently available and return the coordinator state after it.
   * Enabled sync: coordinator.syncNow(). Paused sync (`paused`): run ONE import-only pass that
   * reads and applies available batches without publishing or re-enabling sync, or return
   * status 'disabled' when that is not supported (invoicing then waits for an explicit resume).
   * Reject only on an unexpected failure.
   */
  importAvailableChanges(options: { paused: boolean }): Promise<InvoiceImportStatus>
}

let hooks: InvoicePreflightHooks | null = null

/** Root wiring at app init; injected so this module never imports the coordinator. */
export function configureInvoicePreflight(next: InvoicePreflightHooks | null): void {
  hooks = next
}

/**
 * Before any invoice create, resume or send: import what the shared folder holds so billed work,
 * operations and cancellations from the other computer are known. Decision by the hook's status:
 * - no folder connected: nothing to import (local history only);
 * - 'idle' / 'incomplete': proceed; known gaps and conflicts affecting this client are then
 *   blocked by the scoped billing guard, while unrelated issues do not stop invoicing;
 * - 'disabled' (paused and not imported), 'unavailable', 'update-required', a failure, or an
 *   unwired hook: block. A paused or unreachable folder is never silently skipped.
 */
export async function importBeforeInvoiceWrite<S extends Record<string, unknown>>(
  db: Db<S>
): Promise<void> {
  const connection = db
    .select()
    .from(folderSyncSettings)
    .where(eq(folderSyncSettings.slot, 1))
    .get()
  if (!connection) return
  if (!hooks)
    throw new AppError(
      'SYNC_BILLING_INCOMPLETE',
      'Shared history is still starting. Try again after it finishes loading.'
    )
  let state: InvoiceImportStatus
  try {
    state = await hooks.importAvailableChanges({ paused: !connection.enabled })
  } catch (error) {
    throw new AppError(
      'SYNC_BILLING_INCOMPLETE',
      `Shared history could not be imported before invoicing. ${error instanceof Error ? error.message : ''}`.trim()
    )
  }
  const detail = state.issues.map((issue) => issue.message).join(' ')
  switch (state.status) {
    case 'idle':
    case 'incomplete':
      return
    case 'disabled':
      throw new AppError(
        'SYNC_PAUSED_BILLING',
        'Folder sync is paused. Resume it in Settings so billed work and invoices from your other computers are known before invoicing.'
      )
    case 'update-required':
      throw new AppError(
        'SYNC_UPDATE_REQUIRED',
        'Shared history needs a newer ClauTime before invoicing. Update this computer first.'
      )
    default:
      throw new AppError(
        'SYNC_BILLING_INCOMPLETE',
        `The shared folder could not be read, so work billed on another computer may be missing. ${detail}`.trim()
      )
  }
}

/** Covered when the remaining unbilled intervals include the whole range inside its row. */
function isUnbilled(remaining: Array<[number, number]>, start: number, end: number): boolean {
  let cursor = start
  for (const [a, b] of remaining.sort((x, y) => x[0] - y[0])) {
    if (a > cursor) break
    if (b > cursor) cursor = b
    if (cursor >= end) return true
  }
  return cursor >= end
}

/**
 * Synchronous preflight for a new draft: shared billing is ready for this client and period, and
 * every range the preview bills is still unbilled here (another computer's invoice, a retained
 * operation or a refreshed Stripe invoice may have arrived since the preview). Session-machine
 * display filters never apply to billing.
 */
export function checkNewInvoiceBilling<S extends Record<string, unknown>>(
  tx: Db<S>,
  clientId: number,
  frozen: FrozenInvoiceRequest,
  localBilling: LocalInvoiceBilling,
  testMode: boolean
): void {
  assertSharedBillingReady(tx, {
    clientId,
    startDate: frozen.billing.periodStart ?? undefined,
    endDate: frozen.billing.periodEnd ?? undefined
  })
  const ids = [...new Set(localBilling.lines.flatMap((line) => line.sessionIds ?? []))]
  if (!ids.length) return
  const rows = tx.select().from(sessions).where(inArray(sessions.id, ids)).all()
  const byId = new Map(rows.map((row) => [row.id, row]))
  const remaining = new Map<number, Array<[number, number]>>()
  for (const part of unbilledSessions(tx, rows, testMode))
    remaining.set(part.id, [
      ...(remaining.get(part.id) ?? []),
      [Date.parse(part.startedAt), Date.parse(part.endedAt)]
    ])
  const billed: Array<{ row: (typeof rows)[number]; start: number; end: number }> = []
  for (const line of localBilling.lines) {
    const ranges: InvoiceBillingRange[] =
      line.billedRanges ??
      (line.sessionIds ?? []).flatMap((id) => {
        const row = byId.get(id)
        return row ? [billingRange(row)] : []
      })
    for (const id of line.sessionIds ?? [])
      if (!byId.has(id))
        throw new AppError(
          'BILLING_REFERENCE_UNAVAILABLE',
          'A billed session is no longer available. Refresh the invoice preview.'
        )
    for (const range of ranges) {
      const row = byId.get(range.sessionId)
      if (!row) continue
      const start = Math.max(Date.parse(range.startedAt), Date.parse(row.startedAt))
      const end = Math.min(Date.parse(range.endedAt), Date.parse(row.endedAt))
      if (!(end > start)) continue
      if (!isUnbilled([...(remaining.get(row.id) ?? [])], start, end))
        throw new AppError(
          'INVOICE_WORK_ALREADY_BILLED',
          'Some of this work is already on another invoice. Refresh the invoice preview.'
        )
      billed.push({ row, start, end })
    }
  }
  requireBilledIdentities(tx, billed, testMode)
}

/**
 * Billed activity may have only some split fragments mapped here, and the remaining work may sit
 * in another project. Unmapped automatic work overlapping
 * it in time therefore waits until the identity arrives, unless its known provider or
 * conversation proves it is other work. Time overlap alone never counts as the identity.
 */
function requireBilledIdentities<S extends Record<string, unknown>>(
  tx: Db<S>,
  billed: Array<{ row: typeof sessions.$inferSelect; start: number; end: number }>,
  testMode: boolean
): void {
  if (!billed.length) return
  const pending = activityBilledRanges(tx, testMode)
  if (!pending.length) return
  for (const { row, start, end } of billed) {
    if (row.source === 'manual') continue
    if (
      tx
        .select({ id: manualTimeEntries.id })
        .from(manualTimeEntries)
        .where(eq(manualTimeEntries.sessionId, row.id))
        .get()
    )
      continue
    const mapping = tx
      .select()
      .from(sessionActivityMappings)
      .where(eq(sessionActivityMappings.sessionId, row.id))
      .get()
    // A readable mapping is this row's identity; the anchor would have resolved to it if it matched.
    if (mapping && readCanonicalIntervalSnapshot(mapping.intervalJson, mapping.provider)) continue
    for (const range of pending) {
      if (range.anchor.kind !== 'activity') continue
      if (row.tool !== range.anchor.provider) continue
      if (row.claudeSessionId && row.claudeSessionId !== range.anchor.conversationId) continue
      if (Date.parse(range.startedAt) < end && start < Date.parse(range.endedAt))
        throw new AppError(
          'SYNC_BILLING_INCOMPLETE',
          'Some of this work may already be billed on another computer, but its shared history has not fully arrived. Finish syncing, then refresh the invoice preview.'
        )
    }
  }
}

function blocked(code: string, message: string): never {
  throw new AppError(code, message)
}

/**
 * Before finalizing and emailing (while no send attempt can have emailed yet), with the invoice
 * just retrieved by the send's own Stripe client: the saved and shared records of this invoice
 * must agree, the draft operation that created it must be complete and not cancelled, and a draft
 * must still hold the amounts ClauTime saved.
 */
export function checkBeforeSend<S extends Record<string, unknown>>(
  db: Db<S>,
  invoice: Stripe.Invoice,
  context: StripeContext
): void {
  const local = db.select().from(invoices).where(eq(invoices.stripeInvoiceId, invoice.id)).get()
  if (
    local &&
    (local.status === 'paid' || local.status === 'void') &&
    invoice.status !== local.status
  )
    blocked(
      'INVOICE_STATUS_CONFLICT',
      `Shared history records this invoice as ${local.status}, but Stripe reports ${invoice.status ?? 'unknown'}. Review it in Stripe before sending.`
    )

  const metadataOperation = invoice.metadata?.[OPERATION_METADATA] ?? null
  if (local?.operationId && metadataOperation && local.operationId !== metadataOperation)
    blocked(
      'PROVIDER_RESULT_CONFLICT',
      'This invoice is linked to a different draft operation in Stripe.'
    )
  const operationId = metadataOperation ?? local?.operationId ?? null
  const workspaceId = historySyncWorkspace(db)

  if (workspaceId) {
    const state = readInvoiceRecordState(db, workspaceId, invoiceSyncId(invoice.id))
    if (state?.issue || state?.observation.terminalConflict)
      blocked(
        'INVOICE_SYNC_BLOCKED',
        'Shared history for this invoice needs review (conflicting copies or statuses) before sending.'
      )
    const intents = [invoiceOperationId('send-invoice', context, invoice.id), operationId]
    for (const id of intents)
      if (id && readProviderIntentState(db, workspaceId, id)?.conflicts.length)
        blocked(
          'INVOICE_SYNC_BLOCKED',
          'Shared history has conflicting records of this invoice operation. Review them before sending.'
        )
  }

  let expected: { cents: number; lines: number } | null = null
  if (operationId) {
    const operation = db
      .select()
      .from(providerOperations)
      .where(eq(providerOperations.id, operationId))
      .get()
    if (!operation) {
      // Created by ClauTime elsewhere; its completeness is unknown until its records arrive.
      if (workspaceId)
        blocked(
          'SYNC_BILLING_INCOMPLETE',
          'This invoice was drafted on another computer and its records have not arrived yet. Sync, then send.'
        )
    } else {
      if (
        operation.kind !== 'create-invoice' ||
        operation.accountId !== context.accountId ||
        !!operation.testMode !== context.testMode
      )
        blocked(
          'PROVIDER_RESULT_CONFLICT',
          'This invoice does not match its saved draft operation.'
        )
      if (providerOperationResolution(db, operationId))
        blocked(
          'PROVIDER_RESULT_CONFLICT',
          'This invoice belongs to a draft that was cancelled. Review or delete it in Stripe.'
        )
      const results = new Map(
        db
          .select()
          .from(providerOperationResults)
          .where(eq(providerOperationResults.operationId, operationId))
          .all()
          .map((row) => [row.name, JSON.parse(row.resultJson) as Record<string, unknown>])
      )
      if (results.get('invoice')?.invoiceId !== invoice.id)
        blocked(
          'PROVIDER_RESULT_CONFLICT',
          'This invoice does not match its saved draft operation.'
        )
      const frozen = readFrozenInvoiceRequest(JSON.parse(operation.requestJson))
      if (frozen.lines.some((line) => !results.has(line.step)))
        blocked(
          'INVOICE_DRAFT_INCOMPLETE',
          'Some line items of this draft were never confirmed. Resume the unfinished draft before sending.'
        )
      expected = {
        cents: frozen.lines.reduce((sum, line) => sum + line.amountCents, 0),
        lines: frozen.lines.length
      }
    }
  }

  // Finalizing locks the draft: it must still hold what ClauTime saved (Stripe may round each
  // decimal line by at most a cent).
  if (invoice.status === 'draft') {
    const lines = local
      ? db
          .select({ amountCents: invoiceLineItems.amountCents })
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, local.id))
          .all()
      : []
    if (lines.length)
      expected = {
        cents: lines.reduce((sum, line) => sum + line.amountCents, 0),
        lines: lines.length
      }
    if (
      expected &&
      (typeof invoice.subtotal !== 'number' ||
        Math.abs(invoice.subtotal - expected.cents) > expected.lines)
    )
      blocked(
        'INVOICE_AMOUNT_CHANGED',
        'The Stripe draft no longer matches the saved invoice amounts. Review it in Stripe before sending.'
      )
  }
}
