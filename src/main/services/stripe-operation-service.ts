import { providerIntentHasConflict } from './folder-sync-invoice-records'
import type Stripe from 'stripe'
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { providerOperations, providerOperationSteps } from '../db/schema/provider-operations'
import { AppError } from '../../shared/types/ipc'
import {
  INVOICE_STATUSES,
  type CreateInvoiceRequest,
  type DraftInvoice,
  type InvoiceBillingRange,
  type InvoiceStatus
} from '../../shared/types/invoice'
import {
  executeProviderStep,
  providerAttemptName,
  providerOperationResolution,
  requireProviderAccount,
  retainProviderOperation,
  type ProviderAccount,
  type ProviderOperation
} from './provider-operation-store'
import { isSyncUuid, type JsonObject, type JsonValue } from './folder-sync-protocol'
import {
  checkSavedInvoiceAccount,
  bindRetrievedInvoiceAccount,
  scopedCustomerReference,
  retainCustomerReference,
  checkClientProviderAccount
} from './invoice-provider-scope'
import { requireNoPendingInvoice } from './pending-invoice-operations'
import {
  portableBillingFromLocal,
  readPortableInvoiceBilling,
  resolvePortableBilling,
  type LocalInvoiceBilling,
  type PortableInvoiceBilling
} from './invoice-portable-billing'

/**
 * Explicit Stripe writes. Every write is a frozen step of a retained operation, executed
 * with the one Stripe client captured for that user action. Sync imports never call this.
 */

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>

export interface StripeContext extends ProviderAccount {
  /** Stripe's response Date header; used only for the idempotency retry window. */
  providerDate: string
}

/** Stripe metadata naming the operation that created an object (its lineage). */
export const OPERATION_METADATA = 'clautime_operation_id'
const STEP_METADATA = 'clautime_step'
const CLIENT_METADATA = 'clautime_client_sync_id'
/** Bounded positive lookup. Running out of pages is "not found", never proof of absence. */
const MAX_RECOVERY_PAGES = 20

/** Account from the key, mode and server Date from a second read with the same client. */
export async function readStripeContext(
  stripe: Stripe,
  expectedTestMode: boolean
): Promise<StripeContext> {
  const account = await stripe.accounts.retrieve()
  const balance = await stripe.balance.retrieve()
  if (typeof balance.livemode !== 'boolean')
    throw new AppError('STRIPE_MODE_UNKNOWN', 'Stripe did not report whether this key is live.')
  const testMode = !balance.livemode
  if (testMode !== expectedTestMode)
    throw new AppError(
      'STRIPE_MODE_MISMATCH',
      `The saved Stripe key is a ${testMode ? 'test' : 'live'} key, but ClauTime is in ${expectedTestMode ? 'test' : 'live'} mode.`
    )
  const headers = balance.lastResponse?.headers ?? {}
  const date = headers.date ?? headers.Date
  // Return only the fields this app needs, never the SDK object or its response headers.
  return {
    accountId: String(account.id),
    testMode,
    providerDate: typeof date === 'string' ? date : ''
  }
}

/** Send/void have one operation per invoice and account, so any retry reuses its keys. */
export function invoiceOperationId(
  kind: 'send-invoice' | 'void-invoice',
  account: ProviderAccount,
  invoiceId: string
): string {
  const mode = account.testMode ? 'test' : 'live'
  const hash = createHash('sha256')
    .update(`clautime:${kind}:${account.accountId}:${mode}:${invoiceId}`)
    .digest('hex')
  const variant = ['8', '9', 'a', 'b'][parseInt(hash[16], 16) & 3]
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

function validateInvoiceId(invoiceId: string): void {
  if (typeof invoiceId !== 'string' || !/^in_[a-zA-Z0-9]+$/.test(invoiceId))
    throw new AppError('INVALID_INVOICE_ID', 'Invalid Stripe invoice ID format')
}

/** Plain JSON only: `undefined`, NaN, and class instances would not round-trip exactly. */
function toJson(value: unknown, path = 'request'): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new AppError('INVALID_PROVIDER_OPERATION', `${path} is not a finite number`)
    return value
  }
  if (Array.isArray(value)) return value.map((item, i) => toJson(item, `${path}[${i}]`))
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: JsonObject = {}
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = toJson(item, `${path}.${key}`)
    }
    return out
  }
  throw new AppError('INVALID_PROVIDER_OPERATION', `${path} is not plain data`)
}

function toJsonObject(value: object): JsonObject {
  return toJson(value) as JsonObject
}

function isResourceMissing(error: unknown): boolean {
  const e = error as { code?: unknown; statusCode?: unknown } | null
  return !!e && e.code === 'resource_missing' && e.statusCode === 404
}

function requireMode(object: { livemode: boolean }, account: ProviderAccount, label: string): void {
  if (object.livemode !== !account.testMode)
    throw new AppError(
      'STRIPE_ACCOUNT_MISMATCH',
      `This ${label} belongs to Stripe ${object.livemode ? 'live' : 'test'} mode, not the saved operation's mode.`
    )
}

