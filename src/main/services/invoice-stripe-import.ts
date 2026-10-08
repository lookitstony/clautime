import type Stripe from 'stripe'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { clients } from '../db/schema/clients'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import {
  providerOperations,
  providerOperationResults,
  providerOperationSteps
} from '../db/schema/provider-operations'
import { AppError } from '../../shared/types/ipc'
import {
  INVOICE_STATUSES,
  type InvoiceBillingRange,
  type InvoiceStatus
} from '../../shared/types/invoice'
import { retainInvoiceBillingRefs } from './session-billing'
import {
  providerIntentHasConflict,
  journalInvoiceRecordsSafely,
  recordProviderObservation
} from './folder-sync-invoice-records'
import {
  bindRetrievedInvoiceAccount,
  checkClientProviderAccount,
  checkSavedInvoiceAccount,
  retainCustomerReference,
  scopedCustomerReference
} from './invoice-provider-scope'
import {
  mapInvoiceStatus,
  OPERATION_METADATA,
  readFrozenInvoiceRequest,
  responseDate,
  type FrozenInvoiceRequest,
  type StripeContext
} from './stripe-operation-service'
import { providerOperationResolution, type ProviderAccount } from './provider-operation-store'
import { resolvePortableBilling } from './invoice-portable-billing'
import { getPortableClientId } from './folder-sync-builtin-client'
import { historySyncWorkspace } from './folder-sync-history-records'

/*
 * Reading Stripe invoices into local history (folder-sync-plan.md decision H). Reads only: no
 * Stripe write, customer creation or AI call happens here. Every read uses one captured client
 * whose account and mode were verified first; a list is complete or it fails, never "enough".
 */

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>
type AnyDb = BetterSQLite3Database<Record<string, unknown>>

/** Pages of 100: far beyond one client's invoices; running out is a failure, never "done". */
const MAX_PAGES = 100

export interface LocalInvoiceInput {
  clientId: number
  stripeInvoiceId: string
  status: string
  amountDueCents: number
  amountPaidCents: number
  currency: string
  memo?: string | null
  hostedUrl?: string | null
  invoicePdf?: string | null
  dueDate?: string | null
  paidAt?: string | null
  periodStart?: string | null
  periodEnd?: string | null
  testMode?: boolean
  providerAccountId?: string
  operationId?: string
  lineItems: Array<{
    lineDate?: string | null
    description: string
    amountCents: number
    durationMinutes?: number | null
    sessionIds?: number[] | null
    billedRanges?: InvoiceBillingRange[]
    sortOrder: number
  }>
}

/**
 * Save an invoice, its line snapshots and frozen billed-work references in one transaction (a
 * savepoint inside the caller's), journaling the outgoing sync records with it.
 */
