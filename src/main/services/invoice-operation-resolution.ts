import type Stripe from 'stripe'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  providerOperations,
  providerOperationSteps,
  providerOperationResults,
  providerOperationRejections
} from '../db/schema/provider-operations'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import { sessionBillingRefs } from '../db/schema/session-history'
import { syncChanges } from '../db/schema/folder-sync'
import { invoiceSyncId, providerIntentHasConflict } from './folder-sync-invoice-records'
import { AppError } from '../../shared/types/ipc'
import type { JsonObject } from './folder-sync-protocol'
import {
  providerOperationResolution,
  recordProviderResolution,
  requireProviderAccount
} from './provider-operation-store'
import { readStripeContext } from './stripe-operation-service'

/*
 * Explicit resolution of an unfinished create-invoice operation (folder-sync-plan.md decision H).
 * Its frozen request can never change, so a draft Stripe definitely rejected can only be
 * cancelled, never amended. Cancelling releases the client for a new draft (a new operation ID and
 * keys), so it is allowed only with proof that the operation left no effect:
 *
 * - rejected-before-invoice: no invoice was created, every started step either completed (only a
 *   reusable customer) or was definitely rejected by Stripe, and at least one was rejected.
 * - draft-deleted: every started step is settled and Stripe, read with the operation's own
 *   account, no longer has the draft invoice nor any invoice item the operation created (the user
 *   deleted the draft in Stripe). A deleted draft can never be finalized, paid or emailed.
 *
 * Anything uncertain (a started step without a result or rejection: a lost response, a timeout
 * or an expired retry window) is never cancellable; elapsed time and this computer's clock are
 * never proof. Draft invoices never email the customer, so no email can hide behind either case.
 */

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>

export type CancellationBasis = 'rejected-before-invoice' | 'draft-deleted'

export interface CancellationProof {
  version: 1
  basis: CancellationBasis
  /** Steps Stripe definitely rejected (sorted names). */
  rejectedSteps: string[]
  /** The deleted draft (draft-deleted only). */
  invoiceId: string | null
  /** Invoice items verified deleted with it (sorted; draft-deleted only). */
  itemIds: string[]
  /** Stripe's Date of the verifying reads (draft-deleted only). */
  checkedProviderAt: string | null
}

export interface CreateOperationSettlement {
  /** Started steps without a result or a definite rejection: possibly effective. */
  uncertain: string[]
  rejected: string[]
  invoiceId: string | null
  itemIds: string[]
}

function notCancellable(message: string): never {
  throw new AppError('PROVIDER_OPERATION_NOT_CANCELLABLE', message)
}

/** What each started step of an operation proves. */
export function createOperationSettlement<S extends Record<string, unknown>>(
  db: Db<S>,
  operationId: string
): CreateOperationSettlement {
  const results = new Map(
    db
      .select()
      .from(providerOperationResults)
      .where(eq(providerOperationResults.operationId, operationId))
      .all()
      .map((row) => [row.name, JSON.parse(row.resultJson) as Record<string, unknown>])
  )
  const rejected = new Set(
    db
      .select({ name: providerOperationRejections.name })
      .from(providerOperationRejections)
      .where(eq(providerOperationRejections.operationId, operationId))
      .all()
      .map((row) => row.name)
  )
  const steps = db
    .select({ name: providerOperationSteps.name })
    .from(providerOperationSteps)
    .where(eq(providerOperationSteps.operationId, operationId))
    .all()
    .map((row) => row.name)
  const invoice = results.get('invoice')
  return {
    uncertain: steps.filter((name) => !results.has(name) && !rejected.has(name)).sort(),
    rejected: [...rejected].sort(),
    invoiceId: typeof invoice?.invoiceId === 'string' ? invoice.invoiceId : null,
    itemIds: [...results.entries()]
      .filter(([name]) => /^item-\d+$/.test(name))
      .map(([, result]) => String(result.invoiceItemId))
      .sort()
  }
}

function isMissing(error: unknown): boolean {
  const e = error as { code?: unknown; statusCode?: unknown } | null
  return !!e && e.code === 'resource_missing' && e.statusCode === 404
}

/** Positive proof that a Stripe object no longer exists; any other failure propagates. */
async function verifyDeleted(read: () => Promise<{ deleted?: boolean }>): Promise<boolean> {
  try {
    return (await read()).deleted === true
  } catch (error) {
    if (isMissing(error)) return true
    throw error
  }
}

/**
 * Cancel an unfinished create-invoice operation with proof that it left no effect. `stripe` is
 * needed only when a draft invoice was created (to verify it was deleted); it must hold the
 * operation's own account and mode. Reads only; never a provider write. `savedDraftId` is set
 * only by discardSavedDraft: that saved draft is then removed with the cancellation.
 */
