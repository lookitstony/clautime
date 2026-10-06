// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  providerOperations,
  providerOperationSteps,
  providerOperationResults,
  providerOperationRejections
} from '../db/schema/provider-operations'
import {
  configureProviderOperationJournal,
  definiteStripeRejection,
  executeProviderStep,
  providerAttemptName,
  readProviderRejectionProof,
  recordProviderResolution,
  retainProviderOperation,
  type ProviderOperation
} from './provider-operation-store'
import { removeProviderOperations } from '../db/migration-test-helpers'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
let operation: ProviderOperation
const account = { accountId: 'acct_fixture', testMode: true }
const start = '2026-09-28T02:00:00.000Z'
const migrationsFolder = join(__dirname, '../db/migrations')
beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
  operation = {
    id: randomUUID(),
    ...account,
    kind: 'create-invoice',
    request: { clientSyncId: randomUUID(), amount: 100 }
  }
  retainProviderOperation(db, operation)
})
afterEach(() => sqlite.close())
const context = () => Promise.resolve({ ...account, providerDate: start })
const step = () => ({
  operationId: operation.id,
  name: 'invoice',
  request: { amount: 100 },
  context
})

it('upgrades existing databases without inferring provider operations', () => {
  removeProviderOperations(sqlite)
  migrate(db, { migrationsFolder })
  expect(db.select().from(providerOperations).all()).toEqual([])
})

it('freezes requests and commits the attempt before contacting the provider', async () => {
  const write = vi.fn(async (key: string, body: unknown) => {
    expect(db.select().from(providerOperationSteps).get()).toMatchObject({
      idempotencyKey: key,
      requestJson: '{"amount":100}'
    })
    expect(body).toEqual({ amount: 100 })
    return { invoiceId: 'in_fixture' }
  })
  const saved = await executeProviderStep(db, { ...step(), write })
  expect(saved).toEqual({ invoiceId: 'in_fixture' })
  expect(
    await executeProviderStep(db, {
      ...step(),
      context: vi.fn(() => {
        throw Error('offline')
      }),
      write
    })
  ).toEqual(saved)
  expect(write).toHaveBeenCalledTimes(1)
  expect(() => retainProviderOperation(db, { ...operation, request: { amount: 200 } })).toThrow(
    /different saved request/
  )
  await expect(
    executeProviderStep(db, { ...step(), request: { amount: 200 }, write })
  ).rejects.toThrow(/different saved request/)
})

it('recovers success after a crash without another write even beyond the retry window', async () => {
  const write = vi.fn(async () => {
    throw Error('crash after remote success')
  })
  await expect(executeProviderStep(db, { ...step(), write })).rejects.toThrow('crash')
  expect(db.select().from(providerOperationResults).all()).toHaveLength(0)
  const recover = vi.fn(async () => ({ invoiceId: 'in_original' }))
  expect(
    await executeProviderStep(db, {
      ...step(),
      context: async () => ({ ...account, providerDate: '2026-10-01T02:00:00Z' }),
      recover,
      write
    })
  ).toEqual({ invoiceId: 'in_original' })
  expect(write).toHaveBeenCalledTimes(1)
})

it('reuses the same key and exact request inside the verified window', async () => {
  const keys: string[] = []
  const write = vi.fn(async (key: string) => {
    keys.push(key)
    if (keys.length === 1) throw Error('lost connection')
    return { invoiceId: 'in_original' }
  })
  await expect(executeProviderStep(db, { ...step(), write })).rejects.toThrow('lost connection')
  await executeProviderStep(db, { ...step(), recover: async () => null, write })
  expect(keys).toEqual([`clautime:${operation.id}:invoice`, `clautime:${operation.id}:invoice`])
})

it.each(['2026-09-29T01:00:00Z', '2026-09-20T00:00:00Z', 'unknown'])(
  'holds an uncertain attempt with unproven retry time %s',
  async (providerDate) => {
    const write = vi.fn(async () => {
      throw Error('lost connection')
    })
    await expect(executeProviderStep(db, { ...step(), write })).rejects.toThrow('lost connection')
    await expect(
      executeProviderStep(db, {
        ...step(),
        context: async () => ({ ...account, providerDate }),
        recover: async () => null,
        write
      })
    ).rejects.toMatchObject({
      code:
        providerDate === 'unknown' ? 'PROVIDER_TIME_UNAVAILABLE' : 'PROVIDER_OPERATION_UNCERTAIN'
    })
    expect(write).toHaveBeenCalledTimes(1)
  }
)