async function findOne<T extends { id: string }>(
  page: (startingAfter?: string) => Promise<{ data: T[]; has_more: boolean }>,
  match: (item: T) => boolean
): Promise<T | null> {
  const found: T[] = []
  let startingAfter: string | undefined
  for (let i = 0; i < MAX_RECOVERY_PAGES; i++) {
    const result = await page(startingAfter)
    found.push(...result.data.filter(match))
    if (!result.has_more || result.data.length === 0) break
    startingAfter = result.data[result.data.length - 1].id
  }
  if (found.length > 1)
    throw new AppError(
      'PROVIDER_RESULT_CONFLICT',
      'Stripe has more than one object for this operation. Review them in Stripe before retrying.'
    )
  return found[0] ?? null
}

function frozenStep<S extends Record<string, unknown>>(
  db: Db<S>,
  operationId: string,
  name: string
): JsonObject | null {
  const row = db
    .select()
    .from(providerOperationSteps)
    .where(
      and(
        eq(providerOperationSteps.operationId, operationId),
        eq(providerOperationSteps.name, name)
      )
    )
    .get()
  return row ? (JSON.parse(row.requestJson) as JsonObject) : null
}

/** Verify a retained operation's account before any recovery or write uses this client. */
function retainOperation<S extends Record<string, unknown>>(
  db: Db<S>,
  context: StripeContext,
  operation: Omit<ProviderOperation, 'accountId' | 'testMode'>
): void {
  const saved = db
    .select()
    .from(providerOperations)
    .where(eq(providerOperations.id, operation.id))
    .get()
  if (saved)
    requireProviderAccount(context, { accountId: saved.accountId, testMode: !!saved.testMode })
  retainProviderOperation(db, {
    ...operation,
    accountId: context.accountId,
    testMode: context.testMode
  })
}

// ── Draft invoice creation ──

export type FrozenInvoiceLine = {
  step: string
  description: string
  /** Local amount; Stripe computes the same total from the decimal fields when present. */
  amountCents: number
  quantityDecimal: string | null
  unitAmountDecimal: string | null
}

export type FrozenInvoiceRequest = {
  version: 2
  clientSyncId: string
  customer: { email: string; name: string }
  daysUntilDue: number
  achOnly: boolean
  description: string | null
  currency: 'usd'
  lines: FrozenInvoiceLine[]
  /**
   * Portable billed-work scope: stable identities only, identical on every computer. The local
   * row numbers live in a separate receipt (CreatedDraft.localBilling / resolvePortableBilling).
   */
  billing: PortableInvoiceBilling
}

const FROZEN_KEYS = [
  'version',
  'clientSyncId',
  'customer',
  'daysUntilDue',
  'achOnly',
  'description',
  'currency',
  'lines',
  'billing'
]
const FROZEN_LINE_KEYS = [
  'step',
  'description',
  'amountCents',
  'quantityDecimal',
  'unitAmountDecimal'
]
/**
 * What Stripe accepts for quantity_decimal/unit_amount_decimal: plain decimals with at most 12
 * places, never exponent notation. A frozen value Stripe would refuse strands the operation, so
 * it is refused here before anything is retained.
 */
export const STRIPE_DECIMAL = /^(?=.{1,40}$)\d+(\.\d{1,12})?$/
/** Stripe's largest USD amount (999,999.99). */
export const MAX_AMOUNT_CENTS = 99_999_999

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AppError('INVALID_PROVIDER_OPERATION', `${label} must be an object`)
  const actual = Object.keys(value)
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key)))
    throw new AppError('INVALID_PROVIDER_OPERATION', `${label} has missing or unsupported fields`)
  return value as Record<string, unknown>
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && value.isWellFormed()
}

