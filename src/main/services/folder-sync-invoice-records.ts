import { createHash } from 'node:crypto'
import { and, eq, inArray, like } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { syncChanges, syncLocalLinks, syncRecordStates } from '../db/schema/folder-sync'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import { sessionBillingRefs } from '../db/schema/session-history'
import {
  providerOperations,
  providerOperationSteps,
  providerOperationResults,
  providerOperationRejections,
  providerOperationResolutions
} from '../db/schema/provider-operations'
import { AppError } from '../../shared/types/ipc'
import type { InvoiceBillingRange, InvoiceStatus } from '../../shared/types/invoice'
import {
  canonicalJson,
  isSyncUuid,
  parseChange,
  SyncError,
  type JsonObject,
  type JsonValue,
  type SyncChange,
  type SyncEntityType
} from './folder-sync-protocol'
import { recordLocalSyncChanges, type SyncDomainAdapter } from './folder-sync-store'
import { historySyncWorkspace } from './folder-sync-history-records'
import { getDirectoryRecordView } from './folder-sync-directory-records'
import { PRESENT } from './folder-sync-revisions'
import { findClientByPortableId, getPortableClientId } from './folder-sync-builtin-client'
import {
  isPortableInstant,
  localBilledRange,
  localBilledRanges,
  portableBilledRange,
  readPortableBilledRanges,
  type PortableBilledRange
} from './invoice-portable-billing'
import { readFrozenInvoiceRequest, STRIPE_DECIMAL } from './stripe-operation-service'
import {
  readProviderRejectionProof,
  requireProviderAccount,
  type ProviderAccount,
  type ProviderOperationJournal
} from './provider-operation-store'

/*
 * Portable invoices and provider operations (folder-sync-plan.md decision H).
 *
 * Every record is an immutable fact whose change ID is a version-8 UUID over the workspace and its
 * complete body, so equal exports from several computers converge and nothing is ever edited in
 * place. Payloads are exact allowlists; local row numbers, paths, credentials, SDK objects and
 * response headers never appear.
 *
 * - invoice: the saved header snapshot, entity invoiceSyncId(providerInvoiceId). Depends on the
 *   client's directory heads. A second, different header for one invoice is a visible conflict;
 *   the projected local row (issued amounts, lines) is never rewritten by a later arrival.
 * - invoice-line: one immutable line snapshot, entity `${invoiceSyncId}:${index}`.
 * - billing-reference: billed-work ranges keyed by stable anchors (invoice-portable-billing).
 *   Several references union; billed work can only become more excluded, never eligible again.
 * - provider-observation: a cached Stripe status with provenance. Each lists the observation heads
 *   it superseded, so the view is causal: concurrent heads are ranked by status progression and
 *   Stripe's server Date, never a device clock, and a paid/void observation never regresses.
 * - provider-intent: a retained operation, step (frozen body, idempotency key and Stripe start
 *   Date), result, Stripe's definite rejection of a step, or a proven cancellation, keyed by
 *   operation ID. Importing only restores rows so another computer can resume the same operation
 *   safely (or knows it must not); no provider or AI call is ever made from an import.
 */

type Db<S extends Record<string, unknown>> = BetterSQLite3Database<S>
type AnyDb = BetterSQLite3Database<Record<string, unknown>>
type Transaction = Parameters<SyncDomainAdapter['apply']>[0]
type Reader = Pick<Transaction, 'select'>
type InvoiceEntityType = (typeof INVOICE_SYNC_ENTITY_TYPES)[number]

export const INVOICE_SYNC_ENTITY_TYPES = [
  'invoice',
  'invoice-line',
  'billing-reference',
  'provider-observation',
  'provider-intent'
] as const satisfies readonly SyncEntityType[]

export function isInvoiceEntityType(value: unknown): value is InvoiceEntityType {
  return (INVOICE_SYNC_ENTITY_TYPES as readonly unknown[]).includes(value)
}

// ── Payload shapes ──

export interface PortableInvoiceHeader {
  version: 1
  provider: 'stripe'
  providerInvoiceId: string
  /** Null for a legacy invoice whose account has not been verified by a retrieval yet. */
  accountId: string | null
  testMode: boolean
  operationId: string | null
  clientSyncId: string
  currency: string
  memo: string | null
  periodStart: string | null
  periodEnd: string | null
  issuedAt: string
  issuedAmountCents: number
  lineCount: number
}

export interface PortableInvoiceLine {
  version: 1
  invoiceId: string
  index: number
  description: string
  amountCents: number
  lineDate: string | null
  durationMinutes: number | null
}

export interface PortableBillingReference {
  version: 1
  invoiceId: string
  ranges: PortableBilledRange[]
}

export type ProviderObservationBasis = 'retrieved' | 'cached'

export interface PortableProviderObservation {
  version: 1
  invoiceId: string
  providerInvoiceId: string
  accountId: string | null
  testMode: boolean
  /** 'retrieved': read from Stripe with a verified key. 'cached': a pre-sync local copy. */
  basis: ProviderObservationBasis
  status: InvoiceStatus['status']
  amountDueCents: number
  amountPaidCents: number
  currency: string
  hostedUrl: string | null
  invoicePdf: string | null
  dueDate: string | null
  paidAt: string | null
  /** Stripe's response Date (normalized UTC) when known; never this computer's clock. */
  providerDate: string | null
  /** Observation change IDs this one causally replaces (the heads its writer had seen). */
  supersedes: string[]
}

export type ProviderIntentKind =
  | 'create-invoice'
  | 'send-invoice'
  | 'void-invoice'
  | 'sync-customer'

export type PortableProviderIntent =
  | {
      version: 1
      record: 'operation'
      operationId: string
      kind: ProviderIntentKind
      accountId: string
      testMode: boolean
      request: JsonObject
    }
  | {
      version: 1
      record: 'step'
      operationId: string
      name: string
      request: JsonObject
      idempotencyKey: string
      startedProviderAt: string
    }
  | { version: 1; record: 'result'; operationId: string; name: string; result: JsonObject }
  | { version: 1; record: 'rejection'; operationId: string; name: string; proof: JsonObject }
  | {
      version: 1
      record: 'resolution'
      operationId: string
      resolution: 'cancelled'
      proof: JsonObject
    }

export interface ObservationView {
  effective: (PortableProviderObservation & { changeId: string }) | null
  heads: string[]
  /** Paid and void both observed: Stripe needs review; the local row keeps its value. */
  terminalConflict: boolean
  /** Non-terminal observations that claim to follow a terminal state; never applied. */
  ignoredRegressions: string[]
}

export type InvoiceProjectionIssue =
  | 'client-unavailable'
  | 'lines-incomplete'
  | 'line-conflict'
  | 'header-conflict'
  | 'account-conflict'
  | 'mode-conflict'

export interface InvoiceRecordState {
  headerChangeId: string | null
  conflicts: string[]
  issue: InvoiceProjectionIssue | null
  unresolvedRanges: number
  observation: ObservationView
}

export interface ProviderIntentState {
  kind: ProviderIntentKind | null
  conflicts: string[]
}

// ── Validation helpers ──

const INVOICE_ID = /^in_[A-Za-z0-9]{1,250}$/
const ACCOUNT_ID = /^acct_[A-Za-z0-9]{1,250}$/
const CUSTOMER_ID = /^cus_[A-Za-z0-9]{1,250}$/
const ITEM_ID = /^ii_[A-Za-z0-9]{1,250}$/
const CURRENCY = /^[a-z]{3}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const ITEM_STEP = /^item-(0|[1-9]\d{0,2})$/
const LINE_ENTITY = /^([0-9a-f-]{36}):(0|[1-9]\d{0,3})$/
const SECRET = /\b(sk|rk|pk)_(live|test)_|\bwhsec_|\bsk-ant-|\bBearer\s/i
const STATUSES: readonly InvoiceStatus['status'][] = [
  'draft',
  'open',
  'paid',
  'void',
  'uncollectible'
]
const TERMINAL = new Set<string>(['paid', 'void'])
const RANK: Record<string, number> = { draft: 0, open: 1, uncollectible: 2, paid: 3, void: 3 }
const MAX_TEXT = 5000
const MAX_LINES = 1000
const MAX_SUPERSEDES = 1000
/** A repeatable step's attempt: `send`, then `send-2`... (only after a definite rejection). */
const ATTEMPT_STEP = /^(finalize|send|void)(-([2-9]|1\d|20))?$/
const attemptOf = (name: string): string | null => ATTEMPT_STEP.exec(name)?.[1] ?? null
const STEP_NAMES: Record<ProviderIntentKind, (name: string) => boolean> = {
  'create-invoice': (name) => name === 'customer' || name === 'invoice' || ITEM_STEP.test(name),
  'sync-customer': (name) => name === 'customer',
  'send-invoice': (name) => attemptOf(name) === 'finalize' || attemptOf(name) === 'send',
  'void-invoice': (name) => attemptOf(name) === 'void'
}
const OPERATION_METADATA = 'clautime_operation_id'
const STEP_METADATA = 'clautime_step'
const CLIENT_METADATA = 'clautime_client_sync_id'
const PAYMENT_METHODS = new Set(['us_bank_account', 'ach_debit', 'card'])

function malformed(message: string): never {
  throw new SyncError('SYNC_MALFORMED', message)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isObject(value)) malformed(`${label} must be an object`)
  const actual = Object.keys(value)
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key)))
    malformed(`${label} has missing or unsupported fields`)
  return value
}

function withOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isObject(value)) malformed(`${label} must be an object`)
  const present = optional.filter((key) => Object.hasOwn(value, key))
  return exact(value, [...required, ...present], label)
}

function isText(value: unknown, max = MAX_TEXT, allowEmpty = false): value is string {
  if (typeof value !== 'string' || value.length > max || !value.isWellFormed()) return false
  if (!allowEmpty && !value.trim()) return false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if ((code < 0x20 || code === 0x7f) && code !== 0x09 && code !== 0x0a && code !== 0x0d)
      return false
  }
  return true
}

const isInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value)
const isCount = (value: unknown): value is number => isInteger(value) && value >= 0
const isDay = (value: unknown): value is string =>
  typeof value === 'string' && DAY.test(value) && Number.isFinite(Date.parse(value))
const nullable =
  <T>(check: (value: unknown) => value is T) =>
  (value: unknown): boolean =>
    value === null || check(value)

function isStripeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (url.hostname === 'stripe.com' || url.hostname.endsWith('.stripe.com'))
    )
  } catch {
    return false
  }
}

/** Defense in depth behind the allowlists: credential-shaped text never enters a record. */
function rejectSecrets(value: JsonValue, label: string): void {
  if (typeof value === 'string') {
    if (SECRET.test(value)) malformed(`${label} contains credential-shaped text`)
  } else if (Array.isArray(value)) value.forEach((item) => rejectSecrets(item, label))
  else if (isObject(value)) Object.values(value).forEach((item) => rejectSecrets(item, label))
}