export async function cancelInvoiceOperation<S extends Record<string, unknown>>(
  db: Db<S>,
  operationId: string,
  provider: { stripe: Stripe; expectedTestMode: boolean } | null,
  savedDraftId?: number
): Promise<CancellationProof> {
  const operation = db
    .select()
    .from(providerOperations)
    .where(eq(providerOperations.id, operationId))
    .get()
  if (!operation || operation.kind !== 'create-invoice')
    throw new AppError(
      'INVOICE_OPERATION_NOT_FOUND',
      'This saved invoice operation is unavailable.'
    )
  const savedId = () =>
    db.select({ id: invoices.id }).from(invoices).where(eq(invoices.operationId, operationId)).get()
      ?.id
  const existing = providerOperationResolution(db, operationId)
  // A concurrent discard of the same draft may have finished first.
  if (existing && (savedDraftId === undefined || savedId() === undefined))
    return JSON.parse(existing.proofJson) as CancellationProof
  if (savedDraftId !== undefined && savedId() === undefined)
    notCancellable('This draft is no longer saved here. Refresh the invoice list.')
  if (savedId() !== savedDraftId)
    notCancellable('This draft is already saved as an invoice. Void or review it instead.')
  const settlement = createOperationSettlement(db, operationId)
  if (settlement.uncertain.length)
    notCancellable(
      'Stripe may have completed part of this draft (its result is unknown). Resume it instead; ClauTime never replaces an uncertain invoice with a new one.'
    )
  let proof: CancellationProof
  if (!settlement.invoiceId) {
    if (!settlement.rejected.length)
      notCancellable('Stripe has not rejected this draft. Resume it to finish the invoice.')
    proof = {
      version: 1,
      basis: 'rejected-before-invoice',
      rejectedSteps: settlement.rejected,
      invoiceId: null,
      itemIds: [],
      checkedProviderAt: null
    }
  } else {
    if (!provider)
      throw new AppError(
        'STRIPE_NO_KEY',
        'Add the Stripe key for this invoice before cancelling it.'
      )
    const context = await readStripeContext(provider.stripe, provider.expectedTestMode)
    requireProviderAccount(context, {
      accountId: operation.accountId,
      testMode: !!operation.testMode
    })
    const invoiceId = settlement.invoiceId
    type Deletable = Promise<{ deleted?: boolean }>
    if (
      !(await verifyDeleted(
        () => provider.stripe.invoices.retrieve(invoiceId) as unknown as Deletable
      ))
    )
      notCancellable(
        `Stripe still has draft ${invoiceId} from this operation. Delete that draft in Stripe first, or resume it.`
      )
    for (const itemId of settlement.itemIds)
      if (
        !(await verifyDeleted(
          () => provider.stripe.invoiceItems.retrieve(itemId) as unknown as Deletable
        ))
      )
        notCancellable(
          `Stripe still has invoice item ${itemId} from this draft. Delete it in Stripe first.`
        )
    // The verifying reads' own server time; the account read is the fallback, never this clock.
    const checked = Date.parse(context.providerDate)
    if (!Number.isFinite(checked))
      throw new AppError(
        'PROVIDER_TIME_UNAVAILABLE',
        'Stripe did not provide a valid response time.'
      )
    proof = {
      version: 1,
      basis: 'draft-deleted',
      rejectedSteps: settlement.rejected,
      invoiceId,
      itemIds: settlement.itemIds,
      checkedProviderAt: new Date(checked).toISOString()
    }
  }
  // Re-read synchronously with the recording: a resume that ran during the Stripe reads may have
  // started or completed another step.
  const now = createOperationSettlement(db, operationId)
  const finished = providerOperationResolution(db, operationId)
  // A concurrent discard of the same draft committed during the Stripe reads.
  if (savedDraftId !== undefined && savedId() === undefined && finished)
    return JSON.parse(finished.proofJson) as CancellationProof
  if (
    now.uncertain.length ||
    now.invoiceId !== settlement.invoiceId ||
    now.itemIds.join() !== settlement.itemIds.join() ||
    savedId() !== savedDraftId
  )
    notCancellable('This draft changed while it was being checked. Review it and try again.')
  db.transaction((tx) => {
    if (savedDraftId !== undefined) {
      // Shared while Stripe was being checked: roll back so the shared header keeps its billed work.
      // (A Stripe draft already deleted by this discard stays deleted; it can never be paid.)
      if (isSharedInvoice(tx as unknown as Db<S>, settlement.invoiceId!))
        notCancellable('This draft is shared through folder sync and cannot be discarded here.')
      // The saved draft and its billed-work references go with it, so its time is billable again.
      tx.delete(sessionBillingRefs)
        .where(eq(sessionBillingRefs.stripeInvoiceId, settlement.invoiceId!))
        .run()
      tx.delete(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, savedDraftId)).run()
      tx.delete(invoices).where(eq(invoices.id, savedDraftId)).run()
    }
    recordProviderResolution(tx as unknown as Db<S>, operationId, proof as unknown as JsonObject)
  })
  return proof
}