/** Strict allowlist of a retained or imported create-invoice request. */
export function readFrozenInvoiceRequest(value: unknown): FrozenInvoiceRequest {
  const frozen = exactObject(value, FROZEN_KEYS, 'Frozen invoice request')
  const invalid = (message: string): never => {
    throw new AppError('INVALID_PROVIDER_OPERATION', message)
  }
  if (frozen.version !== 2) invalid('Unsupported frozen invoice request version')
  if (!isSyncUuid(frozen.clientSyncId)) invalid('Frozen invoice request needs a client syncId')
  const customer = exactObject(frozen.customer, ['email', 'name'], 'Frozen customer')
  if (!boundedText(customer.email, 320) || !boundedText(customer.name, 500) || !customer.name)
    invalid('Frozen customer is invalid')
  if (
    typeof frozen.daysUntilDue !== 'number' ||
    !Number.isSafeInteger(frozen.daysUntilDue) ||
    frozen.daysUntilDue < 0 ||
    frozen.daysUntilDue > 3650
  )
    invalid('Frozen due days are invalid')
  if (typeof frozen.achOnly !== 'boolean') invalid('Frozen ACH flag is invalid')
  if (frozen.description !== null && !boundedText(frozen.description, 500))
    invalid('Frozen description is invalid')
  if (frozen.currency !== 'usd') invalid('Frozen currency is unsupported')
  if (!Array.isArray(frozen.lines) || !frozen.lines.length || frozen.lines.length > 250)
    invalid('Frozen lines are invalid')
  const lines = frozen.lines as unknown[]
  lines.forEach((value, i) => {
    const line = exactObject(value, FROZEN_LINE_KEYS, `Frozen line ${i + 1}`)
    const decimal = line.quantityDecimal !== null || line.unitAmountDecimal !== null
    if (
      line.step !== `item-${i}` ||
      !boundedText(line.description, 500) ||
      !line.description ||
      typeof line.amountCents !== 'number' ||
      !Number.isSafeInteger(line.amountCents) ||
      line.amountCents <= 0 ||
      line.amountCents > MAX_AMOUNT_CENTS ||
      (decimal &&
        !(
          typeof line.quantityDecimal === 'string' &&
          STRIPE_DECIMAL.test(line.quantityDecimal) &&
          typeof line.unitAmountDecimal === 'string' &&
          STRIPE_DECIMAL.test(line.unitAmountDecimal)
        ))
    )
      invalid(`Frozen line ${i + 1} is invalid`)
  })
  const total = (frozen.lines as FrozenInvoiceLine[]).reduce(
    (sum, line) => sum + line.amountCents,
    0
  )
  if (total > MAX_AMOUNT_CENTS) invalid('Frozen invoice total exceeds what Stripe accepts')
  let billing: PortableInvoiceBilling
  try {
    billing = readPortableInvoiceBilling(frozen.billing)
  } catch (error) {
    throw new AppError(
      'INVALID_PROVIDER_OPERATION',
      error instanceof Error ? error.message : 'Frozen billing is invalid'
    )
  }
  if (billing.lines.length !== lines.length) invalid('Frozen billing must describe every line')
  return frozen as unknown as FrozenInvoiceRequest
}

/** This computer's receipt from the renderer draft; never part of the frozen request. */
export function localBillingFromRequest(request: CreateInvoiceRequest): LocalInvoiceBilling {
  return {
    periodStart: request.periodStart ?? null,
    periodEnd: request.periodEnd ?? null,
    lines: request.lineItems.map((_, i) => {
      const meta = request.lineMeta?.[i]
      return {
        lineDate: meta?.lineDate ?? null,
        durationMinutes: meta?.durationMinutes ?? null,
        sessionIds: meta?.sessionIds ?? null,
        billedRanges: meta?.billedRanges?.map((r) => ({ ...r })) ?? null
      }
    })
  }
}