function uuidList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_SUPERSEDES) malformed(`${label} is invalid`)
  const sorted = [...value].sort()
  if (
    !value.every(isSyncUuid) ||
    new Set(value).size !== value.length ||
    sorted.some((id, i) => id !== value[i])
  )
    malformed(`${label} must be sorted unique change IDs`)
  return value as string[]
}

/** RFC 9562 version-8 UUID over sha256 of canonical JSON. */
function v8(value: unknown): string {
  const bytes = createHash('sha256').update(canonicalJson(value)).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** One portable identity per Stripe invoice; independent of account binding and local rows. */
export function invoiceSyncId(providerInvoiceId: string): string {
  if (!INVOICE_ID.test(providerInvoiceId))
    throw new AppError('INVALID_INVOICE_ID', 'Invalid Stripe invoice ID format')
  return v8({ purpose: 'clautime-invoice-1', providerInvoiceId })
}

function invoiceChangeId(
  workspaceId: string,
  entityType: InvoiceEntityType,
  entityId: string,
  payload: JsonObject,
  dependencies: string[]
): string {
  return v8({
    purpose: 'clautime-invoice-change-1',
    workspaceId,
    entityType,
    entityId,
    payload,
    dependencies
  })
}

function fact(
  workspaceId: string,
  entityType: InvoiceEntityType,
  entityId: string,
  payload: object,
  dependencies: readonly string[]
): SyncChange {
  const sorted = [...new Set(dependencies)].sort()
  const body = payload as unknown as JsonObject
  return {
    id: invoiceChangeId(workspaceId, entityType, entityId, body, sorted),
    kind: 'fact',
    entityType,
    entityId,
    dependencies: sorted,
    payload: body
  }
}

// ── Structural validation (no database) ──

function validateHeader(change: SyncChange): PortableInvoiceHeader {
  const p = exact(
    change.payload,
    [
      'version',
      'provider',
      'providerInvoiceId',
      'accountId',
      'testMode',
      'operationId',
      'clientSyncId',
      'currency',
      'memo',
      'periodStart',
      'periodEnd',
      'issuedAt',
      'issuedAmountCents',
      'lineCount'
    ],
    `Invoice ${change.id}`
  )
  if (
    p.version !== 1 ||
    p.provider !== 'stripe' ||
    typeof p.providerInvoiceId !== 'string' ||
    !INVOICE_ID.test(p.providerInvoiceId) ||
    !(p.accountId === null || (typeof p.accountId === 'string' && ACCOUNT_ID.test(p.accountId))) ||
    typeof p.testMode !== 'boolean' ||
    !nullable(isSyncUuid)(p.operationId) ||
    !isSyncUuid(p.clientSyncId) ||
    typeof p.currency !== 'string' ||
    !CURRENCY.test(p.currency) ||
    !nullable(isText)(p.memo) ||
    !nullable(isDay)(p.periodStart) ||
    !nullable(isDay)(p.periodEnd) ||
    !isPortableInstant(p.issuedAt) ||
    !isInteger(p.issuedAmountCents) ||
    !isCount(p.lineCount) ||
    (p.lineCount as number) > MAX_LINES
  )
    malformed(`Invoice ${change.id} has an invalid header`)
  if (change.entityId !== invoiceSyncId(p.providerInvoiceId as string))
    malformed(`Invoice ${change.id} must be keyed by its Stripe invoice`)
  if (!change.dependencies.length) malformed(`Invoice ${change.id} must depend on its client`)
  return p as unknown as PortableInvoiceHeader
}

function validateLine(change: SyncChange): PortableInvoiceLine {
  const p = exact(
    change.payload,
    ['version', 'invoiceId', 'index', 'description', 'amountCents', 'lineDate', 'durationMinutes'],
    `Invoice line ${change.id}`
  )
  if (
    p.version !== 1 ||
    !isSyncUuid(p.invoiceId) ||
    !isCount(p.index) ||
    (p.index as number) >= MAX_LINES ||
    !isText(p.description) ||
    !isInteger(p.amountCents) ||
    !nullable(isDay)(p.lineDate) ||
    !(
      p.durationMinutes === null ||
      (typeof p.durationMinutes === 'number' &&
        Number.isFinite(p.durationMinutes) &&
        p.durationMinutes >= 0 &&
        p.durationMinutes <= 1_000_000)
    )
  )
    malformed(`Invoice line ${change.id} is invalid`)
  if (change.entityId !== `${p.invoiceId}:${p.index}`)
    malformed(`Invoice line ${change.id} has the wrong entity ID`)
  if (!change.dependencies.length) malformed(`Invoice line ${change.id} must depend on its invoice`)
  return p as unknown as PortableInvoiceLine
}

function validateBilling(change: SyncChange): PortableBillingReference {
  const p = exact(change.payload, ['version', 'invoiceId', 'ranges'], `Billing ${change.id}`)
  if (p.version !== 1 || !isSyncUuid(p.invoiceId) || change.entityId !== p.invoiceId)
    malformed(`Billing ${change.id} must be keyed by its invoice`)
  if (!readPortableBilledRanges(p.ranges, `Billing ${change.id}`).length)
    malformed(`Billing ${change.id} lists no billed work`)
  if (!change.dependencies.length) malformed(`Billing ${change.id} must depend on its invoice`)
  return p as unknown as PortableBillingReference
}

function validateObservation(change: SyncChange): PortableProviderObservation {
  const p = exact(
    change.payload,
    [
      'version',
      'invoiceId',
      'providerInvoiceId',
      'accountId',
      'testMode',
      'basis',
      'status',
      'amountDueCents',
      'amountPaidCents',
      'currency',
      'hostedUrl',
      'invoicePdf',
      'dueDate',
      'paidAt',
      'providerDate',
      'supersedes'
    ],
    `Observation ${change.id}`
  )
  if (
    p.version !== 1 ||
    !isSyncUuid(p.invoiceId) ||
    typeof p.providerInvoiceId !== 'string' ||
    !INVOICE_ID.test(p.providerInvoiceId) ||
    p.invoiceId !== invoiceSyncId(p.providerInvoiceId) ||
    change.entityId !== p.invoiceId ||
    !(p.accountId === null || (typeof p.accountId === 'string' && ACCOUNT_ID.test(p.accountId))) ||
    typeof p.testMode !== 'boolean' ||
    (p.basis !== 'retrieved' && p.basis !== 'cached') ||
    (p.basis === 'retrieved' && p.accountId === null) ||
    !STATUSES.includes(p.status as InvoiceStatus['status']) ||
    !isCount(p.amountDueCents) ||
    !isCount(p.amountPaidCents) ||
    typeof p.currency !== 'string' ||
    !CURRENCY.test(p.currency) ||
    !nullable(isStripeUrl)(p.hostedUrl) ||
    !nullable(isStripeUrl)(p.invoicePdf) ||
    !nullable(isPortableInstant)(p.dueDate) ||
    !nullable(isPortableInstant)(p.paidAt) ||
    !nullable(isPortableInstant)(p.providerDate)
  )
    malformed(`Observation ${change.id} is invalid`)
  const supersedes = uuidList(p.supersedes, `Observation ${change.id} supersedes`)
  if (supersedes.some((id) => !change.dependencies.includes(id)))
    malformed(`Observation ${change.id} must depend on what it supersedes`)
  if (change.dependencies.length !== supersedes.length + 1)
    malformed(`Observation ${change.id} must depend only on its invoice and superseded heads`)
  return p as unknown as PortableProviderObservation
}

function metadata(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  return exact(value, keys, `${label} metadata`)
}

/** Exact Stripe request bodies ClauTime writes, per step name. */
export function validateProviderStepRequest(
  operationId: string,
  name: string,
  request: unknown
): void {
  const label = `Step ${name}`
  if (name === 'customer') {
    const body = exact(request, ['email', 'name', 'metadata'], label)
    const meta = metadata(body.metadata, [OPERATION_METADATA, CLIENT_METADATA], label)
    if (
      !isText(body.email, 320, true) ||
      !isText(body.name, 500) ||
      meta[OPERATION_METADATA] !== operationId ||
      !isSyncUuid(meta[CLIENT_METADATA])
    )
      malformed(`${label} has an invalid body`)
  } else if (name === 'invoice') {
    const body = withOptional(
      request,
      [
        'customer',
        'auto_advance',
        'pending_invoice_items_behavior',
        'collection_method',
        'days_until_due',
        'payment_settings',
        'metadata'
      ],
      ['description'],
      label
    )
    const settings = exact(body.payment_settings, ['payment_method_types'], `${label} payment`)
    const methods = settings.payment_method_types
    const meta = metadata(body.metadata, [OPERATION_METADATA], label)
    if (
      typeof body.customer !== 'string' ||
      !CUSTOMER_ID.test(body.customer) ||
      body.auto_advance !== false ||
      body.pending_invoice_items_behavior !== 'exclude' ||
      body.collection_method !== 'send_invoice' ||
      !isCount(body.days_until_due) ||
      (body.days_until_due as number) > 3650 ||
      !Array.isArray(methods) ||
      !methods.length ||
      !methods.every((method) => typeof method === 'string' && PAYMENT_METHODS.has(method)) ||
      (Object.hasOwn(body, 'description') && !isText(body.description, 500)) ||
      meta[OPERATION_METADATA] !== operationId
    )
      malformed(`${label} has an invalid body`)
  } else if (ITEM_STEP.test(name)) {
    const decimal = isObject(request) && Object.hasOwn(request, 'quantity_decimal')
    const body = exact(
      request,
      [
        'customer',
        'invoice',
        'description',
        'currency',
        'metadata',
        ...(decimal ? ['quantity_decimal', 'unit_amount_decimal'] : ['amount'])
      ],
      label
    )
    const meta = metadata(body.metadata, [OPERATION_METADATA, STEP_METADATA], label)
    const decimalText = (value: unknown) => typeof value === 'string' && STRIPE_DECIMAL.test(value)
    if (
      typeof body.customer !== 'string' ||
      !CUSTOMER_ID.test(body.customer) ||
      typeof body.invoice !== 'string' ||
      !INVOICE_ID.test(body.invoice) ||
      !isText(body.description, 500) ||
      body.currency !== 'usd' ||
      (decimal
        ? !decimalText(body.quantity_decimal) || !decimalText(body.unit_amount_decimal)
        : !isCount(body.amount) || (body.amount as number) <= 0) ||
      meta[OPERATION_METADATA] !== operationId ||
      meta[STEP_METADATA] !== name
    )
      malformed(`${label} has an invalid body`)
  } else if (attemptOf(name)) {
    const body = exact(request, ['invoice'], label)
    if (typeof body.invoice !== 'string' || !INVOICE_ID.test(body.invoice))
      malformed(`${label} has an invalid body`)
  } else malformed(`Unsupported provider step ${name}`)
}

export function validateProviderStepResult(name: string, result: unknown): void {
  const [key, pattern] =
    name === 'customer'
      ? ['customerId', CUSTOMER_ID]
      : ITEM_STEP.test(name)
        ? ['invoiceItemId', ITEM_ID]
        : ['invoiceId', INVOICE_ID]
  const body = exact(result, [key], `Result ${name}`)
  if (typeof body[key] !== 'string' || !pattern.test(body[key] as string))
    malformed(`Result ${name} is invalid`)
}

export function validateProviderOperationRequest(kind: ProviderIntentKind, request: unknown): void {
  if (kind === 'create-invoice') {
    try {
      readFrozenInvoiceRequest(request)
    } catch (error) {
      malformed(error instanceof Error ? error.message : 'Invalid frozen invoice request')
    }
  } else if (kind === 'send-invoice' || kind === 'void-invoice') {
    const body = exact(request, ['invoiceId'], `${kind} request`)
    if (typeof body.invoiceId !== 'string' || !INVOICE_ID.test(body.invoiceId))
      malformed(`${kind} request is invalid`)
  } else if (kind === 'sync-customer') {
    const body = exact(request, ['clientSyncId', 'email', 'name'], `${kind} request`)
    if (!isSyncUuid(body.clientSyncId) || !isText(body.email, 320, true) || !isText(body.name, 500))
      malformed(`${kind} request is invalid`)
  } else malformed('Unsupported provider operation kind')
}

interface PortableCancellationProof {
  version: 1
  basis: 'rejected-before-invoice' | 'draft-deleted'
  rejectedSteps: string[]
  invoiceId: string | null
  itemIds: string[]
  checkedProviderAt: string | null
}

/** Strict read of invoice-operation-resolution's CancellationProof. */
function readCancellationProof(value: unknown, label: string): PortableCancellationProof {
  const p = exact(
    value,
    ['version', 'basis', 'rejectedSteps', 'invoiceId', 'itemIds', 'checkedProviderAt'],
    `${label} proof`
  )
  const sortedUnique = (list: unknown, pattern: RegExp): list is string[] =>
    Array.isArray(list) &&
    list.length <= MAX_LINES + 2 &&
    list.every((item) => typeof item === 'string' && pattern.test(item)) &&
    new Set(list).size === list.length &&
    [...list].sort().every((item, i) => item === list[i])
  const createStep = /^(customer|invoice|item-(0|[1-9]\d{0,2}))$/
  if (
    p.version !== 1 ||
    !sortedUnique(p.rejectedSteps, createStep) ||
    !sortedUnique(p.itemIds, ITEM_ID)
  )
    malformed(`${label} has an invalid cancellation proof`)
  const rejected = p.rejectedSteps as string[]
  if (p.basis === 'rejected-before-invoice') {
    if (
      !rejected.length ||
      rejected.some((name) => name !== 'customer' && name !== 'invoice') ||
      p.invoiceId !== null ||
      (p.itemIds as string[]).length ||
      p.checkedProviderAt !== null
    )
      malformed(`${label} has an invalid cancellation proof`)
  } else if (p.basis === 'draft-deleted') {
    if (
      typeof p.invoiceId !== 'string' ||
      !INVOICE_ID.test(p.invoiceId) ||
      !isPortableInstant(p.checkedProviderAt)
    )
      malformed(`${label} has an invalid cancellation proof`)
  } else malformed(`${label} has an invalid cancellation basis`)
  return p as unknown as PortableCancellationProof
}

function validateIntent(change: SyncChange): PortableProviderIntent {
  const record = isObject(change.payload) ? change.payload.record : undefined
  const label = `Provider intent ${change.id}`
  if (record === 'operation') {
    const p = exact(
      change.payload,
      ['version', 'record', 'operationId', 'kind', 'accountId', 'testMode', 'request'],
      label
    )
    if (
      p.version !== 1 ||
      !isSyncUuid(p.operationId) ||
      typeof p.accountId !== 'string' ||
      !ACCOUNT_ID.test(p.accountId) ||
      typeof p.testMode !== 'boolean' ||
      !Object.hasOwn(STEP_NAMES, p.kind as string)
    )
      malformed(`${label} is invalid`)
    validateProviderOperationRequest(p.kind as ProviderIntentKind, p.request)
    if (change.dependencies.length) malformed(`${label}: an operation has no dependencies`)
  } else if (record === 'step') {
    const p = exact(
      change.payload,
      [
        'version',
        'record',
        'operationId',
        'name',
        'request',
        'idempotencyKey',
        'startedProviderAt'
      ],
      label
    )
    if (
      p.version !== 1 ||
      !isSyncUuid(p.operationId) ||
      typeof p.name !== 'string' ||
      p.idempotencyKey !== `clautime:${p.operationId}:${p.name}` ||
      !isPortableInstant(p.startedProviderAt)
    )
      malformed(`${label} is invalid`)
    validateProviderStepRequest(p.operationId as string, p.name as string, p.request)
    if (change.dependencies.length !== 1) malformed(`${label} must depend on its operation`)
  } else if (record === 'result') {
    const p = exact(change.payload, ['version', 'record', 'operationId', 'name', 'result'], label)
    if (p.version !== 1 || !isSyncUuid(p.operationId) || typeof p.name !== 'string')
      malformed(`${label} is invalid`)
    if (!Object.values(STEP_NAMES).some((allowed) => allowed(p.name as string)))
      malformed(`${label} names an unsupported step`)
    validateProviderStepResult(p.name as string, p.result)
    if (change.dependencies.length !== 2)
      malformed(`${label} must depend on its operation and step`)
  } else if (record === 'rejection') {
    const p = exact(change.payload, ['version', 'record', 'operationId', 'name', 'proof'], label)
    if (p.version !== 1 || !isSyncUuid(p.operationId) || typeof p.name !== 'string')
      malformed(`${label} is invalid`)
    if (!Object.values(STEP_NAMES).some((allowed) => allowed(p.name as string)))
      malformed(`${label} names an unsupported step`)
    try {
      readProviderRejectionProof(p.proof)
    } catch {
      malformed(`${label} has an invalid rejection proof`)
    }
    if (change.dependencies.length !== 2)
      malformed(`${label} must depend on its operation and step`)
  } else if (record === 'resolution') {
    const p = exact(
      change.payload,
      ['version', 'record', 'operationId', 'resolution', 'proof'],
      label
    )
    if (p.version !== 1 || !isSyncUuid(p.operationId) || p.resolution !== 'cancelled')
      malformed(`${label} is invalid`)
    const proof = readCancellationProof(p.proof, label)
    if (change.dependencies.length !== 1 + proof.rejectedSteps.length + (proof.invoiceId ? 1 : 0))
      malformed(`${label} must depend on its operation and the facts it relies on`)
  } else malformed(`${label} has an unsupported record`)
  if (change.entityId !== change.payload.operationId)
    malformed(`${label} must be keyed by its operation`)
  return change.payload as unknown as PortableProviderIntent
}

/** Structural and allowlist check without database access. Revisions are never accepted. */
export function validateInvoiceChange(value: unknown): SyncChange {
  const change = parseChange(value)
  if (!isInvoiceEntityType(change.entityType))
    malformed(`${change.entityType} is not an invoice record`)
  if (change.kind !== 'fact') malformed(`${change.id}: invoice records are immutable facts`)
  rejectSecrets(change.payload, `Change ${change.id}`)
  switch (change.entityType) {
    case 'invoice':
      validateHeader(change)
      break
    case 'invoice-line':
      if (!LINE_ENTITY.test(change.entityId)) malformed(`${change.id} has an invalid line ID`)
      validateLine(change)
      break
    case 'billing-reference':
      validateBilling(change)
      break
    case 'provider-observation':
      validateObservation(change)
      break
    case 'provider-intent':
      validateIntent(change)
      break
  }
  return change
}

// ── Reading applied facts ──

interface StoredFact<T> {
  id: string
  dependencies: string[]
  payload: T
}

function storedFacts<T>(
  db: Reader,
  workspaceId: string,
  entityType: InvoiceEntityType,
  entityIds: string[]
): Array<StoredFact<T>> {
  if (!entityIds.length) return []
  const rows: Array<{ json: string }> = []
  for (let offset = 0; offset < entityIds.length; offset += 500)
    rows.push(
      ...db
        .select({ json: syncChanges.changeJson })
        .from(syncChanges)
        .where(
          and(
            eq(syncChanges.workspaceId, workspaceId),
            eq(syncChanges.entityType, entityType),
            inArray(syncChanges.entityId, entityIds.slice(offset, offset + 500))
          )
        )
        .all()
    )
  return rows
    .map((row) => JSON.parse(row.json) as SyncChange)
    .map((change) => ({
      id: change.id,
      dependencies: change.dependencies,
      payload: change.payload as unknown as T
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function appliedChange(db: Reader, workspaceId: string, id: string): SyncChange | undefined {
  const row = db
    .select({ json: syncChanges.changeJson })
    .from(syncChanges)
    .where(and(eq(syncChanges.workspaceId, workspaceId), eq(syncChanges.id, id)))
    .get()
  return row ? (JSON.parse(row.json) as SyncChange) : undefined
}

function readState<T>(
  db: Reader,
  workspaceId: string,
  entityType: string,
  entityId: string
): T | null {
  const row = db
    .select({ json: syncRecordStates.stateJson })
    .from(syncRecordStates)
    .where(
      and(
        eq(syncRecordStates.workspaceId, workspaceId),
        eq(syncRecordStates.entityType, entityType),
        eq(syncRecordStates.entityId, entityId)
      )
    )
    .get()
  return row ? (JSON.parse(row.json) as T) : null
}

function writeState(
  tx: Transaction,
  workspaceId: string,
  entityType: string,
  entityId: string,
  state: unknown
): void {
  const stateJson = JSON.stringify(state)
  tx.insert(syncRecordStates)
    .values({ workspaceId, entityType, entityId, stateJson })
    .onConflictDoUpdate({
      target: [
        syncRecordStates.workspaceId,
        syncRecordStates.entityType,
        syncRecordStates.entityId
      ],
      set: { stateJson }
    })
    .run()
}

export function readInvoiceRecordState(
  db: Reader,
  workspaceId: string,
  invoiceId: string
): InvoiceRecordState | null {
  return readState<InvoiceRecordState>(db, workspaceId, 'invoice', invoiceId)
}

export function readProviderIntentState(
  db: Reader,
  workspaceId: string,
  operationId: string
): ProviderIntentState | null {
  return readState<ProviderIntentState>(db, workspaceId, 'provider-intent', operationId)
}

// ── Provider observations: causal, monotonic view ──

function compareObservations(
  a: StoredFact<PortableProviderObservation>,
  b: StoredFact<PortableProviderObservation>
): number {
  const x = a.payload
  const y = b.payload
  return (
    RANK[y.status] - RANK[x.status] ||
    Number(y.basis === 'retrieved') - Number(x.basis === 'retrieved') ||
    y.amountPaidCents - x.amountPaidCents ||
    // Stripe's server Date; an unknown date ranks below any known one.
    (y.providerDate ?? '').localeCompare(x.providerDate ?? '') ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

/**
 * The effective status of one invoice. A causally later observation replaces what it superseded
 * (a partial payment with an unchanged status included). Concurrent heads are ranked by status
 * progression, retrieval provenance, amount paid and Stripe's Date. A paid/void observation is
 * never replaced by a non-terminal one, whatever its claimed causality or clock.
 */
export function providerObservationView(
  observations: Array<StoredFact<PortableProviderObservation>>
): ObservationView {
  const superseded = new Set(observations.flatMap((o) => o.payload.supersedes))
  const heads = observations.filter((o) => !superseded.has(o.id))
  const terminal = observations.filter((o) => TERMINAL.has(o.payload.status))
  const byId = new Map(observations.map((o) => [o.id, o]))
  const followsTerminal = (o: StoredFact<PortableProviderObservation>): boolean => {
    const seen = new Set<string>()
    const pending = [...o.payload.supersedes]
    while (pending.length) {
      const id = pending.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      const previous = byId.get(id)
      if (!previous) continue
      if (TERMINAL.has(previous.payload.status)) return true
      pending.push(...previous.payload.supersedes)
    }
    return false
  }
  const ignoredRegressions = heads
    .filter((o) => !TERMINAL.has(o.payload.status) && followsTerminal(o))
    .map((o) => o.id)
  const candidates = terminal.length
    ? [
        ...heads.filter((o) => TERMINAL.has(o.payload.status)),
        // A terminal observation superseded only by a regression stays effective.
        ...terminal.filter(
          (o) =>
            !heads.includes(o) &&
            !observations.some(
              (later) =>
                later.payload.supersedes.includes(o.id) && TERMINAL.has(later.payload.status)
            )
        )
      ]
    : heads
  const ranked = [...candidates].sort(compareObservations)
  const best = ranked[0]
  const terminalStatuses = new Set(
    candidates.map((o) => o.payload.status).filter((s) => TERMINAL.has(s))
  )
  return {
    effective: best ? { ...best.payload, changeId: best.id } : null,
    heads: heads.map((o) => o.id).sort(),
    terminalConflict: terminalStatuses.size > 1,
    ignoredRegressions: ignoredRegressions.sort()
  }
}

function observationsOf(
  db: Reader,
  workspaceId: string,
  invoiceId: string
): Array<StoredFact<PortableProviderObservation>> {
  return storedFacts<PortableProviderObservation>(db, workspaceId, 'provider-observation', [
    invoiceId
  ])
}

/** The cached provider status of a saved invoice, with its causal heads and provenance. */
export function readProviderObservation(
  db: Reader,
  workspaceId: string,
  providerInvoiceId: string
): ObservationView {
  return providerObservationView(observationsOf(db, workspaceId, invoiceSyncId(providerInvoiceId)))
}

type StatusColumns = Pick<
  typeof invoices.$inferSelect,
  | 'status'
  | 'amountDueCents'
  | 'amountPaidCents'
  | 'currency'
  | 'hostedUrl'
  | 'invoicePdf'
  | 'dueDate'
  | 'paidAt'
>

function statusColumns(o: Pick<PortableProviderObservation, keyof StatusColumns>): StatusColumns {
  return {
    status: o.status,
    amountDueCents: o.amountDueCents,
    amountPaidCents: o.amountPaidCents,
    currency: o.currency,
    hostedUrl: o.hostedUrl,
    invoicePdf: o.invoicePdf,
    dueDate: o.dueDate,
    paidAt: o.paidAt
  }
}

/** Only the cached status columns change; the saved header and lines never do. */
function applyStatus(
  tx: Transaction,
  local: typeof invoices.$inferSelect,
  next: StatusColumns
): boolean {
  if (TERMINAL.has(local.status) && !TERMINAL.has(next.status)) return false
  if (TERMINAL.has(local.status) && TERMINAL.has(next.status) && local.status !== next.status)
    return false
  const current = statusColumns(local as unknown as PortableProviderObservation)
  if (canonicalJson(current) === canonicalJson(next)) return false
  tx.update(invoices)
    .set({ ...next, updatedAt: new Date().toISOString() })
    .where(eq(invoices.id, local.id))
    .run()
  return true
}

// ── Projection ──

function localLink(db: Reader, workspaceId: string, invoiceId: string): number | null {
  return (
    db
      .select({ localId: syncLocalLinks.localId })
      .from(syncLocalLinks)
      .where(
        and(
          eq(syncLocalLinks.workspaceId, workspaceId),
          eq(syncLocalLinks.entityType, 'invoice'),
          eq(syncLocalLinks.entityId, invoiceId)
        )
      )
      .get()?.localId ?? null
  )
}

function mergeBillingRef(
  tx: Transaction,
  sessionId: number,
  stripeInvoiceId: string,
  testMode: number,
  range: InvoiceBillingRange
): void {
  const condition = and(
    eq(sessionBillingRefs.sessionId, sessionId),
    eq(sessionBillingRefs.stripeInvoiceId, stripeInvoiceId),
    eq(sessionBillingRefs.testMode, testMode)
  )
  const existing = tx.select().from(sessionBillingRefs).where(condition).get()
  if (!existing) {
    tx.insert(sessionBillingRefs)
      .values({ sessionId, stripeInvoiceId, testMode, billedRanges: [range] })
      .run()
    return
  }
  const ranges = existing.billedRanges ?? []
  const covered = ranges.some(
    (r) =>
      Date.parse(r.startedAt) <= Date.parse(range.startedAt) &&
      Date.parse(r.endedAt) >= Date.parse(range.endedAt)
  )
  // Union only: an arriving reference widens billed work and never narrows a local freeze.
  if (!covered)
    tx.update(sessionBillingRefs)
      .set({ billedRanges: [...ranges, range] })
      .where(condition)
      .run()
}

/**
 * Two exports of one Stripe invoice (for example saved separately on each computer before sync)
 * that agree on what was issued are variants, not a billing conflict: save times differ and one
 * copy may already know the verified account or operation.
 */
function sameIssuedInvoice(a: PortableInvoiceHeader, b: PortableInvoiceHeader): boolean {
  return (
    a.clientSyncId === b.clientSyncId &&
    a.testMode === b.testMode &&
    a.currency === b.currency &&
    a.issuedAmountCents === b.issuedAmountCents &&
    a.lineCount === b.lineCount &&
    (a.accountId === null || b.accountId === null || a.accountId === b.accountId) &&
    (a.operationId === null || b.operationId === null || a.operationId === b.operationId)
  )
}

function projectInvoice(
  tx: Transaction,
  workspaceId: string,
  invoiceId: string
): InvoiceRecordState {
  const headers = storedFacts<PortableInvoiceHeader>(tx, workspaceId, 'invoice', [invoiceId])
  const observation = providerObservationView(observationsOf(tx, workspaceId, invoiceId))
  const state: InvoiceRecordState = {
    headerChangeId: headers[0]?.id ?? null,
    conflicts: headers.slice(1).map((header) => header.id),
    issue: headers.slice(1).some((other) => !sameIssuedInvoice(headers[0].payload, other.payload))
      ? 'header-conflict'
      : null,
    unresolvedRanges: 0,
    observation
  }
  const header = headers[0]?.payload
  if (!header) {
    writeState(tx, workspaceId, 'invoice', invoiceId, state)
    return state
  }
  const lineIds = Array.from({ length: header.lineCount }, (_, index) => `${invoiceId}:${index}`)
  // Lines belong to the header they were exported with; the chosen header is deterministic.
  const lines = storedFacts<PortableInvoiceLine>(tx, workspaceId, 'invoice-line', lineIds).filter(
    (line) => line.dependencies.includes(headers[0].id)
  )
  const byIndex = new Map<number, PortableInvoiceLine[]>()
  for (const line of lines)
    byIndex.set(line.payload.index, [...(byIndex.get(line.payload.index) ?? []), line.payload])
  if ([...byIndex.values()].some((list) => list.length > 1)) {
    state.issue ??= 'line-conflict'
    state.conflicts.push(
      ...lines.filter((line) => (byIndex.get(line.payload.index)?.length ?? 0) > 1).map((l) => l.id)
    )
  }

  let localId = localLink(tx, workspaceId, invoiceId)
  let local =
    localId === null ? undefined : tx.select().from(invoices).where(eq(invoices.id, localId)).get()
  if (!local) {
    const existing = tx
      .select()
      .from(invoices)
      .where(eq(invoices.stripeInvoiceId, header.providerInvoiceId))
      .get()
    if (existing) {
      if (!!existing.testMode !== header.testMode) state.issue = 'mode-conflict'
      else if (
        existing.providerAccountId &&
        header.accountId &&
        existing.providerAccountId !== header.accountId
      )
        state.issue = 'account-conflict'
      else local = existing
    } else if (!state.issue) {
      const clientId = findClientByPortableId(tx, header.clientSyncId)?.id
      if (clientId === undefined) state.issue = 'client-unavailable'
      else if (byIndex.size !== header.lineCount) state.issue = 'lines-incomplete'
      else {
        const initial = observation.effective
          ? statusColumns(observation.effective)
          : {
              status: 'draft' as const,
              amountDueCents: header.issuedAmountCents,
              amountPaidCents: 0,
              currency: header.currency,
              hostedUrl: null,
              invoicePdf: null,
              dueDate: null,
              paidAt: null
            }
        const operationTaken =
          header.operationId !== null &&
          !!tx
            .select({ id: invoices.id })
            .from(invoices)
            .where(eq(invoices.operationId, header.operationId))
            .get()
        local = tx
          .insert(invoices)
          .values({
            clientId,
            stripeInvoiceId: header.providerInvoiceId,
            providerAccountId: header.accountId,
            operationId: operationTaken ? null : header.operationId,
            ...initial,
            memo: header.memo,
            periodStart: header.periodStart,
            periodEnd: header.periodEnd,
            testMode: header.testMode ? 1 : 0,
            createdAt: header.issuedAt,
            updatedAt: new Date().toISOString()
          })
          .returning()
          .get()
        for (let index = 0; index < header.lineCount; index++) {
          const line = byIndex.get(index)![0]
          tx.insert(invoiceLineItems)
            .values({
              invoiceId: local.id,
              lineDate: line.lineDate,
              description: line.description,
              amountCents: line.amountCents,
              durationMinutes:
                line.durationMinutes === null ? null : Math.round(line.durationMinutes),
              sessionIds: null,
              sortOrder: index,
              createdAt: header.issuedAt
            })
            .run()
        }
      }
    }
    if (local) {
      localId = local.id
      tx.insert(syncLocalLinks)
        .values({ workspaceId, entityType: 'invoice', entityId: invoiceId, localId })
        .onConflictDoUpdate({
          target: [syncLocalLinks.workspaceId, syncLocalLinks.entityType, syncLocalLinks.entityId],
          set: { localId }
        })
        .run()
      // A verified account from the header scopes a legacy local row; nothing else is rewritten.
      const binding: Partial<typeof invoices.$inferInsert> = {}
      if (!local.providerAccountId && header.accountId) binding.providerAccountId = header.accountId
      if (
        !local.operationId &&
        header.operationId &&
        !tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(eq(invoices.operationId, header.operationId))
          .get()
      )
        binding.operationId = header.operationId
      if (Object.keys(binding).length) {
        tx.update(invoices).set(binding).where(eq(invoices.id, local.id)).run()
        local = { ...local, ...binding } as typeof local
      }
    }
  }

  if (local) {
    for (const reference of storedFacts<PortableBillingReference>(
      tx,
      workspaceId,
      'billing-reference',
      [invoiceId]
    ))
      for (const range of reference.payload.ranges) {
        const resolved = localBilledRange(tx, range)
        if (resolved.sessionId > 0)
          mergeBillingRef(tx, resolved.sessionId, local.stripeInvoiceId, local.testMode, resolved)
        else state.unresolvedRanges++
      }
    if (observation.effective && !observation.terminalConflict)
      applyStatus(tx, local, statusColumns(observation.effective))
  }
  writeState(tx, workspaceId, 'invoice', invoiceId, state)
  return state
}

function requireDependency(
  tx: Reader,
  workspaceId: string,
  change: SyncChange,
  match: (dependency: SyncChange) => boolean,
  label: string
): void {
  if (
    !change.dependencies.some((id) => {
      const dependency = appliedChange(tx, workspaceId, id)
      return !!dependency && match(dependency)
    })
  )
    malformed(`${change.id} must depend on ${label}`)
}

const isHeaderOf = (invoiceId: string) => (dependency: SyncChange) =>
  dependency.entityType === 'invoice' && dependency.entityId === invoiceId

function intentConflict(
  tx: Transaction,
  workspaceId: string,
  change: SyncChange,
  kind: ProviderIntentKind | null
): void {
  const state = readProviderIntentState(tx, workspaceId, change.entityId) ?? { kind, conflicts: [] }
  if (!state.conflicts.includes(change.id)) state.conflicts = [...state.conflicts, change.id].sort()
  state.kind ??= kind
  writeState(tx, workspaceId, 'provider-intent', change.entityId, state)
}

/** Restores retained rows only. A differing local row is held as a visible conflict. */
function projectIntent(tx: Transaction, workspaceId: string, change: SyncChange): void {
  const intent = validateIntent(change)
  const operation = tx
    .select()
    .from(providerOperations)
    .where(eq(providerOperations.id, intent.operationId))
    .get()
  if (intent.record === 'operation') {
    const row = {
      id: intent.operationId,
      accountId: intent.accountId,
      testMode: intent.testMode ? 1 : 0,
      kind: intent.kind,
      requestJson: canonicalJson(intent.request)
    }
    if (!operation) tx.insert(providerOperations).values(row).run()
    else if (canonicalJson(operation) !== canonicalJson(row))
      intentConflict(tx, workspaceId, change, intent.kind)
    if (!readProviderIntentState(tx, workspaceId, change.entityId))
      writeState(tx, workspaceId, 'provider-intent', change.entityId, {
        kind: intent.kind,
        conflicts: []
      })
    return
  }
  requireDependency(
    tx,
    workspaceId,
    change,
    (dependency) =>
      dependency.entityType === 'provider-intent' &&
      dependency.entityId === intent.operationId &&
      (dependency.payload as { record?: string }).record === 'operation',
    `operation ${intent.operationId}`
  )
  if (!operation) malformed(`${change.id}: operation ${intent.operationId} is not restored`)
  const kind = operation.kind as ProviderIntentKind
  if (intent.record === 'resolution') {
    projectResolution(tx, workspaceId, change, intent, kind)
    return
  }
  if (!STEP_NAMES[kind]?.(intent.name))
    malformed(`${change.id}: ${kind} has no step ${intent.name}`)
  const condition = (
    table:
      | typeof providerOperationSteps
      | typeof providerOperationResults
      | typeof providerOperationRejections
  ) => and(eq(table.operationId, intent.operationId), eq(table.name, intent.name))
  if (intent.record === 'step') {
    const row = {
      operationId: intent.operationId,
      name: intent.name,
      requestJson: canonicalJson(intent.request),
      idempotencyKey: intent.idempotencyKey,
      startedProviderAt: intent.startedProviderAt
    }
    const existing = tx
      .select()
      .from(providerOperationSteps)
      .where(condition(providerOperationSteps))
      .get()
    if (!existing) tx.insert(providerOperationSteps).values(row).run()
    else if (canonicalJson(existing) !== canonicalJson(row))
      intentConflict(tx, workspaceId, change, kind)
    return
  }
  requireDependency(
    tx,
    workspaceId,
    change,
    (dependency) =>
      dependency.entityType === 'provider-intent' &&
      dependency.entityId === intent.operationId &&
      (dependency.payload as { record?: string; name?: string }).record === 'step' &&
      (dependency.payload as { name?: string }).name === intent.name,
    `step ${intent.name}`
  )
  if (intent.record === 'rejection') {
    const proofJson = canonicalJson(intent.proof)
    const rejection = tx
      .select()
      .from(providerOperationRejections)
      .where(condition(providerOperationRejections))
      .get()
    // A step that completed somewhere cannot also have been rejected: keep both visible.
    if (tx.select().from(providerOperationResults).where(condition(providerOperationResults)).get())
      intentConflict(tx, workspaceId, change, kind)
    else if (!rejection)
      tx.insert(providerOperationRejections)
        .values({ operationId: intent.operationId, name: intent.name, proofJson })
        .run()
    else if (rejection.proofJson !== proofJson) intentConflict(tx, workspaceId, change, kind)
    return
  }
  const resultJson = canonicalJson(intent.result)
  const existing = tx
    .select()
    .from(providerOperationResults)
    .where(condition(providerOperationResults))
    .get()
  if (
    tx
      .select()
      .from(providerOperationRejections)
      .where(condition(providerOperationRejections))
      .get()
  )
    intentConflict(tx, workspaceId, change, kind)
  else if (!existing)
    tx.insert(providerOperationResults)
      .values({ operationId: intent.operationId, name: intent.name, resultJson })
      .run()
  else if (existing.resultJson !== resultJson) intentConflict(tx, workspaceId, change, kind)
}

/** A saved invoice (here or shared) that came from this operation or is its deleted draft. */
function savedFromOperation(
  tx: Reader,
  workspaceId: string,
  operationId: string,
  invoiceId: string | null
): boolean {
  if (
    tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.operationId, operationId)).get()
  )
    return true
  if (
    invoiceId &&
    (tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.stripeInvoiceId, invoiceId))
      .get() ||
      storedFacts(tx, workspaceId, 'invoice', [invoiceSyncId(invoiceId)]).length)
  )
    return true
  return tx
    .select({ json: syncChanges.changeJson })
    .from(syncChanges)
    .where(
      and(
        eq(syncChanges.workspaceId, workspaceId),
        eq(syncChanges.entityType, 'invoice'),
        like(syncChanges.changeJson, `%${operationId}%`)
      )
    )
    .all()
    .some((row) => (JSON.parse(row.json) as SyncChange).payload.operationId === operationId)
}

/**
 * Whether what this computer knows now contradicts a cancellation proof: a saved invoice, a
 * result it denies, a created item it did not verify deleted, a cited rejection that is missing
 * or completed, or a started step without a result or rejection (possibly effective).
 */
function contradictsCancellation(
  tx: Reader,
  workspaceId: string,
  operationId: string,
  proof: PortableCancellationProof
): boolean {
  const results = new Map(
    tx
      .select()
      .from(providerOperationResults)
      .where(eq(providerOperationResults.operationId, operationId))
      .all()
      .map((row) => [row.name, JSON.parse(row.resultJson) as Record<string, unknown>])
  )
  const rejections = new Set(
    tx
      .select({ name: providerOperationRejections.name })
      .from(providerOperationRejections)
      .where(eq(providerOperationRejections.operationId, operationId))
      .all()
      .map((row) => row.name)
  )
  const steps = tx
    .select({ name: providerOperationSteps.name })
    .from(providerOperationSteps)
    .where(eq(providerOperationSteps.operationId, operationId))
    .all()
    .map((row) => row.name)
  const invoiceId = results.get('invoice')?.invoiceId
  return (
    (typeof invoiceId === 'string' ? invoiceId : null) !== proof.invoiceId ||
    [...results].some(
      ([name, result]) =>
        ITEM_STEP.test(name) &&
        (typeof result.invoiceItemId !== 'string' || !proof.itemIds.includes(result.invoiceItemId))
    ) ||
    steps.some((name) => !results.has(name) && !rejections.has(name)) ||
    proof.rejectedSteps.some((name) => !rejections.has(name) || results.has(name)) ||
    savedFromOperation(tx, workspaceId, operationId, proof.invoiceId)
  )
}

/** Conflict key of a local cancellation that has no shared record yet. */
const localResolutionKey = (operationId: string): string =>
  v8({ purpose: 'clautime-local-resolution-1', operationId })

/**
 * Re-check every retained cancellation of one operation against what is known now. A step,
 * result, rejection or invoice can arrive after it (from another computer or a delayed file), so
 * this runs on each such arrival. A contradicted cancellation stays recorded for audit but is held
 * as a visible conflict, which blocks the client and keeps the frozen work billed; the hold is
 * derived, so it lifts only when later facts settle consistently with the proof.
 */
function revalidateResolutions(tx: Transaction, workspaceId: string, operationId: string): void {
  const operation = tx
    .select()
    .from(providerOperations)
    .where(eq(providerOperations.id, operationId))
    .get()
  if (operation?.kind !== 'create-invoice') return
  const resolutionRow = () =>
    tx
      .select()
      .from(providerOperationResolutions)
      .where(eq(providerOperationResolutions.operationId, operationId))
      .get()
  let row = resolutionRow()
  const proofs = storedFacts<PortableProviderIntent>(tx, workspaceId, 'provider-intent', [
    operationId
  ])
    .filter((fact) => fact.payload.record === 'resolution')
    .map((fact) => ({
      key: fact.id,
      json: canonicalJson(
        (fact.payload as Extract<PortableProviderIntent, { record: 'resolution' }>).proof
      )
    }))
  if (row && !proofs.some((proof) => proof.json === row!.proofJson))
    proofs.push({ key: localResolutionKey(operationId), json: row.proofJson })
  if (!proofs.length) return
  const contradicted = new Map(
    proofs.map((proof) => {
      let read: PortableCancellationProof
      try {
        read = readCancellationProof(JSON.parse(proof.json), `Resolution ${proof.key}`)
      } catch {
        return [proof.key, true] as const
      }
      return [proof.key, contradictsCancellation(tx, workspaceId, operationId, read)] as const
    })
  )
  if (!row) {
    const clear = proofs.find((proof) => !contradicted.get(proof.key))
    if (clear) {
      tx.insert(providerOperationResolutions)
        .values({ operationId, resolution: 'cancelled', proofJson: clear.json })
        .run()
      row = resolutionRow()
    }
  }
  const state = readProviderIntentState(tx, workspaceId, operationId)
  const conflicts = new Set(state?.conflicts ?? [])
  for (const proof of proofs)
    if (contradicted.get(proof.key) || (row && row.proofJson !== proof.json))
      conflicts.add(proof.key)
    else conflicts.delete(proof.key)
  const next = [...conflicts].sort()
  if (!state || canonicalJson(next) !== canonicalJson(state.conflicts))
    writeState(tx, workspaceId, 'provider-intent', operationId, {
      kind: state?.kind ?? 'create-invoice',
      conflicts: next
    } satisfies ProviderIntentState)
}

/**
 * A cancellation from another computer. Its proof was verified there; here it must cite facts
 * that exist and agree with everything this computer knows (revalidateResolutions, which runs
 * after every provider-intent arrival), otherwise it is held as a visible conflict and the
 * operation keeps blocking and billing.
 */
function projectResolution(
  tx: Transaction,
  workspaceId: string,
  change: SyncChange,
  intent: Extract<PortableProviderIntent, { record: 'resolution' }>,
  kind: ProviderIntentKind
): void {
  const proof = readCancellationProof(intent.proof, `Provider intent ${change.id}`)
  if (kind !== 'create-invoice') malformed(`${change.id}: only an invoice draft can be cancelled`)
  const payload = (dependency: SyncChange) =>
    dependency.payload as { record?: string; name?: string; result?: { invoiceId?: string } }
  for (const name of proof.rejectedSteps)
    requireDependency(
      tx,
      workspaceId,
      change,
      (dependency) =>
        dependency.entityId === intent.operationId &&
        payload(dependency).record === 'rejection' &&
        payload(dependency).name === name,
      `rejection ${name}`
    )
  if (proof.invoiceId)
    requireDependency(
      tx,
      workspaceId,
      change,
      (dependency) =>
        dependency.entityId === intent.operationId &&
        payload(dependency).record === 'result' &&
        payload(dependency).name === 'invoice' &&
        payload(dependency).result?.invoiceId === proof.invoiceId,
      'the deleted draft'
    )
  // Recorded (or held) by revalidateResolutions right after this projection.
}

/**
 * Store hook, called after the change is inserted into sync_changes. Deterministic IDs and
 * causal dependencies are checked against applied changes; nothing here contacts a provider.
 */
export function applyInvoiceChange(tx: Transaction, workspaceId: string, value: unknown): void {
  const change = validateInvoiceChange(value)
  if (
    change.id !==
    invoiceChangeId(
      workspaceId,
      change.entityType as InvoiceEntityType,
      change.entityId,
      change.payload,
      change.dependencies
    )
  )
    malformed(`${change.id} is not the content ID of its record`)
  if (change.dependencies.some((id) => !appliedChange(tx, workspaceId, id)))
    throw new AppError('SYNC_MISSING_DEPENDENCY', `${change.id} waits for its dependencies`)
  switch (change.entityType) {
    case 'invoice': {
      const header = change.payload as unknown as PortableInvoiceHeader
      requireDependency(
        tx,
        workspaceId,
        change,
        (dependency) =>
          dependency.kind === 'revision' &&
          dependency.entityType === 'client' &&
          dependency.entityId === header.clientSyncId,
        `client ${header.clientSyncId}`
      )
      projectInvoice(tx, workspaceId, change.entityId)
      // A saved invoice contradicts a cancellation of the operation that drafted it.
      const drafting = tx
        .select({ operationId: providerOperationResults.operationId })
        .from(providerOperationResults)
        .where(
          and(
            eq(providerOperationResults.name, 'invoice'),
            eq(
              providerOperationResults.resultJson,
              canonicalJson({ invoiceId: header.providerInvoiceId })
            )
          )
        )
        .all()
        .map((row) => row.operationId)
      for (const operationId of new Set([
        ...(header.operationId ? [header.operationId] : []),
        ...drafting
      ]))
        revalidateResolutions(tx, workspaceId, operationId)
      return
    }
    case 'invoice-line':
    case 'billing-reference': {
      const invoiceId = (change.payload as { invoiceId: string }).invoiceId
      requireDependency(tx, workspaceId, change, isHeaderOf(invoiceId), `invoice ${invoiceId}`)
      projectInvoice(tx, workspaceId, invoiceId)
      return
    }
    case 'provider-observation': {
      const observation = change.payload as unknown as PortableProviderObservation
      requireDependency(
        tx,
        workspaceId,
        change,
        isHeaderOf(observation.invoiceId),
        `invoice ${observation.invoiceId}`
      )
      for (const id of observation.supersedes) {
        const previous = appliedChange(tx, workspaceId, id)
        if (
          previous?.entityType !== 'provider-observation' ||
          previous.entityId !== observation.invoiceId
        )
          malformed(`${change.id} supersedes ${id}, which is not an observation of this invoice`)
      }
      const header = storedFacts<PortableInvoiceHeader>(tx, workspaceId, 'invoice', [
        observation.invoiceId
      ])[0]
      if (
        header &&
        (header.payload.testMode !== observation.testMode ||
          (header.payload.accountId &&
            observation.accountId &&
            header.payload.accountId !== observation.accountId))
      )
        malformed(`${change.id} observes a different Stripe account or mode than its invoice`)
      projectInvoice(tx, workspaceId, observation.invoiceId)
      return
    }
    case 'provider-intent':
      projectIntent(tx, workspaceId, change)
      revalidateResolutions(tx, workspaceId, change.entityId)
      return
  }
}

/** Handles only INVOICE_SYNC_ENTITY_TYPES; route other entity types elsewhere. */
export const invoiceRecordsAdapter: SyncDomainAdapter = {
  validate: (change) => void validateInvoiceChange(change),
  apply: applyInvoiceChange
}

/** Retry projections held for a missing client or anchor, e.g. after a directory import. */
export function refreshInvoiceProjections(tx: Transaction, workspaceId: string): void {
  const ids = tx
    .select({ entityId: syncChanges.entityId })
    .from(syncChanges)
    .where(and(eq(syncChanges.workspaceId, workspaceId), eq(syncChanges.entityType, 'invoice')))
    .all()
  for (const entityId of new Set(ids.map((row) => row.entityId)))
    projectInvoice(tx, workspaceId, entityId)
}

/**
 * Root wiring: call after applyReadySyncBatches. Billed work can arrive before the activity,
 * manual entry or legacy record it names (unrelated batches, or other domains later in the same
 * batch); until then its range already excludes by client/project bucket via portableBilledRanges.
 */
export function refreshInvoiceSyncProjections<S extends Record<string, unknown>>(db: Db<S>): void {
  const workspaceId = historySyncWorkspace(db)
  if (!workspaceId) return
  db.transaction((tx) => refreshInvoiceProjections(tx as unknown as Transaction, workspaceId))
}

// ── Local planning (export) ──

export type InvoiceWithheldReason =
  | 'requires-client'
  | 'client-unavailable'
  | 'billing-unavailable'
  | 'invalid-invoice'
  | 'header-differs'

export type InvoicePlan =
  | { status: 'ready'; changes: SyncChange[] }
  | { status: 'withheld'; reason: InvoiceWithheldReason; message?: string }

function toInstant(value: string | null): string | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function headerOf(
  db: Reader,
  row: typeof invoices.$inferSelect,
  lines: Array<typeof invoiceLineItems.$inferSelect>
): PortableInvoiceHeader | null {
  const clientSyncId = getPortableClientId(db, row.clientId)
  if (!clientSyncId) return null
  return {
    version: 1,
    provider: 'stripe',
    providerInvoiceId: row.stripeInvoiceId,
    accountId: row.providerAccountId,
    testMode: !!row.testMode,
    operationId: row.operationId,
    clientSyncId,
    currency: row.currency,
    memo: row.memo?.trim() ? row.memo : null,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    issuedAt: toInstant(row.createdAt) ?? new Date(0).toISOString(),
    issuedAmountCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
    lineCount: lines.length
  }
}

function cachedObservationOf(
  row: typeof invoices.$inferSelect,
  invoiceId: string,
  basis: ProviderObservationBasis,
  providerDate: string | null,
  supersedes: string[]
): PortableProviderObservation {
  return {
    version: 1,
    invoiceId,
    providerInvoiceId: row.stripeInvoiceId,
    accountId: row.providerAccountId,
    testMode: !!row.testMode,
    basis,
    status: row.status,
    amountDueCents: row.amountDueCents,
    amountPaidCents: row.amountPaidCents,
    currency: row.currency,
    hostedUrl: isStripeUrl(row.hostedUrl) ? row.hostedUrl : null,
    invoicePdf: isStripeUrl(row.invoicePdf) ? row.invoicePdf : null,
    dueDate: toInstant(row.dueDate),
    paidAt: toInstant(row.paidAt),
    providerDate,
    supersedes
  }
}

/** Portable billed ranges of one saved invoice, from its frozen local references. */
function billedRangesOf(db: Reader, row: typeof invoices.$inferSelect): PortableBilledRange[] {
  const refs = db
    .select()
    .from(sessionBillingRefs)
    .where(
      and(
        eq(sessionBillingRefs.stripeInvoiceId, row.stripeInvoiceId),
        eq(sessionBillingRefs.testMode, row.testMode)
      )
    )
    .all()
  const ranges = new Map<string, PortableBilledRange>()
  for (const ref of refs)
    for (const range of ref.billedRanges ?? []) {
      const portable = portableBilledRange(db, { ...range, sessionId: ref.sessionId })
      ranges.set(canonicalJson(portable), portable)
    }
  return [...ranges.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, range]) => range)
}

/** The portable billed ranges frozen by the create operation that produced this invoice. */
function operationRangesOf(db: Reader, row: typeof invoices.$inferSelect): PortableBilledRange[] {
  if (!row.operationId) return []
  const operation = db
    .select()
    .from(providerOperations)
    .where(eq(providerOperations.id, row.operationId))
    .get()
  if (!operation || operation.kind !== 'create-invoice' || !!operation.testMode !== !!row.testMode)
    return []
  const result = db
    .select()
    .from(providerOperationResults)
    .where(
      and(
        eq(providerOperationResults.operationId, row.operationId),
        eq(providerOperationResults.name, 'invoice')
      )
    )
    .get()
  try {
    if (
      !result ||
      (JSON.parse(result.resultJson) as { invoiceId?: unknown }).invoiceId !== row.stripeInvoiceId
    )
      return []
    return readFrozenInvoiceRequest(JSON.parse(operation.requestJson)).billing.lines.flatMap(
      (line) => line.billed ?? []
    )
  } catch {
    return []
  }
}

/**
 * Export of one saved invoice: header, line snapshots, billed work not yet exported and, when no
 * status is shared yet, its last-known status as a 'cached' observation. Returns only new changes.
 */
export function planInvoiceExport(
  db: Reader,
  workspaceId: string,
  localInvoiceId: number
): InvoicePlan {
  const row = db.select().from(invoices).where(eq(invoices.id, localInvoiceId)).get()
  if (!row) return { status: 'withheld', reason: 'invalid-invoice', message: 'Invoice not found' }
  const lines = db
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, row.id))
    .orderBy(invoiceLineItems.sortOrder, invoiceLineItems.id)
    .all()
  const header = headerOf(db, row, lines)
  if (!header) return { status: 'withheld', reason: 'client-unavailable' }
  const client = getDirectoryRecordView(db, workspaceId, 'client', header.clientSyncId)
  if (client.lifecycle === 'missing') return { status: 'withheld', reason: 'requires-client' }
  let invoiceId: string
  try {
    invoiceId = invoiceSyncId(row.stripeInvoiceId)
  } catch (error) {
    return { status: 'withheld', reason: 'invalid-invoice', message: (error as Error).message }
  }
  const changes: SyncChange[] = []
  const existing = storedFacts<PortableInvoiceHeader>(db, workspaceId, 'invoice', [invoiceId])
  let headerChangeId: string
  if (existing.length) {
    headerChangeId = existing[0].id
  } else {
    const headerChange = fact(workspaceId, 'invoice', invoiceId, header, client.heads[PRESENT])
    headerChangeId = headerChange.id
    changes.push(headerChange)
    lines.forEach((line, index) =>
      changes.push(
        fact(
          workspaceId,
          'invoice-line',
          `${invoiceId}:${index}`,
          {
            version: 1,
            invoiceId,
            index,
            description: line.description.trim() ? line.description : 'Line item',
            amountCents: line.amountCents,
            lineDate: isDay(line.lineDate) ? line.lineDate : null,
            durationMinutes: line.durationMinutes
          } satisfies PortableInvoiceLine,
          [headerChangeId]
        )
      )
    )
  }
  let ranges: PortableBilledRange[]
  try {
    ranges = billedRangesOf(db, row)
  } catch (error) {
    return { status: 'withheld', reason: 'billing-unavailable', message: (error as Error).message }
  }
  // Frozen ranges whose work has not reached this computer yet (resumed elsewhere) are exported
  // as frozen; otherwise the only computer that saved the invoice would never share them.
  const known = new Set(ranges.map((range) => canonicalJson(range)))
  for (const range of operationRangesOf(db, row))
    if (!known.has(canonicalJson(range))) {
      known.add(canonicalJson(range))
      ranges.push(range)
    }
  const shared = new Set(
    storedFacts<PortableBillingReference>(db, workspaceId, 'billing-reference', [
      invoiceId
    ]).flatMap((reference) => reference.payload.ranges.map((range) => canonicalJson(range)))
  )
  const unshared = ranges.filter((range) => !shared.has(canonicalJson(range)))
  if (unshared.length)
    changes.push(
      fact(
        workspaceId,
        'billing-reference',
        invoiceId,
        { version: 1, invoiceId, ranges: unshared },
        [headerChangeId]
      )
    )
  if (!observationsOf(db, workspaceId, invoiceId).length)
    changes.push(
      fact(
        workspaceId,
        'provider-observation',
        invoiceId,
        cachedObservationOf(row, invoiceId, 'cached', null, []),
        [headerChangeId]
      )
    )
  try {
    changes.forEach((change) => validateInvoiceChange(change))
  } catch (error) {
    return { status: 'withheld', reason: 'invalid-invoice', message: (error as Error).message }
  }
  return {
    status: 'ready',
    changes: changes.filter((change) => !appliedChange(db, workspaceId, change.id))
  }
}