it('refreshes the provider clock after slow recovery rather than using an expired window', async () => {
  const write = vi.fn(async () => {
    throw Error('lost connection')
  })
  await expect(executeProviderStep(db, { ...step(), write })).rejects.toThrow('lost connection')
  const clock = vi
    .fn()
    .mockResolvedValueOnce({ ...account, providerDate: start })
    .mockResolvedValueOnce({ ...account, providerDate: '2026-09-30T02:00:00Z' })
  await expect(
    executeProviderStep(db, { ...step(), context: clock, recover: async () => null, write })
  ).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_UNCERTAIN' })
  expect(write).toHaveBeenCalledTimes(1)
})

it.each([
  { accountId: 'acct_other', testMode: true },
  { accountId: 'acct_fixture', testMode: false }
])('refuses a mismatched account/mode before recovery or writes', async (wrong) => {
  const write = vi.fn(async () => ({ invoiceId: 'in_wrong' }))
  const recover = vi.fn(async () => null)
  await expect(
    executeProviderStep(db, {
      ...step(),
      context: async () => ({ ...wrong, providerDate: start }),
      recover,
      write
    })
  ).rejects.toMatchObject({ code: 'STRIPE_ACCOUNT_MISMATCH' })
  expect(write).not.toHaveBeenCalled()
  expect(recover).not.toHaveBeenCalled()
  expect(db.select().from(providerOperationSteps).all()).toHaveLength(0)
})

it('serializes double clicks, but rejects a concurrent request with changed amounts', async () => {
  let finish!: (value: { invoiceId: string }) => void
  const write = vi.fn(
    () =>
      new Promise<{ invoiceId: string }>((resolve) => {
        finish = resolve
      })
  )
  const first = executeProviderStep(db, { ...step(), write })
  const second = executeProviderStep(db, { ...step(), write })
  const changed = executeProviderStep(db, { ...step(), request: { amount: 200 }, write }).catch(
    (error: unknown) => error
  )
  await Promise.resolve()
  finish({ invoiceId: 'in_once' })
  expect(await first).toEqual(await second)
  expect(await changed).toMatchObject({ code: 'PROVIDER_OPERATION_CONFLICT' })
  expect(write).toHaveBeenCalledTimes(1)
})

it('retains immutable requests and results for audit', async () => {
  await executeProviderStep(db, { ...step(), write: async () => ({ invoiceId: 'in_original' }) })
  for (const table of [
    'provider_operations',
    'provider_operation_steps',
    'provider_operation_results'
  ]) {
    expect(() => sqlite.exec(`DELETE FROM ${table}`)).toThrow('immutable')
  }
  expect(() =>
    sqlite.exec("UPDATE provider_operation_steps SET started_provider_at = '2030-01-01T00:00:00Z'")
  ).toThrow('immutable')
})

const stripeError = (statusCode: number, rawType: string, message = 'Invalid request') =>
  Object.assign(new Error(message), {
    rawType,
    statusCode,
    code: 'parameter_invalid',
    requestId: 'req_abc'
  })