/** Shared through folder sync: discarding it here would leave other computers a dead draft. */
function isSharedInvoice<S extends Record<string, unknown>>(db: Db<S>, invoiceId: string): boolean {
  return !!db
    .select({ id: syncChanges.id })
    .from(syncChanges)
    .where(
      and(eq(syncChanges.entityType, 'invoice'), eq(syncChanges.entityId, invoiceSyncId(invoiceId)))
    )
    .get()
}

/**
 * Why a saved invoice cannot be discarded, from local facts only (no Stripe call), or null when
 * discardSavedDraft may try. Callers that get a reason keep the old hide-only delete.
 */
export function draftDiscardRefusal<S extends Record<string, unknown>>(
  db: Db<S>,
  row: { status: string; operationId: string | null; stripeInvoiceId: string }
): string | null {
  if (row.status !== 'draft' || !row.operationId)
    return 'Only a draft created by ClauTime can be discarded. Void it instead.'
  if (isSharedInvoice(db, row.stripeInvoiceId))
    return 'This draft is shared through folder sync and cannot be discarded here.'
  if (providerIntentHasConflict(db, row.operationId))
    return 'This draft has a folder sync conflict. Review it in Settings first.'
  const settlement = createOperationSettlement(db, row.operationId)
  if (settlement.uncertain.length || settlement.invoiceId !== row.stripeInvoiceId)
    return 'Stripe may have completed part of this draft. Sync it and try again.'
  return null
}

/** Stripe's answer for an object that does not exist (a deleted draft reads this way). */
export const isStripeMissing = isMissing

/**
 * Discard a saved draft invoice ClauTime created, with the same draft-deleted proof as cancelling
 * an unfinished one. With `deleteInStripe` (an explicit user delete), a draft Stripe still has is
 * deleted first, with any of its items left unattached; a draft never emails the customer.
 * Without it, nothing is written to Stripe: Stripe must already show the draft and items deleted.
 * Refused for a finalized invoice or one shared through folder sync.
 */
export async function discardSavedDraft<S extends Record<string, unknown>>(
  db: Db<S>,
  localInvoiceId: number,
  provider: { stripe: Stripe; expectedTestMode: boolean } | null,
  deleteInStripe: boolean
): Promise<CancellationProof> {
  const row = db.select().from(invoices).where(eq(invoices.id, localInvoiceId)).get()
  if (!row) throw new AppError('INVOICE_NOT_FOUND', `Invoice ${localInvoiceId} not found`)
  const refusal = draftDiscardRefusal(db, row)
  if (refusal) notCancellable(refusal)
  if (!provider)
    throw new AppError('STRIPE_NO_KEY', 'Add the Stripe key for this invoice before deleting it.')
  const operationId = row.operationId!
  const invoiceId = row.stripeInvoiceId
  const operation = db
    .select()
    .from(providerOperations)
    .where(eq(providerOperations.id, operationId))
    .get()!
  requireProviderAccount(await readStripeContext(provider.stripe, provider.expectedTestMode), {
    accountId: operation.accountId,
    testMode: !!operation.testMode
  })
  if (deleteInStripe) {
    type Deletable = { deleted?: boolean; status?: string | null; invoice?: unknown }
    const read = async (get: () => Promise<unknown>): Promise<Deletable | null> => {
      try {
        const found = (await get()) as Deletable
        return found.deleted ? null : found
      } catch (error) {
        if (isMissing(error)) return null
        throw error
      }
    }
    const current = await read(() => provider.stripe.invoices.retrieve(invoiceId))
    if (current) {
      if (current.status !== 'draft')
        notCancellable(`Stripe shows this invoice as ${current.status}. Void it instead.`)
      try {
        await provider.stripe.invoices.del(invoiceId)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    // A leftover item would be swept into the customer's next invoice. Only an unattached one (or
    // one still on this draft) is this draft's own; an item on another invoice is never touched.
    for (const itemId of createOperationSettlement(db, operationId).itemIds) {
      const item = await read(() => provider.stripe.invoiceItems.retrieve(itemId))
      if (!item) continue
      const attached = typeof item.invoice === 'string' ? item.invoice : null
      if (attached && attached !== invoiceId)
        notCancellable(`Stripe moved item ${itemId} to invoice ${attached}. Review it in Stripe.`)
      try {
        await provider.stripe.invoiceItems.del(itemId)
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
  }
  return cancelInvoiceOperation(db, operationId, provider, localInvoiceId)
}
