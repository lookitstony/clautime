// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { invoices } from '../db/schema/invoices'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { sessionBillingRefs } from '../db/schema/session-history'
import { AppError } from '../../shared/types/ipc'
import type { CreatedDraft, ProviderStatusRead } from '../services/stripe-operation-service'
import { portableBillingFromLocal } from '../services/invoice-portable-billing'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('../db', () => ({ getDb: () => db }))
vi.mock('../services/credential-service', () => ({
  credentialService: { isStripeTestMode: () => true }
}))
const createDraftInvoice = vi.fn()
const sendInvoice = vi.fn()
vi.mock('../services/stripe-service', () => ({
  stripeService: {
    createDraftInvoice: (...args: unknown[]) => createDraftInvoice(...args),
    sendInvoice: (...args: unknown[]) => sendInvoice(...args)
  },
  clearStripeCache: vi.fn()
}))
const saveInvoice = vi.fn()
vi.mock('../services/invoice-service', () => ({
  invoiceService: { saveInvoice: (...args: unknown[]) => saveInvoice(...args) }
}))

const { registerInvoiceHandlers, persistDraft } = await import('./invoice-handlers')

const account = { accountId: 'acct_fixture', testMode: true }
const entryId = randomUUID()
const clientSyncId = randomUUID()
let created: CreatedDraft

function status(overrides: Partial<ProviderStatusRead['status']> = {}): ProviderStatusRead {
  return {
    account,
    providerDate: 'Mon, 28 Sep 2026 02:00:00 GMT',
    status: {
      invoiceId: 'in_fixture',
      status: 'open',
      amountDueCents: 2500,
      // A resumed invoice already partially paid in Stripe must not be saved as unpaid.
      amountPaidCents: 1000,
      currency: 'usd',
      hostedUrl: null,
      invoicePdf: null,
      dueDate: '2026-10-28T00:00:00.000Z',
      paidAt: null,
      ...overrides
    }
  }
}

beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite)
  sqlite.pragma('foreign_keys = ON')
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  db.insert(clients)
    .values({ id: 7, syncId: clientSyncId, name: 'Fixture', color: '#112233' })
    .run()
  db.insert(clients).values({ id: 8, syncId: randomUUID(), name: 'Other', color: '#112233' }).run()
  db.insert(projects).values({ id: 3, clientId: 7, name: 'Site' }).run()
  db.insert(sessions)
    .values({
      id: 5,
      projectPath: '',
      startedAt: '2026-09-02T10:00:00.000Z',
      endedAt: '2026-09-02T10:30:00.000Z',
      durationMinutes: 30,
      clientId: 7,
      projectId: 3
    })
    .run()
  // A real stable identity: the frozen request names the manual entry UUID, not row 5.
  db.insert(manualTimeEntries).values({ id: entryId, sessionId: 5, basis: 'created' }).run()
  const localBilling = {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    lines: [{ lineDate: '2026-09-02', durationMinutes: 30, sessionIds: [5], billedRanges: null }]
  }
  created = {
    account,
    draft: {
      invoiceId: 'in_fixture',
      stripeCustomerId: 'cus_fixture',
      status: 'open',
      amountDueCents: 2500,
      currency: 'usd',
      hostedUrl: null,
      invoicePdf: null,
      createdAt: '2026-09-28T02:00:00.000Z'
    },
    frozen: {
      version: 2,
      clientSyncId,
      customer: { email: 'billing@acme.test', name: 'Acme' },
      daysUntilDue: 30,
      achOnly: false,
      description: 'Frozen memo',
      currency: 'usd',
      lines: [
        {
          step: 'item-0',
          description: 'Fixed fee',
          amountCents: 2500,
          quantityDecimal: null,
          unitAmountDecimal: null
        }
      ],
      billing: portableBillingFromLocal(db, localBilling)
    },
    localBilling,
    observation: status()
  }
  handlers.clear()
  registerInvoiceHandlers()
  createDraftInvoice.mockReset().mockResolvedValue(created)
  sendInvoice.mockReset()
  saveInvoice.mockReset()
})

afterEach(() => sqlite.close())

const request = { operationId: randomUUID(), clientId: 7, lineItems: [], memo: 'renderer memo' }
const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)

it('freezes the manual entry identity, never the local row number', () => {
  expect(created.frozen.billing.lines[0].billed).toEqual([
    expect.objectContaining({ anchor: { kind: 'manual', entryId } })
  ])
  expect(JSON.stringify(created.frozen)).not.toMatch(/sessionId|"clientId"|"projectId"/)
})

