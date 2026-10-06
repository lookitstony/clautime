import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  providerOperations,
  providerOperationSteps,
  providerOperationResults,
  providerOperationRejections,
  providerOperationResolutions
} from '../db/schema/provider-operations'
import { AppError } from '../../shared/types/ipc'
import {
  assertJson,
  canonicalJson,
  isSyncUuid,
  SYNC_LIMITS,
  type JsonObject
} from './folder-sync-protocol'

export interface ProviderAccount {
  accountId: string
  testMode: boolean
}

export interface ProviderOperation extends ProviderAccount {
  id: string
  kind: 'create-invoice' | 'send-invoice' | 'void-invoice' | 'sync-customer'
  /** Validated domain payload with portable references; never API credentials. */
  request: JsonObject
}

function frozenJson(value: JsonObject): string {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AppError(
      'INVALID_PROVIDER_OPERATION',
      'A provider request or result must be a plain object.'
    )
  assertJson(value)
  const json = canonicalJson(value)
  if (Buffer.byteLength(json) > SYNC_LIMITS.maxBatchBytes)
    throw new AppError(
      'INVALID_PROVIDER_OPERATION',
      'The provider operation exceeds the supported size.'
    )
  return json
}

/** A drizzle transaction; it supports nested transactions (savepoints) like the database. */
type Transaction = BetterSQLite3Database<Record<string, unknown>>

/**
 * Optional outgoing-queue hook (folder-sync-invoice-records' providerIntentJournal). Each call
 * runs inside the transaction that inserts the row, so a retained operation, step or result and
 * its sync change commit together. Imports write the tables directly and never reach this hook.
 */
export interface ProviderOperationJournal {
  operation(tx: Transaction, row: typeof providerOperations.$inferSelect): void
  step(tx: Transaction, row: typeof providerOperationSteps.$inferSelect): void
  result(tx: Transaction, row: typeof providerOperationResults.$inferSelect): void
  rejection(tx: Transaction, row: typeof providerOperationRejections.$inferSelect): void
  resolution(tx: Transaction, row: typeof providerOperationResolutions.$inferSelect): void
}

let journal: ProviderOperationJournal | null = null

/** Root wiring: enable (or with null, disable) the portable intent journal. */
export function configureProviderOperationJournal(value: ProviderOperationJournal | null): void {
  journal = value
}

export function requireProviderAccount(actual: ProviderAccount, expected: ProviderAccount): void {
  if (actual.accountId !== expected.accountId || actual.testMode !== expected.testMode)
    throw new AppError(
      'STRIPE_ACCOUNT_MISMATCH',
      'This action needs the Stripe account and test/live mode saved with the invoice.'
    )
}

/** A retry cannot silently change the customer, amount, scope, or operation. */
export function retainProviderOperation<T extends Record<string, unknown>>(
  db: BetterSQLite3Database<T>,
  operation: ProviderOperation
): void {
  if (!isSyncUuid(operation.id) || !/^acct_[a-zA-Z0-9]+$/.test(operation.accountId))
    throw new AppError(
      'INVALID_PROVIDER_OPERATION',
      'A stable operation and Stripe account are required'
    )
  const row = {
    id: operation.id,
    accountId: operation.accountId,
    testMode: operation.testMode ? 1 : 0,
    kind: operation.kind,
    requestJson: frozenJson(operation.request)
  }
  db.transaction((tx) => {
    const existing = tx
      .select()
      .from(providerOperations)
      .where(eq(providerOperations.id, row.id))
      .get()
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(row))
        throw new AppError(
          'PROVIDER_OPERATION_CONFLICT',
          'This operation already has a different saved request.'
        )
      return
    }
    tx.insert(providerOperations).values(row).run()
    journal?.operation(tx as unknown as Transaction, row)
  })
}

// ── Definite rejections and explicit resolutions ──

export interface ProviderRejectionProof {
  version: 1
  provider: 'stripe'
  type: 'invalid_request_error'
  statusCode: 400 | 404
  code: string | null
  param: string | null
  requestId: string | null
  message: string
  /** Stripe's Date from the account read immediately before the attempt; never a local clock. */
  attemptedProviderAt: string
}

const REJECTION_KEYS = [
  'version',
  'provider',
  'type',
  'statusCode',
  'code',
  'param',
  'requestId',
  'message',
  'attemptedProviderAt'
]
const CREDENTIAL = /\b(sk|rk|pk)_(live|test)_|\bwhsec_|\bsk-ant-|\bBearer\s/i

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || !value.isWellFormed()) return null
  const text = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, max)
  return text && !CREDENTIAL.test(text) ? text : null
}