export function saveLocalInvoice<S extends Record<string, unknown>>(
  db: Db<S>,
  data: LocalInvoiceInput
): number {
  const now = new Date().toISOString()
  let invoiceId = 0
  db.transaction((tx) => {
    const invoice = tx
      .insert(invoices)
      .values({
        clientId: data.clientId,
        stripeInvoiceId: data.stripeInvoiceId,
        providerAccountId: data.providerAccountId ?? null,
        operationId: data.operationId ?? null,
        status: data.status as InvoiceStatus['status'],
        amountDueCents: data.amountDueCents,
        amountPaidCents: data.amountPaidCents,
        currency: data.currency,
        memo: data.memo ?? null,
        hostedUrl: data.hostedUrl ?? null,
        invoicePdf: data.invoicePdf ?? null,
        dueDate: data.dueDate ?? null,
        paidAt: data.paidAt ?? null,
        periodStart: data.periodStart ?? null,
        periodEnd: data.periodEnd ?? null,
        testMode: data.testMode ? 1 : 0,
        createdAt: now,
        updatedAt: now
      })
      .returning()
      .get()
    invoiceId = invoice.id
    for (const item of data.lineItems) {
      tx.insert(invoiceLineItems)
        .values({
          invoiceId: invoice.id,
          lineDate: item.lineDate ?? null,
          description: item.description,
          amountCents: item.amountCents,
          durationMinutes: item.durationMinutes ?? null,
          sessionIds: item.sessionIds ? item.sessionIds.join(',') : null,
          sortOrder: item.sortOrder,
          createdAt: now
        })
        .run()
    }
    const ranges = new Map<number, InvoiceBillingRange[]>()
    for (const item of data.lineItems) {
      if (!item.billedRanges) continue
      for (const id of item.sessionIds ?? []) {
        ranges.set(id, [
          ...(ranges.get(id) ?? []),
          ...item.billedRanges.filter((range) => range.sessionId === id)
        ])
      }
    }
    retainInvoiceBillingRefs(tx, {
      stripeInvoiceId: data.stripeInvoiceId,
      ranges,
      testMode: !!data.testMode
    })
    // Outgoing sync records commit with the invoice (no-op without a workspace).
    journalInvoiceRecordsSafely(tx as unknown as AnyDb, invoice.id)
  })
  return invoiceId
}

/** A Stripe invoice in saveLocalInvoice's shape: Stripe's issued lines and status. */
export function mapStripeInvoiceToLocal(
  inv: Stripe.Invoice,
  clientId: number,
  isTest: boolean
): LocalInvoiceInput {
  const status = INVOICE_STATUSES.has(inv.status as InvoiceStatus['status'])
    ? (inv.status as InvoiceStatus['status'])
    : 'draft'
  const lineItems = (inv.lines?.data ?? []).map((line, i) => ({
    description: line.description ?? 'Line item',
    amountCents: line.amount,
    sortOrder: i
  }))
  // Derive period from line item date ranges
  let periodStart: string | null = null
  let periodEnd: string | null = null
  if (inv.lines?.data?.length) {
    const starts = inv.lines.data.map((l) => l.period?.start).filter((s): s is number => !!s)
    const ends = inv.lines.data.map((l) => l.period?.end).filter((e): e is number => !!e)
    if (starts.length > 0)
      periodStart = new Date(Math.min(...starts) * 1000).toISOString().split('T')[0]
    if (ends.length > 0) periodEnd = new Date(Math.max(...ends) * 1000).toISOString().split('T')[0]
  }
  return {
    clientId,
    stripeInvoiceId: inv.id,
    status,
    amountDueCents: inv.amount_due,
    amountPaidCents: inv.amount_paid,
    currency: inv.currency,
    memo: inv.description ?? null,
    hostedUrl: inv.hosted_invoice_url ?? null,
    invoicePdf: inv.invoice_pdf ?? null,
    dueDate: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null,
    paidAt: inv.status_transitions?.paid_at
      ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
      : null,
    periodStart,
    periodEnd,
    testMode: isTest,
    lineItems
  }
}

/** All line items of a listed invoice; an unfinished pagination is a failure. */
export async function completeInvoiceLines(stripe: Stripe, invoice: Stripe.Invoice): Promise<void> {
  if (!invoice.lines?.has_more) return
  const lines: Stripe.InvoiceLineItem[] = []
  let after: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await stripe.invoices.listLineItems(invoice.id, {
      limit: 100,
      ...(after ? { starting_after: after } : {})
    })
    lines.push(...batch.data)
    if (!batch.has_more) {
      invoice.lines = { ...batch, data: lines }
      return
    }
    after = batch.data.at(-1)?.id
    if (!after) break
  }
  throw new AppError(
    'INVOICE_LINES_INCOMPLETE',
    'The invoice has more lines than could be safely imported.'
  )
}

// ── Operation lineage ──