export interface InvoiceClient {
  /** Local lookup only; excluded from the frozen portable request. */
  localId?: number
  syncId: string
  name: string
  /** Email sent to Stripe (the test-mode override is already applied). */
  email: string
  /** Legacy reference without a recorded account. Verified before reuse. */
  stripeCustomerId: string | null
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/** A plain decimal Stripe accepts (at most 12 places, no exponent), or null when it rounds to 0. */
function stripeDecimal(value: number): string | null {
  if (value >= 1e15) return null
  const text = value.toFixed(12).replace(/\.?0+$/, '')
  return STRIPE_DECIMAL.test(text) && Number(text) > 0 ? text : null
}

/**
 * Validate and freeze the renderer draft. A retry must produce the identical request. `billing`
 * is the portable scope (portableBillingFromLocal or a resumed operation's saved billing).
 */
export function freezeInvoiceRequest(
  request: CreateInvoiceRequest,
  client: InvoiceClient,
  billing: PortableInvoiceBilling
): FrozenInvoiceRequest {
  if (!Array.isArray(request.lineItems) || request.lineItems.length === 0)
    throw new AppError('INVOICE_NO_ITEMS', 'At least one line item is required')
  if (request.lineItems.length > 250)
    throw new AppError('INVOICE_TOO_MANY_ITEMS', 'Stripe invoices allow at most 250 line items')
  if (!isSyncUuid(client.syncId))
    throw new AppError('CLIENT_SYNC_ID_REQUIRED', 'The client has no portable identity')
  const daysUntilDue = request.daysUntilDue ?? 30
  if (!Number.isSafeInteger(daysUntilDue) || daysUntilDue < 0 || daysUntilDue > 3650)
    throw new AppError('INVALID_DUE_DAYS', 'Days until due must be a whole number of days')
  const lines = request.lineItems.map((item, i): FrozenInvoiceLine => {
    const description = typeof item.description === 'string' ? item.description.trim() : ''
    if (!description) throw new AppError('INVALID_LINE_ITEM', `Line ${i + 1} needs a description`)
    if (description.length > 500)
      throw new AppError(
        'INVALID_LINE_ITEM',
        `Line ${i + 1} description is longer than Stripe allows`
      )
    // The exact decimals Stripe receives also compute the local amount, so both agree.
    const quantity = positiveNumber(item.hours) ? stripeDecimal(item.hours) : null
    const unit = positiveNumber(item.rateCents) ? stripeDecimal(item.rateCents) : null
    const decimal = quantity !== null && unit !== null
    const amountCents = decimal ? Math.round(Number(quantity) * Number(unit)) : item.amountCents
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0)
      throw new AppError('INVALID_LINE_ITEM', `Line ${i + 1} needs a positive amount`)
    if (amountCents > MAX_AMOUNT_CENTS)
      throw new AppError('INVALID_LINE_ITEM', `Line ${i + 1} is larger than Stripe allows`)
    return {
      step: `item-${i}`,
      description,
      amountCents,
      quantityDecimal: decimal ? quantity : null,
      unitAmountDecimal: decimal ? unit : null
    }
  })
  if (lines.reduce((sum, line) => sum + line.amountCents, 0) > MAX_AMOUNT_CENTS)
    throw new AppError('INVOICE_TOO_LARGE', 'The invoice total is larger than Stripe allows')
  const frozen: FrozenInvoiceRequest = {
    version: 2,
    clientSyncId: client.syncId,
    customer: { email: client.email, name: client.name },
    daysUntilDue,
    achOnly: !!request.achOnly,
    description: request.memo ? request.memo.slice(0, 500) : null,
    currency: 'usd',
    lines,
    billing: {
      periodStart: billing.periodStart,
      periodEnd: billing.periodEnd,
      lines: billing.lines.map((line) => ({
        lineDate: line.lineDate,
        durationMinutes: line.durationMinutes,
        billed: line.billed ? line.billed.map((range) => structuredClone(range)) : null
      }))
    }
  }
  // Rejects undefined/NaN and anything outside the portable allowlist before it is retained.
  return readFrozenInvoiceRequest(toJsonObject(frozen))
}

/**
 * Input for invoiceService.saveInvoice, built from the retained request, not the retry.
 * `localBilling` is this computer's receipt (CreatedDraft.localBilling, or
 * resolvePortableBilling(db, frozen.billing) when the draft came from another computer).
 */
export function localInvoiceFromOperation(
  frozen: FrozenInvoiceRequest,
  draft: Omit<DraftInvoice, 'localId'>,
  clientId: number,
  testMode: boolean,
  localBilling: LocalInvoiceBilling
): {
  clientId: number
  stripeInvoiceId: string
  status: string
  amountDueCents: number
  amountPaidCents: number
  currency: string
  memo: string | null
  hostedUrl: string | null
  invoicePdf: string | null
  periodStart: string | null
  periodEnd: string | null
  testMode: boolean
  lineItems: Array<{
    lineDate: string | null
    description: string
    amountCents: number
    durationMinutes: number | null
    sessionIds: number[] | null
    billedRanges?: InvoiceBillingRange[]
    sortOrder: number
  }>
} {
  return {
    clientId,
    stripeInvoiceId: draft.invoiceId,
    status: draft.status,
    amountDueCents: draft.amountDueCents,
    amountPaidCents: 0,
    currency: draft.currency,
    memo: frozen.description,
    hostedUrl: draft.hostedUrl,
    invoicePdf: draft.invoicePdf,
    periodStart: frozen.billing.periodStart,
    periodEnd: frozen.billing.periodEnd,
    testMode,
    lineItems: frozen.lines.map((line, i) => {
      const meta = localBilling.lines[i]
      return {
        lineDate: meta?.lineDate ?? null,
        description: line.description,
        amountCents: line.amountCents,
        durationMinutes: meta?.durationMinutes ?? null,
        sessionIds: meta?.sessionIds ?? null,
        billedRanges: meta?.billedRanges ?? undefined,
        sortOrder: i
      }
    })
  }
}

async function retrieveCustomer(
  stripe: Stripe,
  customerId: string,
  account: ProviderAccount
): Promise<string | null> {
  let customer: Stripe.Customer | Stripe.DeletedCustomer
  try {
    customer = await stripe.customers.retrieve(customerId)
  } catch (error) {
    // Only Stripe's definite "no such customer" permits choosing another customer.
    if (isResourceMissing(error)) return null
    throw error
  }
  if (customer.deleted) return null
  requireMode(customer, account, 'customer')
  return customer.id
}

/** Positive paginated lookup of the customer this operation created. */
function recoverCreatedCustomer(
  stripe: Stripe,
  operationId: string,
  email: string
): Promise<Stripe.Customer | null> {
  return findOne(
    (startingAfter) =>
      stripe.customers.list({
        email,
        limit: 100,
        ...(startingAfter && { starting_after: startingAfter })
      }),
    (customer) => customer.metadata?.[OPERATION_METADATA] === operationId
  )
}