/**
 * Stripe's answer that it refused the request itself: an `invalid_request_error` with status 400
 * or 404. Stripe does not save an idempotent result for a request that fails validation and a
 * request that fails makes no change, so the step had no effect under its key: an earlier
 * successful attempt with the same key and body would have been replayed instead. Everything else
 * (connection loss, 5xx, 409 key/lock conflicts, 429, idempotency_error, errors thrown by this app
 * after Stripe answered) stays uncertain.
 */
export function definiteStripeRejection(
  error: unknown,
  attemptedProviderAt: string
): ProviderRejectionProof | null {
  if (!error || typeof error !== 'object') return null
  const e = error as Record<string, unknown>
  if (e.rawType !== 'invalid_request_error' || (e.statusCode !== 400 && e.statusCode !== 404))
    return null
  const at = Date.parse(attemptedProviderAt)
  if (!Number.isFinite(at)) return null
  return {
    version: 1,
    provider: 'stripe',
    type: 'invalid_request_error',
    statusCode: e.statusCode,
    code: typeof e.code === 'string' && /^[a-z0-9_]{1,100}$/.test(e.code) ? e.code : null,
    param: boundedText(e.param, 200),
    requestId:
      typeof e.requestId === 'string' && /^req_[A-Za-z0-9]{1,100}$/.test(e.requestId)
        ? e.requestId
        : null,
    message: boundedText(e.message, 500) ?? 'Stripe rejected the request.',
    attemptedProviderAt: new Date(at).toISOString()
  }
}

/** Strict allowlist of a stored or imported rejection proof. */
export function readProviderRejectionProof(value: unknown): ProviderRejectionProof {
  const invalid = (): never => {
    throw new AppError('INVALID_PROVIDER_OPERATION', 'Invalid provider rejection proof')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const proof = value as Record<string, unknown>
  const keys = Object.keys(proof)
  if (
    keys.length !== REJECTION_KEYS.length ||
    !REJECTION_KEYS.every((key) => Object.hasOwn(proof, key))
  )
    invalid()
  const nullableText = (item: unknown, max: number) =>
    item === null || (typeof item === 'string' && boundedText(item, max) === item)
  if (
    proof.version !== 1 ||
    proof.provider !== 'stripe' ||
    proof.type !== 'invalid_request_error' ||
    (proof.statusCode !== 400 && proof.statusCode !== 404) ||
    !(
      proof.code === null ||
      (typeof proof.code === 'string' && /^[a-z0-9_]{1,100}$/.test(proof.code))
    ) ||
    !nullableText(proof.param, 200) ||
    !(
      proof.requestId === null ||
      (typeof proof.requestId === 'string' && /^req_[A-Za-z0-9]{1,100}$/.test(proof.requestId))
    ) ||
    typeof proof.message !== 'string' ||
    boundedText(proof.message, 500) !== proof.message ||
    typeof proof.attemptedProviderAt !== 'string' ||
    !Number.isFinite(Date.parse(proof.attemptedProviderAt)) ||
    new Date(Date.parse(proof.attemptedProviderAt)).toISOString() !== proof.attemptedProviderAt
  )
    invalid()
  return proof as unknown as ProviderRejectionProof
}

export function providerStepRejection<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  operationId: string,
  name: string
): ProviderRejectionProof | null {
  const row = db
    .select()
    .from(providerOperationRejections)
    .where(
      and(
        eq(providerOperationRejections.operationId, operationId),
        eq(providerOperationRejections.name, name)
      )
    )
    .get()
  return row ? (JSON.parse(row.proofJson) as ProviderRejectionProof) : null
}

export function providerOperationResolution<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  operationId: string
): typeof providerOperationResolutions.$inferSelect | null {
  return (
    db
      .select()
      .from(providerOperationResolutions)
      .where(eq(providerOperationResolutions.operationId, operationId))
      .get() ?? null
  )
}

/** Attempts of one repeatable step; also bounded by the import validation. */
export const MAX_ATTEMPTS = 20

function rejectedError(proof: ProviderRejectionProof, kind: string): AppError {
  return new AppError(
    'PROVIDER_OPERATION_REJECTED',
    kind === 'create-invoice'
      ? `Stripe rejected this saved invoice: ${proof.message} Its amounts cannot change; cancel the unfinished draft, then edit it and create a new one.`
      : `Stripe rejected this request: ${proof.message} Nothing was changed. Fix it in Stripe, then try again.`
  )
}