export type InvoiceLineage =
  | { kind: 'none' }
  /** Created by ClauTime under an operation this computer has not received. */
  | { kind: 'unknown'; operationId: string }
  /** The invoice of a retained operation: its frozen billed work is known here. */
  | { kind: 'known'; operationId: string; frozen: FrozenInvoiceRequest }
  /** Created under a cancelled operation: the cancellation's proof did not hold. */
  | { kind: 'cancelled'; operationId: string }
  /** Another account/mode or another invoice than the operation's own result. */
  | { kind: 'conflict'; operationId: string }

/** Which retained create operation (if any) produced this Stripe invoice. */
export function invoiceLineage<S extends Record<string, unknown>>(
  db: Db<S>,
  invoice: Pick<Stripe.Invoice, 'id' | 'metadata'>,
  account: ProviderAccount
): InvoiceLineage {
  const operationId = invoice.metadata?.[OPERATION_METADATA]
  if (!operationId) return { kind: 'none' }
  const operation = db
    .select()
    .from(providerOperations)
    .where(eq(providerOperations.id, operationId))
    .get()
  if (!operation) return { kind: 'unknown', operationId }
  if (
    operation.kind !== 'create-invoice' ||
    operation.accountId !== account.accountId ||
    !!operation.testMode !== account.testMode
  )
    return { kind: 'conflict', operationId }
  if (providerIntentHasConflict(db, operationId)) return { kind: 'conflict', operationId }
  if (providerOperationResolution(db, operationId)) return { kind: 'cancelled', operationId }
  const result = db
    .select()
    .from(providerOperationResults)
    .where(
      and(
        eq(providerOperationResults.operationId, operationId),
        eq(providerOperationResults.name, 'invoice')
      )
    )
    .get()
  // Without a result here the step is unfinished on this computer; the invoice carrying its
  // metadata is still that operation's invoice (what recovery would find).
  if (result && (JSON.parse(result.resultJson) as { invoiceId?: string }).invoiceId !== invoice.id)
    return { kind: 'conflict', operationId }
  try {
    return {
      kind: 'known',
      operationId,
      frozen: readFrozenInvoiceRequest(JSON.parse(operation.requestJson))
    }
  } catch {
    return { kind: 'conflict', operationId }
  }
}

/**
 * Attach a known operation's lineage to a saved invoice: its operation ID (when no other row has
 * it) and its frozen billed work, resolved on this computer. Union only; never unbills anything.
 */
export function attachInvoiceLineage<S extends Record<string, unknown>>(
  tx: Db<S>,
  localInvoiceId: number,
  lineage: Extract<InvoiceLineage, { kind: 'known' }>
): void {
  const row = tx.select().from(invoices).where(eq(invoices.id, localInvoiceId)).get()
  if (!row) return
  if (
    !row.operationId &&
    !tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.operationId, lineage.operationId))
      .get()
  )
    tx.update(invoices)
      .set({ operationId: lineage.operationId })
      .where(eq(invoices.id, row.id))
      .run()
  const ranges = new Map<number, InvoiceBillingRange[]>()
  for (const line of resolvePortableBilling(tx as unknown as AnyDb, lineage.frozen.billing).lines)
    for (const range of line.billedRanges ?? [])
      if (range.sessionId > 0)
        ranges.set(range.sessionId, [...(ranges.get(range.sessionId) ?? []), range])
  retainInvoiceBillingRefs(tx as unknown as AnyDb, {
    stripeInvoiceId: row.stripeInvoiceId,
    ranges,
    testMode: !!row.testMode
  })
  journalInvoiceRecordsSafely(tx as unknown as AnyDb, row.id)
}

/**
 * Save one listed Stripe invoice for `clientId` (or refresh the saved copy): a monotonic,
 * account-checked observation and, for an invoice a retained operation created, its billed work.
 * Returns whether a new local invoice was saved and the invoice's lineage.
 */