/**
 * Resolve the customer for an operation. Only creation is a provider step; a retry whose
 * creation step already started must recover/retry that step instead of re-deciding.
 */
export async function ensureCustomer<S extends Record<string, unknown>>(
  db: Db<S>,
  stripe: Stripe,
  expectedTestMode: boolean,
  operationId: string,
  client: InvoiceClient,
  context: StripeContext
): Promise<string> {
  if (client.localId !== undefined) checkClientProviderAccount(db, client.localId, context)
  const remember = (customerId: string): string => {
    if (client.localId !== undefined)
      retainCustomerReference(db, client.localId, context, customerId)
    return customerId
  }
  const started = frozenStep(db, operationId, 'customer')
  if (!started) {
    const reference =
      (client.localId === undefined
        ? null
        : scopedCustomerReference(db, client.localId, context)) ?? client.stripeCustomerId
    const saved = reference ? await retrieveCustomer(stripe, reference, context) : null
    if (saved) return remember(saved)
    const byEmail = await stripe.customers.list({ email: client.email, limit: 1 })
    const match = byEmail.data.find((c) => !c.deleted)
    if (match) {
      requireMode(match, context, 'customer')
      return remember(match.id)
    }
  }
  const body =
    started ??
    toJsonObject({
      email: client.email,
      name: client.name,
      metadata: { [OPERATION_METADATA]: operationId, [CLIENT_METADATA]: client.syncId }
    })
  const result = await executeProviderStep(db, {
    operationId,
    name: 'customer',
    request: body,
    context: () => readStripeContext(stripe, expectedTestMode),
    recover: async () => {
      const found = await recoverCreatedCustomer(stripe, operationId, String(body.email))
      if (!found) return null
      requireMode(found, context, 'customer')
      return { customerId: found.id }
    },
    write: async (idempotencyKey, request) => {
      const created = await stripe.customers.create(
        request as unknown as Stripe.CustomerCreateParams,
        { idempotencyKey, maxNetworkRetries: 0 }
      )
      requireMode(created, context, 'customer')
      return { customerId: created.id }
    }
  })
  return remember(String(result.customerId))
}

/** A successful Stripe read with the account/mode that performed it and Stripe's Date. */
export interface ProviderStatusRead {
  status: InvoiceStatus
  account: ProviderAccount
  /** Stripe's response Date header when known; never this computer's clock. */
  providerDate: string | null
}

export interface CreatedDraft {
  account: ProviderAccount
  draft: Omit<DraftInvoice, 'localId'>
  /** The request retained with the operation, for retry-safe local persistence. */
  frozen: FrozenInvoiceRequest
  /** This computer's local receipt for the frozen billing; never synced. */
  localBilling: LocalInvoiceBilling
  /**
   * The full retrieved status (amount paid, due date...). A resumed invoice may already be
   * open or paid; saving only the draft snapshot would record it as unpaid.
   */
  observation: ProviderStatusRead
}

/** Stripe's Date response header of an SDK result, or null. Never the SDK object itself. */
export function responseDate(value: unknown): string | null {
  const headers = (value as { lastResponse?: { headers?: Record<string, unknown> } } | null)
    ?.lastResponse?.headers
  const date = headers?.date ?? headers?.Date
  return typeof date === 'string' && Number.isFinite(Date.parse(date)) ? date : null
}

/** The strictly read request retained for this operation, or null for a new operation. */
export function retainedInvoiceRequest<S extends Record<string, unknown>>(
  db: Db<S>,
  operationId: string
): FrozenInvoiceRequest | null {
  const saved = db
    .select()
    .from(providerOperations)
    .where(eq(providerOperations.id, operationId))
    .get()
  if (!saved) return null
  if (saved.kind !== 'create-invoice')
    throw new AppError(
      'PROVIDER_OPERATION_CONFLICT',
      'This operation ID belongs to another action.'
    )
  return readFrozenInvoiceRequest(JSON.parse(saved.requestJson))
}

export interface DraftOperationOptions<S extends Record<string, unknown>> {
  /**
   * Resume exactly the retained request (pending-operation UI). The frozen request, including
   * its portable billing, is used as saved; the renderer can never supply portable billing.
   */
  resume?: boolean
  /**
   * Synchronous checks for a NEW operation, run inside the transaction that first retains it
   * (billing readiness, billed-work exclusions). A retained operation is never re-checked:
   * its uncertain writes must stay resumable under the same keys.
   */
  preflight?: (tx: Db<S>, frozen: FrozenInvoiceRequest, localBilling: LocalInvoiceBilling) => void
  /**
   * For a NEW operation only, after the account/mode read and before the retaining transaction:
   * refresh this client's Stripe invoices with the same captured client and account, so the
   * preflight's billed-work check sees what Stripe holds. Reads only; never a provider write.
   */
  refresh?: (stripe: Stripe, context: StripeContext) => Promise<void>
}