/**
 * The live attempt of a repeatable step (finalize, send, void): `base`, then `base-2`... A later
 * attempt with a fresh key starts only after Stripe definitely rejected every earlier one, so an
 * uncertain attempt (possible email) is never followed by another key.
 */
export function providerAttemptName<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  operationId: string,
  base: 'finalize' | 'send' | 'void'
): string {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const name = attempt === 1 ? base : `${base}-${attempt}`
    if (!providerStepRejection(db, operationId, name)) return name
  }
  throw new AppError(
    'PROVIDER_OPERATION_REJECTED',
    'Stripe rejected this action too many times. Review the invoice in Stripe.'
  )
}

function requireUnresolved<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  operationId: string
): void {
  if (providerOperationResolution(db, operationId))
    throw new AppError(
      'PROVIDER_OPERATION_CANCELLED',
      'This invoice operation was cancelled after Stripe rejected it. Create a new draft instead.'
    )
}

/**
 * Record an explicit cancellation. Callers must have proven that the operation left no effect
 * (invoice-operation-resolution); the store only guarantees a single immutable resolution.
 */
export function recordProviderResolution<S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  operationId: string,
  proof: JsonObject
): void {
  const row = { operationId, resolution: 'cancelled' as const, proofJson: frozenJson(proof) }
  db.transaction((tx) => {
    if (!tx.select().from(providerOperations).where(eq(providerOperations.id, operationId)).get())
      throw new AppError(
        'INVOICE_OPERATION_NOT_FOUND',
        'This saved invoice operation is unavailable.'
      )
    // Already cancelled (here or imported): the first proof stands.
    if (providerOperationResolution(tx, operationId)) return
    tx.insert(providerOperationResolutions).values(row).run()
    journal?.resolution(tx as unknown as Transaction, row)
  })
}

// A safety margin below Stripe's documented minimum 24-hour idempotency retention.
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000
const inFlight = new WeakMap<object, Map<string, Promise<JsonObject>>>()

export interface ProviderStep<T extends JsonObject> {
  operationId: string
  name: string
  request: JsonObject
  /** Fresh read using the captured credential/client, including its server response Date. */
  context(): Promise<ProviderAccount & { providerDate: string }>
  /** Positive proof only. A missing search/list result never proves a write did not happen. */
  recover?(): Promise<T | null>
  /** Invoked only by an explicit user action, never by a sync import. */
  write(idempotencyKey: string, request: JsonObject): Promise<T>
}

/**
 * Persist the exact step before its remote write, then retain the result before returning.
 * Missing results remain uncertain after a crash. A retry either positively recovers the
 * provider object, reuses the frozen key within its proven window, or requires review.
 */