function intentChanges(
  db: Reader,
  workspaceId: string,
  operationId: string,
  only?: { record: 'step' | 'result' | 'rejection' | 'resolution'; name: string }
): SyncChange[] {
  const operation = db
    .select()
    .from(providerOperations)
    .where(eq(providerOperations.id, operationId))
    .get()
  if (!operation) return []
  const opChange = fact(
    workspaceId,
    'provider-intent',
    operationId,
    {
      version: 1,
      record: 'operation',
      operationId,
      kind: operation.kind as ProviderIntentKind,
      accountId: operation.accountId,
      testMode: !!operation.testMode,
      request: JSON.parse(operation.requestJson) as JsonObject
    },
    []
  )
  const changes = [opChange]
  const steps = db
    .select()
    .from(providerOperationSteps)
    .where(eq(providerOperationSteps.operationId, operationId))
    .all()
  const results = new Map(
    db
      .select()
      .from(providerOperationResults)
      .where(eq(providerOperationResults.operationId, operationId))
      .all()
      .map((row) => [row.name, row])
  )
  const rejections = new Map(
    db
      .select()
      .from(providerOperationRejections)
      .where(eq(providerOperationRejections.operationId, operationId))
      .all()
      .map((row) => [row.name, row])
  )
  const resolution = db
    .select()
    .from(providerOperationResolutions)
    .where(eq(providerOperationResolutions.operationId, operationId))
    .get()
  const rejectionIds = new Map<string, string>()
  const resultIds = new Map<string, string>()
  // A resolution depends on every fact its proof cites, so all of them are always built.
  const everything = !only || only.record === 'resolution'
  for (const step of steps.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!everything && only!.name !== step.name) continue
    const stepChange = fact(
      workspaceId,
      'provider-intent',
      operationId,
      {
        version: 1,
        record: 'step',
        operationId,
        name: step.name,
        request: JSON.parse(step.requestJson) as JsonObject,
        idempotencyKey: step.idempotencyKey,
        startedProviderAt: step.startedProviderAt
      },
      [opChange.id]
    )
    changes.push(stepChange)
    const result = results.get(step.name)
    if (result && only?.record !== 'step') {
      const resultChange = fact(
        workspaceId,
        'provider-intent',
        operationId,
        {
          version: 1,
          record: 'result',
          operationId,
          name: step.name,
          result: JSON.parse(result.resultJson) as JsonObject
        },
        [opChange.id, stepChange.id]
      )
      resultIds.set(step.name, resultChange.id)
      changes.push(resultChange)
    }
    const rejection = rejections.get(step.name)
    if (rejection && only?.record !== 'step') {
      const rejectionChange = fact(
        workspaceId,
        'provider-intent',
        operationId,
        {
          version: 1,
          record: 'rejection',
          operationId,
          name: step.name,
          proof: JSON.parse(rejection.proofJson) as JsonObject
        },
        [opChange.id, stepChange.id]
      )
      rejectionIds.set(step.name, rejectionChange.id)
      changes.push(rejectionChange)
    }
  }
  if (resolution && everything) {
    const proof = JSON.parse(resolution.proofJson) as unknown as PortableCancellationProof
    changes.push(
      fact(
        workspaceId,
        'provider-intent',
        operationId,
        {
          version: 1,
          record: 'resolution',
          operationId,
          resolution: 'cancelled',
          proof: proof as unknown as JsonObject
        },
        [
          opChange.id,
          ...proof.rejectedSteps.map((name) => rejectionIds.get(name) ?? ''),
          ...(proof.invoiceId ? [resultIds.get('invoice') ?? ''] : [])
        ]
      )
    )
  }
  return changes
}