export function importStripeInvoice<S extends Record<string, unknown>>(
  db: Db<S>,
  invoice: Stripe.Invoice,
  clientId: number,
  account: ProviderAccount,
  providerDate: string | null
): { saved: boolean; lineage: InvoiceLineage } {
  if (invoice.livemode !== !account.testMode)
    throw new AppError('STRIPE_ACCOUNT_MISMATCH', 'Stripe returned an invoice from another mode.')
  checkSavedInvoiceAccount(db, invoice.id, account)
  const existing = db.select().from(invoices).where(eq(invoices.stripeInvoiceId, invoice.id)).get()
  let lineage = invoiceLineage(db, invoice, account)
  if (
    lineage.kind !== 'none' &&
    existing?.operationId &&
    existing.operationId !== lineage.operationId
  )
    lineage = { kind: 'conflict', operationId: lineage.operationId }
  db.transaction((tx) => {
    let localId = existing?.id
    if (!existing) {
      // The shared header is immutable once exported, so it carries the lineage from the start.
      const operationId =
        lineage.kind === 'known' &&
        !tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(eq(invoices.operationId, lineage.operationId))
          .get()
          ? lineage.operationId
          : undefined
      localId = saveLocalInvoice(tx, {
        ...mapStripeInvoiceToLocal(invoice, clientId, account.testMode),
        providerAccountId: account.accountId,
        operationId
      })
    }
    // A successful list by the captured account verifies a legacy row's account.
    else bindRetrievedInvoiceAccount(tx, invoice.id, account)
    if (lineage.kind === 'known') attachInvoiceLineage(tx, localId!, lineage)
  })
  recordProviderObservation(db, {
    providerInvoiceId: invoice.id,
    account,
    providerDate,
    status: mapInvoiceStatus(invoice)
  })
  return { saved: !existing, lineage }
}

// ── Before a new draft ──

function isMissing(error: unknown): boolean {
  const e = error as { code?: unknown; statusCode?: unknown } | null
  return !!e && e.code === 'resource_missing' && e.statusCode === 404
}

/** A legacy (account-less) customer reference retrieved with the captured client, or null. */
async function verifiedLegacyCustomer(
  stripe: Stripe,
  customerId: string,
  account: ProviderAccount
): Promise<boolean> {
  try {
    const customer = await stripe.customers.retrieve(customerId)
    return !customer.deleted && customer.livemode === !account.testMode
  } catch (error) {
    // Not in this account (or deleted): it may belong to another account; never bound here.
    if (isMissing(error)) return false
    throw error
  }
}

/** Customers retained operations for this client used in this account and mode. */
function operationCustomers<S extends Record<string, unknown>>(
  db: Db<S>,
  clientSyncId: string,
  account: ProviderAccount
): string[] {
  const found = new Set<string>()
  for (const operation of db
    .select()
    .from(providerOperations)
    .where(
      and(
        eq(providerOperations.accountId, account.accountId),
        eq(providerOperations.testMode, Number(account.testMode))
      )
    )
    .all()) {
    const request = JSON.parse(operation.requestJson) as { clientSyncId?: unknown }
    if (request.clientSyncId !== clientSyncId) continue
    const customer = db
      .select()
      .from(providerOperationResults)
      .where(
        and(
          eq(providerOperationResults.operationId, operation.id),
          eq(providerOperationResults.name, 'customer')
        )
      )
      .get()
    if (customer)
      found.add(String((JSON.parse(customer.resultJson) as { customerId?: unknown }).customerId))
    const invoiceStep = db
      .select()
      .from(providerOperationSteps)
      .where(
        and(
          eq(providerOperationSteps.operationId, operation.id),
          eq(providerOperationSteps.name, 'invoice')
        )
      )
      .get()
    if (invoiceStep)
      found.add(String((JSON.parse(invoiceStep.requestJson) as { customer?: unknown }).customer))
  }
  return [...found].filter((id) => /^cus_[A-Za-z0-9]+$/.test(id))
}