it('saves the retained request and full retrieved status; a retry resumes after a local failure', async () => {
  saveInvoice.mockImplementationOnce(() => {
    throw new Error('disk full')
  })
  expect(await invoke('invoice:createDraftInvoice', request)).toMatchObject({ success: false })
  saveInvoice.mockImplementationOnce(() => 41)
  expect(await invoke('invoice:createDraftInvoice', request)).toEqual({
    success: true,
    data: { ...created.draft, localId: 41 }
  })
  expect(createDraftInvoice).toHaveBeenCalledTimes(2)
  expect(saveInvoice).toHaveBeenLastCalledWith(
    expect.objectContaining({
      clientId: 7,
      stripeInvoiceId: 'in_fixture',
      memo: 'Frozen memo',
      testMode: true,
      status: 'open',
      amountPaidCents: 1000,
      dueDate: '2026-10-28T00:00:00.000Z',
      providerAccountId: 'acct_fixture',
      operationId: request.operationId,
      lineItems: [
        expect.objectContaining({
          amountCents: 2500,
          sessionIds: [5],
          billedRanges: [expect.objectContaining({ sessionId: 5, clientId: 7, projectId: 3 })],
          sortOrder: 0
        })
      ]
    }),
    expect.anything()
  )
})

it('resolves the frozen identity after the row was remapped while Stripe ran', () => {
  // Same manual entry, new local row (e.g. rebuilt on this computer).
  db.insert(sessions)
    .values({
      id: 6,
      projectPath: '',
      startedAt: '2026-09-02T10:00:00.000Z',
      endedAt: '2026-09-02T10:30:00.000Z',
      durationMinutes: 30,
      clientId: 7,
      projectId: 3
    })
    .run()
  // The identity itself is immutable; a restore replaces the local mapping row instead.
  expect(() =>
    db
      .update(manualTimeEntries)
      .set({ sessionId: 6 })
      .where(eq(manualTimeEntries.id, entryId))
      .run()
  ).toThrow(/immutable/)
  db.delete(manualTimeEntries).where(eq(manualTimeEntries.id, entryId)).run()
  db.insert(manualTimeEntries).values({ id: entryId, sessionId: 6, basis: 'imported' }).run()
  saveInvoice.mockImplementationOnce(() => 41)
  persistDraft(7, created, request.operationId)
  const saved = saveInvoice.mock.calls[0][0] as { lineItems: Array<{ sessionIds: number[] }> }
  expect(saved.lineItems[0].sessionIds).toEqual(expect.arrayContaining([5, 6]))
})

it('attaches billing to an invoice imported before the local save, without a raw status overwrite', () => {
  sqlite.exec(
    "INSERT INTO invoices (id, client_id, stripe_invoice_id, status, test_mode, created_at, updated_at) VALUES (9, 7, 'in_fixture', 'draft', 1, 'x', 'x')"
  )
  expect(persistDraft(7, created, request.operationId)).toBe(9)
  expect(saveInvoice).not.toHaveBeenCalled()
  const row = db.select().from(invoices).where(eq(invoices.id, 9)).get()!
  expect(row).toMatchObject({
    operationId: request.operationId,
    providerAccountId: 'acct_fixture',
    status: 'open',
    amountPaidCents: 1000
  })
  expect(db.select().from(sessionBillingRefs).all()).toMatchObject([
    {
      sessionId: 5,
      stripeInvoiceId: 'in_fixture',
      billedRanges: [
        expect.objectContaining({ sessionId: 5, startedAt: '2026-09-02T10:00:00.000Z' })
      ]
    }
  ])
  expect(() => persistDraft(8, created, request.operationId)).toThrow(/different client/)
})

it('never regresses an imported paid invoice with a stale read', async () => {
  sqlite.exec(
    "INSERT INTO invoices (id, client_id, stripe_invoice_id, provider_account_id, status, amount_paid_cents, test_mode, created_at, updated_at) VALUES (9, 7, 'in_fixture', 'acct_fixture', 'paid', 2500, 1, 'x', 'x')"
  )
  saveInvoice.mockImplementation(() => {
    throw new Error('must not save twice')
  })
  expect(persistDraft(7, created, request.operationId)).toBe(9)
  sendInvoice.mockResolvedValueOnce(status())
  expect(await invoke('invoice:sendInvoice', 'in_fixture')).toMatchObject({
    success: true,
    data: { status: 'open' }
  })
  expect(db.select().from(invoices).where(eq(invoices.id, 9)).get()).toMatchObject({
    status: 'paid',
    amountPaidCents: 2500
  })
})

it('rejects a wrong-account read before changing the saved invoice', async () => {
  sqlite.exec(
    "INSERT INTO invoices (id, client_id, stripe_invoice_id, provider_account_id, status, test_mode, created_at, updated_at) VALUES (9, 7, 'in_fixture', 'acct_original', 'open', 1, 'x', 'x')"
  )
  sendInvoice.mockResolvedValueOnce(status({ status: 'void' }))
  expect(await invoke('invoice:sendInvoice', 'in_fixture')).toMatchObject({ success: false })
  expect(db.select().from(invoices).where(eq(invoices.id, 9)).get()!.status).toBe('open')
})

it('keeps operation error codes for the renderer', async () => {
  createDraftInvoice.mockRejectedValueOnce(
    new AppError('PROVIDER_OPERATION_UNCERTAIN', 'Review the existing operation')
  )
  expect(await invoke('invoice:createDraftInvoice', request)).toEqual({
    success: false,
    error: { code: 'PROVIDER_OPERATION_UNCERTAIN', message: 'Review the existing operation' }
  })
})
