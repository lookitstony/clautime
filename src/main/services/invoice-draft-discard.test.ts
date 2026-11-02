// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { clients } from '../db/schema/clients'
import { invoices } from '../db/schema/invoices'
import {
  providerOperations,
  providerOperationSteps,
  providerOperationResults,
  providerOperationResolutions
} from '../db/schema/provider-operations'
import { syncChanges } from '../db/schema/folder-sync'
import { invoiceSyncId } from './folder-sync-invoice-records'
import { AppError } from '../../shared/types/ipc'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
let hasKey = true
const discardDraftInvoice = vi.fn()
const getInvoiceStatus = vi.fn()
const readStatusContext = vi.fn()

vi.mock('../db', () => ({ getDb: () => db }))
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('./session-service', () => ({ sessionService: { getReconciliationCases: () => [] } }))
vi.mock('./credential-service', () => ({
  credentialService: {
    isStripeTestMode: () => true,
    hasStripeKey: () => hasKey,
    getApiKey: () => null
  }
}))
vi.mock('./stripe-service', () => ({
  stripeService: {
    discardDraftInvoice: (...args: unknown[]) => discardDraftInvoice(...args),
    getInvoiceStatus: (...args: unknown[]) => getInvoiceStatus(...args),
    readStatusContext: () => readStatusContext()
  }
}))
vi.mock('./ai-service', () => ({
  aiService: { summarizeSessionGroup: vi.fn().mockResolvedValue(null) }
}))
const { invoiceService } = await import('./invoice-service')

const missing = () =>
  Object.assign(new Error('No such invoice'), { code: 'resource_missing', statusCode: 404 })

/** A saved ClauTime draft whose create operation finished in Stripe. */
function savedDraft(stripeInvoiceId = 'in_draft'): { localId: number; operationId: string } {
  const operationId = randomUUID()
  db.insert(providerOperations)
    .values({
      id: operationId,
      accountId: 'acct_x',
      testMode: 1,
      kind: 'create-invoice',
      requestJson: '{}'
    })
    .run()
  db.insert(providerOperationSteps)
    .values({
      operationId,
      name: 'invoice',
      requestJson: '{}',
      idempotencyKey: `key-${operationId}`,
      startedProviderAt: '2026-10-19T00:00:00.000Z'
    })
    .run()
  db.insert(providerOperationResults)
    .values({
      operationId,
      name: 'invoice',
      resultJson: JSON.stringify({ invoiceId: stripeInvoiceId })
    })
    .run()
  const localId = db
    .insert(invoices)
    .values({
      clientId: 1,
      stripeInvoiceId,
      operationId,
      testMode: 1,
      periodStart: '2026-10-12',
      periodEnd: '2026-10-18'
    })
    .returning()
    .get().id
  return { localId, operationId }
}

const row = (id: number) => db.select().from(invoices).where(eq(invoices.id, id)).get()
const share = (stripeInvoiceId: string) =>
  db
    .insert(syncChanges)
    .values({
      id: randomUUID(),
      workspaceId: 'w1',
      kind: 'fact',
      entityType: 'invoice',
      entityId: invoiceSyncId(stripeInvoiceId),
      changeJson: '{}',
      origin: 'imported',
      recordedAt: 'x'
    })
    .run()

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  db.insert(clients).values({ id: 1, name: 'Acme', color: '#000000' }).run()
  hasKey = true
  discardDraftInvoice.mockReset()
  getInvoiceStatus.mockReset()
  readStatusContext.mockReset().mockResolvedValue({ accountId: 'acct_x', testMode: true })
})
afterEach(() => sqlite.close())

describe('deleteInvoice', () => {
  it('discards a ClauTime draft in Stripe', async () => {
    const { localId } = savedDraft()
    await invoiceService.deleteInvoice(localId)
    expect(discardDraftInvoice).toHaveBeenCalledWith(localId, true)
  })

  it('hides a draft it cannot discard: no key, or shared through folder sync', async () => {
    hasKey = false
    const first = savedDraft('in_nokey').localId
    expect(invoiceService.getById(first)?.discardable).toBe(false)
    await invoiceService.deleteInvoice(first)
    hasKey = true
    const second = savedDraft('in_shared').localId
    share('in_shared')
    await invoiceService.deleteInvoice(second)
    expect(discardDraftInvoice).not.toHaveBeenCalled()
    expect([row(first)?.hidden, row(second)?.hidden]).toEqual([1, 1])
  })

  it('hides a draft that became shared while the discard ran', async () => {
    const { localId } = savedDraft()
    discardDraftInvoice.mockImplementationOnce(async () => {
      share('in_draft')
      throw new AppError('PROVIDER_OPERATION_NOT_CANCELLABLE', 'shared')
    })
    await invoiceService.deleteInvoice(localId)
    expect(row(localId)?.hidden).toBe(1)
  })

  it('succeeds when a concurrent discard already released the draft', async () => {
    const { localId, operationId } = savedDraft()
    discardDraftInvoice.mockImplementationOnce(async () => {
      db.delete(invoices).where(eq(invoices.id, localId)).run()
      db.insert(providerOperationResolutions)
        .values({ operationId, resolution: 'cancelled', proofJson: '{}' })
        .run()
      throw new AppError('PROVIDER_OPERATION_NOT_CANCELLABLE', 'changed')
    })
    await expect(invoiceService.deleteInvoice(localId)).resolves.toBeUndefined()
  })

  it('reports a Stripe failure without hiding the draft', async () => {
    const { localId } = savedDraft()
    discardDraftInvoice.mockRejectedValueOnce(new Error('offline'))
    await expect(invoiceService.deleteInvoice(localId)).rejects.toThrow('offline')
    expect(row(localId)?.hidden).toBe(0)
  })
})

describe('status sync', () => {
  it('releases a draft Stripe no longer has, and nothing on other read failures', async () => {
    const gone = savedDraft('in_gone').localId
    savedDraft('in_offline')
    getInvoiceStatus.mockImplementation(async (id: string) => {
      throw id === 'in_gone' ? missing() : new Error('offline')
    })
    await invoiceService.syncAllStatuses()
    expect(discardDraftInvoice.mock.calls).toEqual([[gone, false]])
  })

  it('reads the Stripe account once and skips invoices from the other mode', async () => {
    savedDraft('in_a')
    savedDraft('in_b')
    const live = savedDraft('in_live').localId
    db.update(invoices).set({ testMode: 0 }).where(eq(invoices.id, live)).run()
    getInvoiceStatus.mockRejectedValue(new Error('offline'))
    await invoiceService.syncAllStatuses()
    expect(readStatusContext).toHaveBeenCalledTimes(1)
    expect(getInvoiceStatus.mock.calls.map(([id]) => id).sort()).toEqual(['in_a', 'in_b'])
    expect(getInvoiceStatus.mock.calls[0][1]).toEqual({ accountId: 'acct_x', testMode: true })
  })

  it('returns null from a single sync of a draft deleted in Stripe', async () => {
    const { localId } = savedDraft()
    getInvoiceStatus.mockRejectedValueOnce(missing())
    expect(await invoiceService.syncStatus(localId)).toBeNull()
    expect(discardDraftInvoice).toHaveBeenCalledWith(localId, false)
  })
})

it('marks an overlapping ClauTime draft as discardable', () => {
  savedDraft()
  expect(invoiceService.checkOverlap(1, '2026-10-12', '2026-10-18')).toMatchObject([
    { stripeInvoiceId: 'in_draft', discardable: true }
  ])
})