/**
 * Create a draft invoice for a renderer-generated operation ID. Retrying the same ID with
 * the same request resumes the same invoice; a changed request is rejected. A retry reuses the
 * retained portable billing, so remapped local IDs never alter the frozen request.
 */
export async function createDraftInvoiceOperation<S extends Record<string, unknown>>(
  db: Db<S>,
  stripe: Stripe,
  expectedTestMode: boolean,
  request: CreateInvoiceRequest,
  client: InvoiceClient,
  options: DraftOperationOptions<S> = {}
): Promise<CreatedDraft> {
  const operationId = request.operationId
  if (!isSyncUuid(operationId))
    throw new AppError(
      'INVALID_PROVIDER_OPERATION',
      'Invoice creation needs a stable operation ID from the draft.'
    )
  const saved = retainedInvoiceRequest(db, operationId)
  if (options.resume && !saved)
    throw new AppError(
      'INVOICE_OPERATION_NOT_FOUND',
      'This saved invoice operation is unavailable.'
    )
  if (saved && providerIntentHasConflict(db, operationId))
    throw new AppError(
      'INVOICE_SYNC_BLOCKED',
      'Shared records disagree about this invoice operation. Review Shared history in Settings before continuing.'
    )
  if (saved && providerOperationResolution(db, operationId))
    throw new AppError(
      'PROVIDER_OPERATION_CANCELLED',
      'This draft was cancelled after Stripe rejected it. Create a new draft instead.'
    )
  let frozen: FrozenInvoiceRequest
  let localBilling: LocalInvoiceBilling
  if (saved && options.resume) {
    frozen = saved
    localBilling = resolvePortableBilling(db, saved.billing)
  } else {
    localBilling = localBillingFromRequest(request)
    const billing: PortableInvoiceBilling = saved
      ? saved.billing
      : portableBillingFromLocal(db, localBilling)
    frozen = freezeInvoiceRequest(request, client, billing)
  }
  const context = await readStripeContext(stripe, expectedTestMode)
  if (!saved && options.refresh) {
    if (client.localId !== undefined) checkClientProviderAccount(db, client.localId, context)
    requireNoPendingInvoice(db, operationId, frozen.clientSyncId, context)
    await options.refresh(stripe, context)
  }
  db.transaction((tx) => {
    if (client.localId !== undefined) checkClientProviderAccount(tx, client.localId, context)
    requireNoPendingInvoice(tx, operationId, frozen.clientSyncId, context)
    const isNew = !tx
      .select({ id: providerOperations.id })
      .from(providerOperations)
      .where(eq(providerOperations.id, operationId))
      .get()
    if (isNew) options.preflight?.(tx as unknown as Db<S>, frozen, localBilling)
    retainOperation(tx, context, {
      id: operationId,
      kind: 'create-invoice',
      request: toJsonObject(frozen)
    })
  })
  const readContext = (): Promise<StripeContext> => readStripeContext(stripe, expectedTestMode)
  // The customer named by the retained request, even if the client's details changed since.
  const frozenClient: InvoiceClient = { ...client, ...frozen.customer, syncId: frozen.clientSyncId }

  const invoiceBody =
    frozenStep(db, operationId, 'invoice') ??
    toJsonObject({
      customer: await ensureCustomer(
        db,
        stripe,
        expectedTestMode,
        operationId,
        frozenClient,
        context
      ),
      auto_advance: false,
      pending_invoice_items_behavior: 'exclude',
      collection_method: 'send_invoice',
      days_until_due: frozen.daysUntilDue,
      payment_settings: {
        payment_method_types: frozen.achOnly ? ['us_bank_account'] : ['ach_debit', 'card']
      },
      ...(frozen.description && { description: frozen.description }),
      metadata: { [OPERATION_METADATA]: operationId }
    })
  const customerId = String(invoiceBody.customer)

  const created = await executeProviderStep(db, {
    operationId,
    name: 'invoice',
    request: invoiceBody,
    context: readContext,
    // Customer-scoped list, not eventually consistent search; empty is not proof.
    recover: async () => {
      const found = await findOne(
        (startingAfter) =>
          stripe.invoices.list({
            customer: customerId,
            limit: 100,
            ...(startingAfter && { starting_after: startingAfter })
          }),
        (invoice) => invoice.metadata?.[OPERATION_METADATA] === operationId
      )
      if (!found) return null
      requireMode(found, context, 'invoice')
      return { invoiceId: found.id }
    },
    write: async (idempotencyKey, body) => {
      const invoice = await stripe.invoices.create(body as unknown as Stripe.InvoiceCreateParams, {
        idempotencyKey,
        maxNetworkRetries: 0
      })
      requireMode(invoice, context, 'invoice')
      return { invoiceId: invoice.id }
    }
  })
  const invoiceId = String(created.invoiceId)
  validateInvoiceId(invoiceId)

  for (const line of frozen.lines) {
    const itemBody =
      frozenStep(db, operationId, line.step) ??
      toJsonObject({
        customer: customerId,
        invoice: invoiceId,
        description: line.description,
        currency: frozen.currency,
        ...(line.quantityDecimal && line.unitAmountDecimal
          ? {
              quantity_decimal: line.quantityDecimal,
              unit_amount_decimal: line.unitAmountDecimal
            }
          : { amount: line.amountCents }),
        metadata: { [OPERATION_METADATA]: operationId, [STEP_METADATA]: line.step }
      })
    await executeProviderStep(db, {
      operationId,
      name: line.step,
      request: itemBody,
      context: readContext,
      recover: async () => {
        const found = await findOne(
          (startingAfter) =>
            stripe.invoiceItems.list({
              invoice: invoiceId,
              limit: 100,
              ...(startingAfter && { starting_after: startingAfter })
            }),
          (item) =>
            item.metadata?.[OPERATION_METADATA] === operationId &&
            item.metadata?.[STEP_METADATA] === line.step
        )
        if (found) requireMode(found, context, 'invoice item')
        return found ? { invoiceItemId: found.id } : null
      },
      write: async (idempotencyKey, body) => {
        // quantity_decimal is accepted by the API but missing from SDK v20 types.
        const item = await stripe.invoiceItems.create(
          body as unknown as Stripe.InvoiceItemCreateParams,
          { idempotencyKey, maxNetworkRetries: 0 }
        )
        requireMode(item, context, 'invoice item')
        return { invoiceItemId: item.id }
      }
    })
  }

  const invoice = await retrieveOperationInvoice(stripe, invoiceId, context)
  if (invoice.metadata?.[OPERATION_METADATA] !== operationId)
    throw new AppError(
      'PROVIDER_RESULT_CONFLICT',
      'The Stripe invoice does not belong to this operation. Review it in Stripe.'
    )
  const account = { accountId: context.accountId, testMode: context.testMode }
  return {
    account,
    frozen,
    localBilling,
    observation: observedStatus(invoice, context),
    draft: {
      invoiceId: invoice.id,
      stripeCustomerId: customerId,
      status: statusOf(invoice),
      amountDueCents: invoice.amount_due,
      currency: invoice.currency,
      hostedUrl: invoice.hosted_invoice_url ?? null,
      invoicePdf: invoice.invoice_pdf ?? null,
      createdAt: new Date(invoice.created * 1000).toISOString()
    }
  }
}

