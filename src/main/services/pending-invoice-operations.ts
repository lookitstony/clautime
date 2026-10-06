import { providerIntentHasConflict } from './folder-sync-invoice-records'
import { and, eq, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  providerOperations,
  providerOperationResults,
  providerOperationRejections,
  providerOperationResolutions
} from '../db/schema/provider-operations'
import { invoices } from '../db/schema/invoices'
import { AppError } from '../../shared/types/ipc'
import type { CreateInvoiceRequest, PendingInvoiceOperation } from '../../shared/types/invoice'
import type { FrozenInvoiceRequest } from './stripe-operation-service'
import type { ProviderAccount, ProviderRejectionProof } from './provider-operation-store'
import type { LocalInvoiceBilling } from './invoice-portable-billing'

/** Create operations with no saved invoice and no recorded cancellation. */
function unfinishedCreates<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  account?: ProviderAccount
) {
  return db
    .select({ operation: providerOperations, resolution: providerOperationResolutions.operationId })
    .from(providerOperations)
    .leftJoin(invoices, eq(invoices.operationId, providerOperations.id))
    .leftJoin(
      providerOperationResolutions,
      eq(providerOperationResolutions.operationId, providerOperations.id)
    )
    .where(
      and(
        eq(providerOperations.kind, 'create-invoice'),
        isNull(invoices.id),
        ...(account
          ? [
              eq(providerOperations.accountId, account.accountId),
              eq(providerOperations.testMode, Number(account.testMode))
            ]
          : [])
      )
    )
    .all()
    .filter(
      ({ operation, resolution }) => !resolution || providerIntentHasConflict(db, operation.id)
    )
    .map(({ operation }) => operation)
}

export function pendingInvoiceOperations<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>
): PendingInvoiceOperation[] {
  return unfinishedCreates(db).map((operation) => {
    // Listing only; resuming reads the request strictly.
    const frozen = JSON.parse(operation.requestJson) as Partial<FrozenInvoiceRequest>
    const result = db
      .select()
      .from(providerOperationResults)
      .where(
        and(
          eq(providerOperationResults.operationId, operation.id),
          eq(providerOperationResults.name, 'invoice')
        )
      )
      .get()
    const rejection = db
      .select()
      .from(providerOperationRejections)
      .where(eq(providerOperationRejections.operationId, operation.id))
      .get()
    return {
      operationId: operation.id,
      clientName: frozen.customer?.name ?? 'Saved client',
      accountId: operation.accountId,
      testMode: !!operation.testMode,
      periodStart: frozen.billing?.periodStart ?? null,
      periodEnd: frozen.billing?.periodEnd ?? null,
      amountCents: (frozen.lines ?? []).reduce((sum, line) => sum + line.amountCents, 0),
      providerInvoiceId: result
        ? (JSON.parse(result.resultJson) as { invoiceId: string }).invoiceId
        : null,
      state: providerIntentHasConflict(db, operation.id)
        ? 'conflict'
        : rejection
          ? 'rejected'
          : 'unfinished',
      rejectionMessage: rejection
        ? (JSON.parse(rejection.proofJson) as ProviderRejectionProof).message
        : null
    }
  })
}

/**
 * New UI IDs or a restarted computer cannot bypass an unfinished operation for this client. Only
 * a saved invoice or a proven cancellation (invoice-operation-resolution) finishes one.
 */
export function requireNoPendingInvoice<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  operationId: string,
  clientSyncId: string,
  account: ProviderAccount
): void {
  if (
    unfinishedCreates(db, account).some(
      (operation) =>
        operation.id !== operationId &&
        (JSON.parse(operation.requestJson) as FrozenInvoiceRequest).clientSyncId === clientSyncId
    )
  )
    throw new AppError(
      'INVOICE_OPERATION_PENDING',
      'This client has an unfinished invoice. Resume it (or cancel it if Stripe rejected it) from the invoice screen before starting another draft.'
    )
}

/**
 * Rebuild only from the immutable operation; refreshed forms cannot change an uncertain write.
 * Resume with createDraftInvoiceOperation(..., { resume: true }), which uses the retained
 * request (portable billing included) as saved; `local` only fills compatibility metadata.
 */
export function requestFromFrozenInvoice(
  operationId: string,
  clientId: number,
  frozen: FrozenInvoiceRequest,
  local?: LocalInvoiceBilling
): CreateInvoiceRequest {
  return {
    operationId,
    clientId,
    memo: frozen.description ?? undefined,
    daysUntilDue: frozen.daysUntilDue,
    achOnly: frozen.achOnly,
    periodStart: frozen.billing.periodStart ?? undefined,
    periodEnd: frozen.billing.periodEnd ?? undefined,
    lineItems: frozen.lines.map((line) => ({
      description: line.description,
      amountCents: line.amountCents,
      ...(line.quantityDecimal && line.unitAmountDecimal
        ? { hours: Number(line.quantityDecimal), rateCents: Number(line.unitAmountDecimal) }
        : {})
    })),
    lineMeta: frozen.billing.lines.map((line, i) => ({
      lineDate: line.lineDate ?? undefined,
      durationMinutes: line.durationMinutes ?? undefined,
      sessionIds: local?.lines[i]?.sessionIds ?? undefined,
      billedRanges: local?.lines[i]?.billedRanges ?? undefined
    }))
  }
}