async function listCustomerInvoices(
  stripe: Stripe,
  customer: string,
  context: StripeContext
): Promise<Array<{ invoice: Stripe.Invoice; providerDate: string | null }>> {
  const listed: Array<{ invoice: Stripe.Invoice; providerDate: string | null }> = []
  let after: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await stripe.invoices.list({
      customer,
      limit: 100,
      expand: ['data.lines'],
      ...(after ? { starting_after: after } : {})
    })
    const providerDate = responseDate(result) ?? (context.providerDate || null)
    for (const invoice of result.data) {
      await completeInvoiceLines(stripe, invoice)
      listed.push({ invoice, providerDate })
    }
    if (!result.has_more) return listed
    after = result.data.at(-1)?.id
    if (!after) break
  }
  throw new AppError(
    'INVOICE_REFRESH_INCOMPLETE',
    'Stripe returned more invoices for this client than could be checked. Review them in Stripe.'
  )
}

/**
 * Refresh one client's Stripe invoices with the captured client and account before a NEW draft,
 * so billed work Stripe already holds is known when the preflight checks exclusions:
 * - customers: the reference verified for this account, a legacy reference only after it is
 *   retrieved with this key (bound only when no verified reference exists), and those retained
 *   operations for this client used in this account (possibly imported from another computer);
 * - every invoice of those customers, paginated to the end: saved copies get monotonic
 *   observations (a wrong account or mode fails before anything changes), unsaved ones are saved
 *   with the lineage and frozen billed work of the operation that created them.
 * Blocks when Stripe holds an invoice from a cancelled or conflicting operation, or a ClauTime
 * invoice in a shared workspace whose billed work has not arrived (it is saved to history first,
 * so it stays browseable; every attempt waits until its billed-work records arrive).
 */
export async function refreshClientStripeInvoices<S extends Record<string, unknown>>(
  db: Db<S>,
  stripe: Stripe,
  context: StripeContext,
  clientId: number
): Promise<void> {
  const account: ProviderAccount = { accountId: context.accountId, testMode: context.testMode }
  checkClientProviderAccount(db, clientId, account)
  const client = db.select().from(clients).where(eq(clients.id, clientId)).get()
  const clientSyncId = getPortableClientId(db, clientId)
  if (!client || !clientSyncId)
    throw new AppError('CLIENT_NOT_FOUND', `Client ${clientId} not found`)
  const customers = new Set<string>()
  const scoped = scopedCustomerReference(db, clientId, account)
  if (scoped) customers.add(scoped)
  if (client.stripeCustomerId && client.stripeCustomerId !== scoped) {
    if (await verifiedLegacyCustomer(stripe, client.stripeCustomerId, account)) {
      customers.add(client.stripeCustomerId)
      if (!scoped) retainCustomerReference(db, clientId, account, client.stripeCustomerId)
    }
  }
  for (const customer of operationCustomers(db, clientSyncId, account)) customers.add(customer)

  const problems: string[] = []
  for (const customer of [...customers].sort()) {
    for (const { invoice, providerDate } of await listCustomerInvoices(stripe, customer, context)) {
      const { lineage } = importStripeInvoice(db, invoice, clientId, account, providerDate)
      if (lineage.kind === 'conflict')
        problems.push(`${invoice.id} does not match the saved draft operation that created it`)
      else if (lineage.kind === 'cancelled' && invoice.status !== 'void')
        problems.push(
          `${invoice.id} belongs to a draft that was cancelled; delete or void it in Stripe`
        )
      else if (lineage.kind === 'unknown' && historySyncWorkspace(db))
        problems.push(
          `${invoice.id} was created on another computer and its billed work has not arrived; it was added to invoice history`
        )
    }
  }
  if (problems.length)
    throw new AppError(
      'INVOICE_REFRESH_REVIEW',
      `Review this client's Stripe invoices before creating another: ${problems.join('; ')}.`
    )
}