describe('definite rejections', () => {
  it.each([
    [400, 'invalid_request_error', true],
    [404, 'invalid_request_error', true],
    [409, 'invalid_request_error', false],
    [400, 'idempotency_error', false],
    [429, 'rate_limit_error', false],
    [500, 'api_error', false],
    [402, 'card_error', false]
  ])('classifies status %s %s as definite: %s', (status, rawType, definite) => {
    expect(!!definiteStripeRejection(stripeError(status, rawType), start)).toBe(definite)
  })

  it('never classifies connection loss, app errors, or an unknown provider time', () => {
    expect(definiteStripeRejection(new Error('socket hang up'), start)).toBeNull()
    expect(
      definiteStripeRejection(
        Object.assign(new Error('mode'), { code: 'STRIPE_ACCOUNT_MISMATCH' }),
        start
      )
    ).toBeNull()
    expect(definiteStripeRejection(stripeError(400, 'invalid_request_error'), 'unknown')).toBeNull()
  })

  it('keeps credential-shaped text out of the proof and reads proofs strictly', () => {
    const proof = definiteStripeRejection(
      stripeError(400, 'invalid_request_error', 'Invalid API Key provided: sk_test_abc'),
      start
    )!
    expect(proof.message).toBe('Stripe rejected the request.')
    expect(readProviderRejectionProof(proof)).toEqual(proof)
    expect(() => readProviderRejectionProof({ ...proof, extra: 1 })).toThrow()
    expect(() => readProviderRejectionProof({ ...proof, statusCode: 500 })).toThrow()
  })

  it('records a rejection with its step, journals it, and never attempts the step again', async () => {
    const journal = {
      operation: vi.fn(),
      step: vi.fn(),
      result: vi.fn(),
      rejection: vi.fn(),
      resolution: vi.fn()
    }
    configureProviderOperationJournal(journal)
    try {
      const write = vi.fn(async () => {
        throw stripeError(400, 'invalid_request_error', 'No such customer')
      })
      await expect(executeProviderStep(db, { ...step(), write })).rejects.toMatchObject({
        code: 'PROVIDER_OPERATION_REJECTED'
      })
      expect(journal.rejection).toHaveBeenCalledTimes(1)
      const context = vi.fn(async () => ({ ...account, providerDate: start }))
      await expect(executeProviderStep(db, { ...step(), context, write })).rejects.toMatchObject({
        code: 'PROVIDER_OPERATION_REJECTED'
      })
      expect(write).toHaveBeenCalledTimes(1)
      expect(context).not.toHaveBeenCalled()
      // A rejected step can never also complete, whoever tries to record it.
      expect(() =>
        sqlite
          .prepare('INSERT INTO provider_operation_results VALUES (?, ?, ?)')
          .run(operation.id, 'invoice', '{"invoiceId":"in_late"}')
      ).toThrow('rejected')
      expect(() => sqlite.exec('DELETE FROM provider_operation_rejections')).toThrow('immutable')
    } finally {
      configureProviderOperationJournal(null)
    }
  })

  it('keeps an earlier lost attempt uncertain when a later retry is rejected before replay', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost connection'))
      .mockRejectedValueOnce(stripeError(400, 'invalid_request_error'))
    await expect(executeProviderStep(db, { ...step(), write })).rejects.toThrow('lost connection')
    await expect(
      executeProviderStep(db, {
        ...step(),
        context: async () => ({ ...account, providerDate: '2026-09-28T05:00:00.000Z' }),
        recover: async () => null,
        write
      })
    ).rejects.toMatchObject({ rawType: 'invalid_request_error' })
    expect(db.select().from(providerOperationRejections).all()).toEqual([])
  })

  it('a recorded cancellation stops every step before any provider read or write', async () => {
    recordProviderResolution(db, operation.id, { version: 1 })
    const context = vi.fn(async () => ({ ...account, providerDate: start }))
    const write = vi.fn(async () => ({ invoiceId: 'in_x' }))
    await expect(executeProviderStep(db, { ...step(), context, write })).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_CANCELLED'
    })
    expect(context).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('stops an attempt when a cancellation is recorded while it awaited Stripe', async () => {
    const write = vi.fn(async () => ({ invoiceId: 'in_x' }))
    const context = vi.fn(async () => {
      recordProviderResolution(db, operation.id, { version: 1 })
      return { ...account, providerDate: start }
    })
    await expect(executeProviderStep(db, { ...step(), context, write })).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_CANCELLED'
    })
    expect(write).not.toHaveBeenCalled()
    expect(db.select().from(providerOperationSteps).all()).toEqual([])
  })

  it('names a new attempt only after every earlier attempt was definitely rejected', async () => {
    expect(providerAttemptName(db, operation.id, 'send')).toBe('send')
    const write = vi.fn(async () => {
      throw stripeError(400, 'invalid_request_error')
    })
    await expect(executeProviderStep(db, { ...step(), name: 'send', write })).rejects.toThrow()
    expect(providerAttemptName(db, operation.id, 'send')).toBe('send-2')
    await expect(
      executeProviderStep(db, {
        ...step(),
        name: 'send-2',
        write: async () => {
          throw new Error('lost')
        }
      })
    ).rejects.toThrow('lost')
    // The uncertain second attempt stays the live one: no third key.
    expect(providerAttemptName(db, operation.id, 'send')).toBe('send-2')
  })
})