function newIntentChanges(db: Reader, workspaceId: string, changes: SyncChange[]): SyncChange[] {
  changes.forEach((change) => validateInvoiceChange(change))
  return changes.filter((change) => !appliedChange(db, workspaceId, change.id))
}

export interface InvoiceExport {
  /** Dependencies first; record with journalInvoiceSyncChanges. */
  changes: SyncChange[]
  withheld: Array<
    | { invoiceId: number; reason: InvoiceWithheldReason; message?: string }
    | { operationId: string; reason: 'invalid-operation'; message: string }
  >
}

/** Bootstrap every saved invoice and retained provider operation not yet shared. */
export function collectInvoiceSyncChanges(db: Reader, workspaceId: string): InvoiceExport {
  const result: InvoiceExport = { changes: [], withheld: [] }
  const seen = new Set<string>()
  const add = (changes: SyncChange[]) => {
    for (const change of changes)
      if (!seen.has(change.id)) {
        seen.add(change.id)
        result.changes.push(change)
      }
  }
  for (const operation of db
    .select({ id: providerOperations.id })
    .from(providerOperations)
    .orderBy(providerOperations.id)
    .all()) {
    try {
      add(newIntentChanges(db, workspaceId, intentChanges(db, workspaceId, operation.id)))
    } catch (error) {
      result.withheld.push({
        operationId: operation.id,
        reason: 'invalid-operation',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
  for (const row of db.select({ id: invoices.id }).from(invoices).orderBy(invoices.id).all()) {
    const plan = planInvoiceExport(db, workspaceId, row.id)
    if (plan.status === 'ready') add(plan.changes)
    else result.withheld.push({ invoiceId: row.id, reason: plan.reason, message: plan.message })
  }
  return result
}

export function journalInvoiceSyncChanges<S extends Record<string, unknown>>(
  db: Db<S>,
  workspaceId: string,
  changes: readonly SyncChange[]
): string[] {
  if (!changes.length) return []
  return recordLocalSyncChanges(db, workspaceId, [...changes], invoiceRecordsAdapter)
}

/**
 * Call inside the transaction that saved (or attached billing to) a local invoice. Without a
 * workspace connection this is a no-op; a withheld invoice is exported later by collect.
 */
export function journalInvoiceRecords<S extends Record<string, unknown>>(
  db: Db<S>,
  localInvoiceId: number
): InvoicePlan | null {
  const workspaceId = historySyncWorkspace(db)
  if (!workspaceId) return null
  const plan = planInvoiceExport(db, workspaceId, localInvoiceId)
  if (plan.status === 'ready') journalInvoiceSyncChanges(db, workspaceId, plan.changes)
  return plan
}

/**
 * journalInvoiceRecords in a savepoint of the saving transaction. A journal failure never undoes
 * a local save that follows a completed Stripe write; collectInvoiceSyncChanges exports it later.
 */
export function journalInvoiceRecordsSafely<S extends Record<string, unknown>>(
  db: Db<S>,
  localInvoiceId: number
): InvoicePlan | null {
  try {
    return db.transaction((savepoint) =>
      journalInvoiceRecords(savepoint as unknown as AnyDb, localInvoiceId)
    )
  } catch {
    return null
  }
}

export interface ProviderObservationInput {
  providerInvoiceId: string
  /** The account and mode of the Stripe client that performed the successful read. */
  account: ProviderAccount
  /** Stripe's response Date header (any Date.parse format) or null when unavailable. */
  providerDate: string | null
  status: InvoiceStatus
}

/**
 * After a successful Stripe read: apply the status monotonically to the saved invoice and, with a
 * workspace, journal the observation (superseding the heads seen) in the same transaction. A
 * wrong-account read is rejected before anything changes.
 */
export function recordProviderObservation<S extends Record<string, unknown>>(
  db: Db<S>,
  input: ProviderObservationInput
): { changed: boolean; changeId: string | null } {
  const invoiceId = invoiceSyncId(input.providerInvoiceId)
  const providerDate = input.providerDate ? toInstant(input.providerDate) : null
  if (input.providerDate && !providerDate)
    throw new AppError('PROVIDER_TIME_UNAVAILABLE', 'Stripe returned an invalid response time.')
  return db.transaction((tx) => {
    const local = tx
      .select()
      .from(invoices)
      .where(eq(invoices.stripeInvoiceId, input.providerInvoiceId))
      .get()
    if (!local) return { changed: false, changeId: null }
    requireProviderAccount(input.account, {
      accountId: local.providerAccountId ?? input.account.accountId,
      testMode: !!local.testMode
    })
    if (input.status.invoiceId !== input.providerInvoiceId)
      throw new AppError(
        'PROVIDER_RESULT_CONFLICT',
        'The Stripe status belongs to another invoice.'
      )
    const observed = {
      status: input.status.status,
      amountDueCents: input.status.amountDueCents,
      amountPaidCents: input.status.amountPaidCents,
      currency: input.status.currency,
      hostedUrl: isStripeUrl(input.status.hostedUrl) ? input.status.hostedUrl : null,
      invoicePdf: isStripeUrl(input.status.invoicePdf) ? input.status.invoicePdf : null,
      dueDate: toInstant(input.status.dueDate),
      paidAt: toInstant(input.status.paidAt)
    }
    const workspaceId = historySyncWorkspace(tx)
    const database = tx as unknown as AnyDb
    if (!workspaceId) return { changed: applyStatus(tx, local, observed), changeId: null }
    const exported = planInvoiceExport(tx, workspaceId, local.id)
    if (exported.status === 'ready')
      journalInvoiceSyncChanges(database, workspaceId, exported.changes)
    const header = storedFacts<PortableInvoiceHeader>(tx, workspaceId, 'invoice', [invoiceId])[0]
    if (!header) return { changed: applyStatus(tx, local, observed), changeId: null }
    const view = providerObservationView(observationsOf(tx, workspaceId, invoiceId))
    const effective = view.effective
    if (
      effective &&
      effective.basis === 'retrieved' &&
      view.heads.length === 1 &&
      canonicalJson(statusColumns(effective)) === canonicalJson(observed)
    ) {
      const current = tx.select().from(invoices).where(eq(invoices.id, local.id)).get()!
      return { changed: applyStatus(tx, current, observed), changeId: null }
    }
    const payload: PortableProviderObservation = {
      version: 1,
      invoiceId,
      providerInvoiceId: input.providerInvoiceId,
      accountId: input.account.accountId,
      testMode: input.account.testMode,
      basis: 'retrieved',
      ...observed,
      providerDate,
      supersedes: view.heads
    }
    const change = fact(workspaceId, 'provider-observation', invoiceId, payload, [
      header.id,
      ...view.heads
    ])
    journalInvoiceSyncChanges(database, workspaceId, [change])
    return { changed: true, changeId: change.id }
  })
}

/**
 * Outgoing queue for retained provider operations (configureProviderOperationJournal). Each call
 * shares the retaining transaction through a savepoint; if the portable record cannot be written
 * the provider row still commits and collectInvoiceSyncChanges exports it later.
 */
export const providerIntentJournal: ProviderOperationJournal = {
  operation: (tx, row) => journalIntent(tx, row.id),
  step: (tx, row) => journalIntent(tx, row.operationId, { record: 'step', name: row.name }),
  result: (tx, row) => journalIntent(tx, row.operationId, { record: 'result', name: row.name }),
  rejection: (tx, row) =>
    journalIntent(tx, row.operationId, { record: 'rejection', name: row.name }),
  resolution: (tx, row) => journalIntent(tx, row.operationId, { record: 'resolution', name: '' })
}

function journalIntent(
  tx: AnyDb,
  operationId: string,
  only?: { record: 'step' | 'result' | 'rejection' | 'resolution'; name: string }
): void {
  const workspaceId = historySyncWorkspace(tx)
  if (!workspaceId) return
  try {
    tx.transaction((savepoint) => {
      const db = savepoint as unknown as AnyDb
      const changes = newIntentChanges(
        db,
        workspaceId,
        intentChanges(db, workspaceId, operationId, only)
      )
      journalInvoiceSyncChanges(db, workspaceId, changes)
    })
  } catch {
    // Exported by collectInvoiceSyncChanges; never lose a retained provider result.
  }
}

// ── Billing guard ──

/**
 * Every shared billed range as a local InvoiceBillingRange for unbilledSessions, whether or not
 * its session exists here yet (sessionId 0 excludes by client/project bucket and time). Invoice
 * hiding, voiding or deletion of history never removes a range.
 */
export function portableBilledRanges(db: Reader, testMode: boolean): InvoiceBillingRange[] {
  return [
    ...referencePortableRanges(db, testMode),
    ...operationPortableRanges(db, testMode)
  ].flatMap((range) => localBilledRanges(db, range))
}

function referencePortableRanges(db: Reader, testMode: boolean): PortableBilledRange[] {
  const references = db
    .select({ json: syncChanges.changeJson, workspaceId: syncChanges.workspaceId })
    .from(syncChanges)
    .where(eq(syncChanges.entityType, 'billing-reference'))
    .all()
  const ranges: PortableBilledRange[] = []
  for (const row of references) {
    const change = JSON.parse(row.json) as SyncChange
    const reference = change.payload as unknown as PortableBillingReference
    const header = storedFacts<PortableInvoiceHeader>(db, row.workspaceId, 'invoice', [
      reference.invoiceId
    ])[0]
    if (!header || header.payload.testMode !== testMode) continue
    ranges.push(...reference.ranges)
  }
  return ranges
}

/** Operations with a held shared conflict (for example a contradicted cancellation). */
/** A retained cancellation or provider result contradicted by shared facts needs review. */
export function providerIntentHasConflict(db: Reader, operationId: string): boolean {
  return db
    .select({ stateJson: syncRecordStates.stateJson })
    .from(syncRecordStates)
    .where(
      and(
        eq(syncRecordStates.entityType, 'provider-intent'),
        eq(syncRecordStates.entityId, operationId)
      )
    )
    .all()
    .some((row) => (JSON.parse(row.stateJson) as ProviderIntentState).conflicts.length > 0)
}

function heldOperations(db: Reader): Set<string> {
  return new Set(
    db
      .select()
      .from(syncRecordStates)
      .where(eq(syncRecordStates.entityType, 'provider-intent'))
      .all()
      .filter((row) => (JSON.parse(row.stateJson) as ProviderIntentState).conflicts.length)
      .map((row) => row.entityId)
  )
}

function operationPortableRanges(db: Reader, testMode: boolean): PortableBilledRange[] {
  const held = heldOperations(db)
  const ranges: PortableBilledRange[] = []
  for (const { operation, resolved } of db
    .select({ operation: providerOperations, resolved: providerOperationResolutions.operationId })
    .from(providerOperations)
    .leftJoin(
      providerOperationResolutions,
      eq(providerOperationResolutions.operationId, providerOperations.id)
    )
    .where(
      and(
        eq(providerOperations.kind, 'create-invoice'),
        eq(providerOperations.testMode, Number(testMode))
      )
    )
    .all()) {
    // A cancellation releases the work only while nothing known contradicts it.
    if (resolved && !held.has(operation.id)) continue
    try {
      ranges.push(
        ...readFrozenInvoiceRequest(JSON.parse(operation.requestJson)).billing.lines.flatMap(
          (line) => line.billed ?? []
        )
      )
    } catch {
      // Unreadable requests stay listed as unfinished and block their client instead.
    }
  }
  return ranges
}

/**
 * The frozen billed work of every retained create operation in this mode, whatever its account,
 * unless it was cancelled with proof of no effect that nothing known contradicts. An uncertain or
 * finished operation may hold a Stripe invoice whose local save (here or on another computer) has
 * not happened yet; its work stays excluded so a new draft, even with another account's key,
 * cannot bill it again.
 */
export function operationBilledRanges(db: Reader, testMode: boolean): InvoiceBillingRange[] {
  return operationPortableRanges(db, testMode).flatMap((range) => localBilledRanges(db, range))
}

/**
 * All shared or retained billed activity. A mapped fragment does not prove that every split
 * fragment has arrived; invoice-preflight holds overlapping unmapped work until its own
 * identity is available.
 */
export function activityBilledRanges(db: Reader, testMode: boolean): PortableBilledRange[] {
  return [
    ...referencePortableRanges(db, testMode),
    ...operationPortableRanges(db, testMode)
  ].filter((range) => range.anchor.kind === 'activity')
}

export interface InvoiceBillingBlocker {
  entityType: 'invoice' | 'provider-intent'
  entityId: string
  reason: InvoiceProjectionIssue | 'terminal-status-conflict' | 'provider-intent-conflict'
}

/** Held shared invoice records and conflicting operations for one client (or all clients). */
export function invoiceBillingBlockers(
  db: Reader,
  workspaceId: string,
  clientSyncId?: string
): InvoiceBillingBlocker[] {
  const blockers: InvoiceBillingBlocker[] = []
  for (const row of db
    .select()
    .from(syncRecordStates)
    .where(
      and(
        eq(syncRecordStates.workspaceId, workspaceId),
        inArray(syncRecordStates.entityType, ['invoice', 'provider-intent'])
      )
    )
    .all()) {
    if (row.entityType === 'invoice') {
      const state = JSON.parse(row.stateJson) as InvoiceRecordState
      if (clientSyncId) {
        const headers = storedFacts<PortableInvoiceHeader>(db, workspaceId, 'invoice', [
          row.entityId
        ])
        if (!headers.some((header) => header.payload.clientSyncId === clientSyncId)) continue
      }
      if (state.issue)
        blockers.push({ entityType: 'invoice', entityId: row.entityId, reason: state.issue })
      if (state.observation.terminalConflict)
        blockers.push({
          entityType: 'invoice',
          entityId: row.entityId,
          reason: 'terminal-status-conflict'
        })
    } else {
      const state = JSON.parse(row.stateJson) as ProviderIntentState
      if (!state.conflicts.length) continue
      if (clientSyncId) {
        const operation = db
          .select()
          .from(providerOperations)
          .where(eq(providerOperations.id, row.entityId))
          .get()
        const request = operation
          ? (JSON.parse(operation.requestJson) as { clientSyncId?: string })
          : null
        if (request?.clientSyncId && request.clientSyncId !== clientSyncId) continue
      }
      blockers.push({
        entityType: 'provider-intent',
        entityId: row.entityId,
        reason: 'provider-intent-conflict'
      })
    }
  }
  return blockers.sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0))
}

/** Call before creating an invoice: held or conflicting shared billing blocks that client. */
export function requireNoInvoiceBillingBlockers<S extends Record<string, unknown>>(
  db: Db<S>,
  clientSyncId: string
): void {
  const workspaceId = historySyncWorkspace(db)
  if (!workspaceId) return
  const blockers = invoiceBillingBlockers(db, workspaceId, clientSyncId)
  if (blockers.length)
    throw new AppError(
      'INVOICE_SYNC_BLOCKED',
      'Shared invoice history for this client needs review before creating another invoice.'
    )
}