// ── Existing invoices: finalize/send/void ──

function statusOf(invoice: Stripe.Invoice): InvoiceStatus['status'] {
  return INVOICE_STATUSES.has(invoice.status as InvoiceStatus['status'])
    ? (invoice.status as InvoiceStatus['status'])
    : 'draft'
}

export function mapInvoiceStatus(inv: Stripe.Invoice): InvoiceStatus {
  return {
    invoiceId: inv.id,
    status: statusOf(inv),
    amountDueCents: inv.amount_due,
    amountPaidCents: inv.amount_paid,
    currency: inv.currency,
    hostedUrl: inv.hosted_invoice_url ?? null,
    invoicePdf: inv.invoice_pdf ?? null,
    dueDate: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null,
    paidAt: inv.status_transitions?.paid_at
      ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
      : null
  }
}

/** A retrieved invoice as a provenance-carrying observation for recordProviderObservation. */
export function observedStatus(
  invoice: Stripe.Invoice,
  context: StripeContext
): ProviderStatusRead {
  return {
    status: mapInvoiceStatus(invoice),
    account: { accountId: context.accountId, testMode: context.testMode },
    // The retrieval's own Date when present, else the earlier context read (never later).
    providerDate: responseDate(invoice) ?? (context.providerDate || null)
  }
}

/**
 * Retrieval with the operation's captured client proves the invoice is in its account;
 * mode is checked explicitly. Errors propagate: a failed read never authorizes a write.
 */
async function retrieveOperationInvoice(
  stripe: Stripe,
  invoiceId: string,
  account: ProviderAccount
): Promise<Stripe.Invoice> {
  const invoice = await stripe.invoices.retrieve(invoiceId)
  requireMode(invoice, account, 'invoice')
  return invoice
}

async function invoiceOperation<S extends Record<string, unknown>>(
  db: Db<S>,
  stripe: Stripe,
  expectedTestMode: boolean,
  kind: 'send-invoice' | 'void-invoice',
  invoiceId: string,
  check?: (invoice: Stripe.Invoice, context: StripeContext, operationId: string) => void
): Promise<{ operationId: string; context: StripeContext; invoice: Stripe.Invoice }> {
  validateInvoiceId(invoiceId)
  const context = await readStripeContext(stripe, expectedTestMode)
  checkSavedInvoiceAccount(db, invoiceId, context)
  const invoice = await retrieveOperationInvoice(stripe, invoiceId, context)
  bindRetrievedInvoiceAccount(db, invoiceId, context)
  const operationId = invoiceOperationId(kind, context, invoiceId)
  check?.(invoice, context, operationId)
  // A legacy local invoice has no saved account; this operation records the verified one.
  retainOperation(db, context, { id: operationId, kind, request: { invoiceId } })
  return { operationId, context, invoice }
}