export async function executeProviderStep<T extends JsonObject, S extends Record<string, unknown>>(
  db: BetterSQLite3Database<S>,
  step: ProviderStep<T>
): Promise<T> {
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(step.name))
    throw new AppError('INVALID_PROVIDER_OPERATION', 'Invalid provider step name')
  const requestJson = frozenJson(step.request)
  const operation = db
    .select()
    .from(providerOperations)
    .where(eq(providerOperations.id, step.operationId))
    .get()
  if (!operation)
    throw new AppError(
      'PROVIDER_OPERATION_REQUIRED',
      'Save the invoice operation before contacting Stripe.'
    )
  const condition = and(
    eq(providerOperationSteps.operationId, step.operationId),
    eq(providerOperationSteps.name, step.name)
  )
  const resultCondition = and(
    eq(providerOperationResults.operationId, step.operationId),
    eq(providerOperationResults.name, step.name)
  )
  const existing = db.select().from(providerOperationSteps).where(condition).get()
  if (existing && existing.requestJson !== requestJson)
    throw new AppError(
      'PROVIDER_OPERATION_CONFLICT',
      'This provider step already has a different saved request.'
    )
  const saved = db.select().from(providerOperationResults).where(resultCondition).get()
  if (saved) return JSON.parse(saved.resultJson) as T
  requireUnresolved(db, step.operationId)
  const rejected = providerStepRejection(db, step.operationId, step.name)
  if (rejected) throw rejectedError(rejected, operation.kind)

  let running = inFlight.get(db)
  if (!running) {
    running = new Map()
    inFlight.set(db, running)
  }
  // Waiters recheck the frozen body before returning the retained result.
  const key = `${step.operationId}:${step.name}`
  const active = running.get(key)
  if (active) {
    await active
    return executeProviderStep(db, step)
  }
  const work = async (): Promise<T> => {
    const context = await step.context()
    requireProviderAccount(context, {
      accountId: operation.accountId,
      testMode: !!operation.testMode
    })
    const now = Date.parse(context.providerDate)
    if (!Number.isFinite(now))
      throw new AppError(
        'PROVIDER_TIME_UNAVAILABLE',
        'Stripe did not provide a valid response time. Retry the account check.'
      )
    // Re-read after awaiting the network: another explicit operation may have committed.
    const previous = db.select().from(providerOperationSteps).where(condition).get()
    if (previous && previous.requestJson !== requestJson)
      throw new AppError(
        'PROVIDER_OPERATION_CONFLICT',
        'This provider step already has a different saved request.'
      )
    const completed = db.select().from(providerOperationResults).where(resultCondition).get()
    if (completed) return JSON.parse(completed.resultJson) as T
    requireUnresolved(db, step.operationId)
    const rejectedMeanwhile = providerStepRejection(db, step.operationId, step.name)
    if (rejectedMeanwhile) throw rejectedError(rejectedMeanwhile, operation.kind)
    const retainResult = (value: T): T => {
      const resultJson = frozenJson(value)
      db.transaction((tx) => {
        const retained = tx.select().from(providerOperationResults).where(resultCondition).get()
        if (retained && retained.resultJson !== resultJson)
          throw new AppError(
            'PROVIDER_RESULT_CONFLICT',
            'This operation has conflicting provider results. Review the saved invoice.'
          )
        if (!retained) {
          const row = { operationId: step.operationId, name: step.name, resultJson }
          tx.insert(providerOperationResults).values(row).run()
          journal?.result(tx as unknown as Transaction, row)
        }
      })
      return value
    }
    let attemptedAt = context.providerDate
    if (previous) {
      const recovered = await step.recover?.()
      if (recovered) return retainResult(recovered)
      // Recovery can paginate slowly. Refresh the server clock immediately before retry.
      const retryContext = await step.context()
      requireProviderAccount(retryContext, {
        accountId: operation.accountId,
        testMode: !!operation.testMode
      })
      const age = Date.parse(retryContext.providerDate) - Date.parse(previous.startedProviderAt)
      if (!Number.isFinite(age) || age < 0 || age >= RETRY_WINDOW_MS)
        throw new AppError(
          'PROVIDER_OPERATION_UNCERTAIN',
          'Stripe may have completed this action. Its retry window cannot be verified; review the existing operation before making another invoice or sending another email.'
        )
      attemptedAt = retryContext.providerDate
    }
    // Synchronously adjacent to the write: a cancellation or rejection recorded while this
    // attempt awaited Stripe stops it before another request is sent.
    requireUnresolved(db, step.operationId)
    const rejectedLate = providerStepRejection(db, step.operationId, step.name)
    if (rejectedLate) throw rejectedError(rejectedLate, operation.kind)
    const idempotencyKey = previous?.idempotencyKey ?? `clautime:${step.operationId}:${step.name}`
    if (!previous) {
      const row = {
        operationId: step.operationId,
        name: step.name,
        requestJson,
        idempotencyKey,
        startedProviderAt: new Date(now).toISOString()
      }
      db.transaction((tx) => {
        tx.insert(providerOperationSteps).values(row).run()
        journal?.step(tx as unknown as Transaction, row)
      })
    }
    let value: T
    try {
      value = await step.write(idempotencyKey, JSON.parse(requestJson) as JsonObject)
    } catch (error) {
      // Validation can run before Stripe's idempotency layer. A refusal on a later attempt
      // cannot prove that an earlier lost response had no effect, even inside the retry window.
      const proof = previous ? null : definiteStripeRejection(error, attemptedAt)
      if (!proof) throw error
      const row = {
        operationId: step.operationId,
        name: step.name,
        proofJson: frozenJson(proof as unknown as JsonObject)
      }
      db.transaction((tx) => {
        if (tx.select().from(providerOperationResults).where(resultCondition).get()) return
        if (providerStepRejection(tx, step.operationId, step.name)) return
        tx.insert(providerOperationRejections).values(row).run()
        journal?.rejection(tx as unknown as Transaction, row)
      })
      throw rejectedError(proof, operation.kind)
    }
    return retainResult(value)
  }
  const promise = work()
  running.set(key, promise)
  try {
    return await promise
  } finally {
    running.delete(key)
  }
}