/**
 * Checks before finalizing/sending with the current Stripe retrieval (invoice-preflight's
 * checkBeforeSend). Throws to block; runs only while no send attempt can have emailed.
 */
export type SendPreflight = (invoice: Stripe.Invoice, context: StripeContext) => void

/**
 * Finalize if needed, then send once. An open invoice does not prove an earlier send
 * was delivered, so the send step has no recovery: only its saved result or its
 * still-valid idempotency key can complete an uncertain attempt. Only an attempt Stripe
 * definitely rejected is followed by a new attempt (and key).
 */
export async function sendInvoiceOperation<S extends Record<string, unknown>>(
  db: Db<S>,
  stripe: Stripe,
  expectedTestMode: boolean,
  invoiceId: string,
  preflight?: SendPreflight
): Promise<ProviderStatusRead> {
  let sendName = 'send'
  const { operationId, context, invoice } = await invoiceOperation(
    db,
    stripe,
    expectedTestMode,
    'send-invoice',
    invoiceId,
    (retrieved, read, id) => {
      sendName = providerAttemptName(db, id, 'send')
      if (!frozenStep(db, id, sendName)) preflight?.(retrieved, read)
    }
  )
  const readContext = (): Promise<StripeContext> => readStripeContext(stripe, expectedTestMode)
  const request = { invoice: invoiceId }
  let status = invoice.status
  const finalizeName = providerAttemptName(db, operationId, 'finalize')
  if (frozenStep(db, operationId, finalizeName) || status === 'draft') {
    await executeProviderStep(db, {
      operationId,
      name: finalizeName,
      request,
      context: readContext,
      recover: async () => {
        const current = await retrieveOperationInvoice(stripe, invoiceId, context)
        return current.status && current.status !== 'draft' ? { invoiceId } : null
      },
      write: async (idempotencyKey) => {
        const finalized = await stripe.invoices.finalizeInvoice(
          invoiceId,
          {},
          { idempotencyKey, maxNetworkRetries: 0 }
        )
        requireMode(finalized, context, 'invoice')
        return { invoiceId }
      }
    })
    status = (await retrieveOperationInvoice(stripe, invoiceId, context)).status
  }
  if (!frozenStep(db, operationId, sendName) && status !== 'open')
    throw new AppError(
      'INVOICE_NOT_SENDABLE',
      `This invoice is ${status ?? 'unknown'} and cannot be sent.`
    )
  await executeProviderStep(db, {
    operationId,
    name: sendName,
    request,
    context: readContext,
    write: async (idempotencyKey) => {
      const sent = await stripe.invoices.sendInvoice(
        invoiceId,
        {},
        { idempotencyKey, maxNetworkRetries: 0 }
      )
      requireMode(sent, context, 'invoice')
      return { invoiceId }
    }
  })
  return observedStatus(await retrieveOperationInvoice(stripe, invoiceId, context), context)
}

/** Void is observable: a retrieved void status positively recovers an uncertain attempt. */
export async function voidInvoiceOperation<S extends Record<string, unknown>>(
  db: Db<S>,
  stripe: Stripe,
  expectedTestMode: boolean,
  invoiceId: string
): Promise<ProviderStatusRead> {
  const { operationId, context, invoice } = await invoiceOperation(
    db,
    stripe,
    expectedTestMode,
    'void-invoice',
    invoiceId
  )
  const voidName = providerAttemptName(db, operationId, 'void')
  const started = frozenStep(db, operationId, voidName)
  if (!started && invoice.status === 'void') return observedStatus(invoice, context)
  if (!started && invoice.status !== 'open' && invoice.status !== 'uncollectible')
    throw new AppError(
      'INVOICE_NOT_VOIDABLE',
      `This invoice is ${invoice.status ?? 'unknown'} and cannot be voided.`
    )
  await executeProviderStep(db, {
    operationId,
    name: voidName,
    request: { invoice: invoiceId },
    context: () => readStripeContext(stripe, expectedTestMode),
    recover: async () => {
      const current = await retrieveOperationInvoice(stripe, invoiceId, context)
      return current.status === 'void' ? { invoiceId } : null
    },
    write: async (idempotencyKey) => {
      const voided = await stripe.invoices.voidInvoice(
        invoiceId,
        {},
        { idempotencyKey, maxNetworkRetries: 0 }
      )
      requireMode(voided, context, 'invoice')
      return { invoiceId }
    }
  })
  return observedStatus(await retrieveOperationInvoice(stripe, invoiceId, context), context)
}
