import { manualTimeEntries } from '../db/schema/manual-time-entries'
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type Stripe from 'stripe'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { invoices, clientProviderReferences } from '../db/schema/invoices'
import { sessionBillingRefs } from '../db/schema/session-history'
import { providerOperationResults, providerOperationSteps } from '../db/schema/provider-operations'
import type { JsonObject } from './folder-sync-protocol'
import { retainCustomerReference } from './invoice-provider-scope'
import { portableBillingFromLocal } from './invoice-portable-billing'
import { freezeInvoiceRequest, type StripeContext } from './stripe-operation-service'
import { recordProviderResolution, retainProviderOperation } from './provider-operation-store'
import { refreshClientStripeInvoices } from './invoice-stripe-import'
import { folderSyncSettings } from '../db/schema/folder-sync'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
const listInvoices = vi.fn()

vi.mock('../db', () => ({ getDb: () => db }))
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('./session-service', () => ({ sessionService: { getReconciliationCases: () => [] } }))
vi.mock('./credential-service', () => ({
  credentialService: { isStripeTestMode: () => true, getApiKey: () => null }
}))
vi.mock('./stripe-service', () => ({ stripeService: { listInvoices: () => listInvoices() } }))
vi.mock('./ai-service', () => ({
  aiService: { summarizeSessionGroup: vi.fn().mockResolvedValue(null) }
}))
const { invoiceService } = await import('./invoice-service')

type Row = Record<string, unknown> & { id: string }
const context: StripeContext = {
  accountId: 'acct_fixture',
  testMode: true,
  providerDate: 'Mon, 28 Sep 2026 02:00:00 GMT'
}

function invoice(id: string, customer: string, overrides: Record<string, unknown> = {}): Row {
  return {
    id,
    customer,
    livemode: false,
    status: 'open',
    amount_due: 5000,
    amount_paid: 0,
    currency: 'usd',
    description: null,
    hosted_invoice_url: null,
    invoice_pdf: null,
    due_date: null,
    status_transitions: { paid_at: null },
    metadata: {},
    lines: {
      data: [{ id: `il_${id}`, description: 'Work', amount: 5000, period: null }],
      has_more: false
    },
    ...overrides
  }
}

/** Customer-scoped, paginated list (two per page) of one Stripe account. */
function fakeStripe(rows: Row[], customers: Row[] = []) {
  const list = vi.fn(async (params: { customer: string; starting_after?: string }) => {
    const mine = rows.filter((row) => row.customer === params.customer)
    const from = params.starting_after
      ? mine.findIndex((row) => row.id === params.starting_after) + 1
      : 0
    return {
      data: mine.slice(from, from + 2).map((row) => structuredClone(row)),
      has_more: from + 2 < mine.length
    }
  })
  const retrieve = vi.fn(async (id: string) => {
    const found = customers.find((row) => row.id === id)
    if (!found)
      throw Object.assign(new Error('No such customer'), {
        code: 'resource_missing',
        statusCode: 404
      })
    return found
  })
  return {
    list,
    retrieve,
    stripe: {
      invoices: { list, listLineItems: vi.fn() },
      customers: { retrieve }
    } as unknown as Stripe
  }
}

let clientSyncId: string

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  clientSyncId = randomUUID()
  db.insert(clients).values({ id: 7, syncId: clientSyncId, name: 'Acme', color: '#000000' }).run()
  db.insert(clients).values({ id: 8, syncId: randomUUID(), name: 'Other', color: '#000000' }).run()
  db.insert(projects).values({ id: 3, clientId: 7, name: 'Site' }).run()
  db.insert(sessions)
    .values({
      id: 11,
      source: 'manual',
      projectPath: '',
      startedAt: '2026-09-02T10:00:00.000Z',
      endedAt: '2026-09-02T12:00:00.000Z',
      durationMinutes: 120,
      clientId: 7,
      projectId: 3
    })
    .run()
  db.insert(manualTimeEntries)
    .values({ id: randomUUID(), sessionId: 11, deviceId: null, basis: 'imported' })
    .run()
  listInvoices.mockReset()
})
afterEach(() => sqlite.close())

/** A retained create operation (e.g. imported from another computer) whose invoice step finished. */
function retainedOperation(
  invoiceId: string | null,
  customer = 'cus_op',
  id = randomUUID()
): string {
  const frozen = freezeInvoiceRequest(
    { operationId: id, clientId: 7, lineItems: [{ description: 'Earlier', amountCents: 5000 }] },
    { syncId: clientSyncId, name: 'Acme', email: 'a@acme.test', stripeCustomerId: null },
    portableBillingFromLocal(db, {
      periodStart: null,
      periodEnd: null,
      lines: [
        {
          lineDate: null,
          durationMinutes: 60,
          sessionIds: [11],
          billedRanges: [
            {
              sessionId: 11,
              clientId: 7,
              projectId: 3,
              startedAt: '2026-09-02T10:00:00.000Z',
              endedAt: '2026-09-02T11:00:00.000Z'
            }
          ]
        }
      ]
    })
  )
  retainProviderOperation(db, {
    id,
    accountId: 'acct_fixture',
    testMode: true,
    kind: 'create-invoice',
    request: frozen as unknown as JsonObject
  })
  db.insert(providerOperationSteps)
    .values({
      operationId: id,
      name: 'invoice',
      requestJson: JSON.stringify({ customer }),
      idempotencyKey: `clautime:${id}:invoice`,
      startedProviderAt: '2026-09-28T02:00:00.000Z'
    })
    .run()
  if (invoiceId)
    db.insert(providerOperationResults)
      .values({ operationId: id, name: 'invoice', resultJson: JSON.stringify({ invoiceId }) })
      .run()
  return id
}

const saved = (id: string) =>
  db.select().from(invoices).where(eq(invoices.stripeInvoiceId, id)).get()

describe('refreshClientStripeInvoices', () => {
  it('reads every page of the client’s invoices and saves lineage and status with the captured account', async () => {
    retainCustomerReference(db, 7, context, 'cus_1')
    const operationId = retainedOperation('in_op', 'cus_1')
    sqlite.exec(
      "INSERT INTO invoices (client_id, stripe_invoice_id, provider_account_id, status, amount_due_cents, test_mode, created_at, updated_at) VALUES (7, 'in_saved', 'acct_fixture', 'open', 5000, 1, 'x', 'x')"
    )
    const fake = fakeStripe([
      invoice('in_a', 'cus_1'),
      invoice('in_op', 'cus_1', {
        status: 'draft',
        metadata: { clautime_operation_id: operationId }
      }),
      invoice('in_saved', 'cus_1', {
        status: 'paid',
        amount_paid: 5000,
        status_transitions: { paid_at: 1790600000 }
      }),
      invoice('in_b', 'cus_1'),
      invoice('in_c', 'cus_1'),
      invoice('in_other_customer', 'cus_2')
    ])
    await refreshClientStripeInvoices(db, fake.stripe, context, 7)
    expect(fake.list).toHaveBeenCalledTimes(3)
    expect(fake.list.mock.calls.every(([params]) => params.customer === 'cus_1')).toBe(true)
    expect(
      db
        .select()
        .from(invoices)
        .all()
        .map((row) => row.stripeInvoiceId)
        .sort()
    ).toEqual(['in_a', 'in_b', 'in_c', 'in_op', 'in_saved'])
    expect(saved('in_op')).toMatchObject({
      clientId: 7,
      operationId,
      providerAccountId: 'acct_fixture'
    })
    expect(
      db
        .select()
        .from(sessionBillingRefs)
        .where(eq(sessionBillingRefs.stripeInvoiceId, 'in_op'))
        .all()
    ).toMatchObject([
      {
        sessionId: 11,
        billedRanges: [
          expect.objectContaining({
            startedAt: '2026-09-02T10:00:00.000Z',
            endedAt: '2026-09-02T11:00:00.000Z'
          })
        ]
      }
    ])
    expect(saved('in_saved')).toMatchObject({ status: 'paid', amountPaidCents: 5000 })
  })

  it('binds a legacy customer only after this key retrieves it, never over a verified reference', async () => {
    db.update(clients).set({ stripeCustomerId: 'cus_legacy' }).where(eq(clients.id, 7)).run()
    const rows = [invoice('in_legacy', 'cus_legacy'), invoice('in_scoped', 'cus_scoped')]
    // Not retrievable with this key: it may belong to another account.
    const missing = fakeStripe(rows)
    await refreshClientStripeInvoices(db, missing.stripe, context, 7)
    expect(missing.list).not.toHaveBeenCalled()
    expect(db.select().from(clientProviderReferences).all()).toEqual([])

    const found = fakeStripe(rows, [{ id: 'cus_legacy', livemode: false }])
    await refreshClientStripeInvoices(db, found.stripe, context, 7)
    expect(db.select().from(clientProviderReferences).all()).toMatchObject([
      { clientId: 7, accountId: 'acct_fixture', testMode: 1, customerId: 'cus_legacy' }
    ])
    expect(saved('in_legacy')).toMatchObject({ clientId: 7 })

    retainCustomerReference(db, 7, context, 'cus_scoped')
    await refreshClientStripeInvoices(db, found.stripe, context, 7)
    expect(db.select().from(clientProviderReferences).all()).toMatchObject([
      { customerId: 'cus_scoped' }
    ])
    expect(saved('in_scoped')).toBeDefined()
  })

  it('never lets a wrong-account key refresh this client', async () => {
    retainCustomerReference(db, 7, { accountId: 'acct_original', testMode: true }, 'cus_same')
    const fake = fakeStripe([invoice('in_new', 'cus_same')], [{ id: 'cus_same', livemode: false }])
    db.update(clients).set({ stripeCustomerId: 'cus_same' }).where(eq(clients.id, 7)).run()
    await expect(refreshClientStripeInvoices(db, fake.stripe, context, 7)).rejects.toMatchObject({
      code: 'STRIPE_ACCOUNT_MISMATCH'
    })
    expect(fake.list).not.toHaveBeenCalled()
    expect(fake.retrieve).not.toHaveBeenCalled()
    expect(db.select().from(invoices).all()).toEqual([])
  })

  it('refuses a saved invoice of another account even under the same customer ID', async () => {
    sqlite.exec(
      "INSERT INTO invoices (client_id, stripe_invoice_id, provider_account_id, status, test_mode, created_at, updated_at) VALUES (8, 'in_shared', 'acct_original', 'open', 1, 'x', 'x')"
    )
    retainCustomerReference(db, 7, context, 'cus_same')
    const fake = fakeStripe([invoice('in_shared', 'cus_same', { status: 'void' })])
    await expect(refreshClientStripeInvoices(db, fake.stripe, context, 7)).rejects.toMatchObject({
      code: 'STRIPE_ACCOUNT_MISMATCH'
    })
    expect(saved('in_shared')).toMatchObject({
      clientId: 8,
      status: 'open',
      providerAccountId: 'acct_original'
    })
  })

  it('keeps local-only invoicing available when a remote operation cannot arrive through sync', async () => {
    retainCustomerReference(db, 7, context, 'cus_1')
    const fake = fakeStripe([
      invoice('in_remote', 'cus_1', { metadata: { clautime_operation_id: randomUUID() } })
    ])
    await expect(refreshClientStripeInvoices(db, fake.stripe, context, 7)).resolves.toBeUndefined()
    await expect(refreshClientStripeInvoices(db, fake.stripe, context, 7)).resolves.toBeUndefined()
    expect(saved('in_remote')).toMatchObject({ clientId: 7 })
  })

  it.each([0, 1])(
    'keeps blocking repeated shared-history attempts until billed-work identity arrives (enabled=%s)',
    async (enabled) => {
      db.insert(folderSyncSettings)
        .values({ slot: 1, workspaceId: randomUUID(), folderPath: 'C:/sync', enabled })
        .run()
      retainCustomerReference(db, 7, context, 'cus_1')
      const operationId = randomUUID()
      const fake = fakeStripe([
        invoice('in_remote', 'cus_1', { metadata: { clautime_operation_id: operationId } })
      ])
      await expect(refreshClientStripeInvoices(db, fake.stripe, context, 7)).rejects.toMatchObject({
        code: 'INVOICE_REFRESH_REVIEW',
        message: expect.stringContaining('in_remote')
      })
      expect(saved('in_remote')).toMatchObject({ clientId: 7 })
      await expect(refreshClientStripeInvoices(db, fake.stripe, context, 7)).rejects.toMatchObject({
        code: 'INVOICE_REFRESH_REVIEW'
      })
      retainedOperation('in_remote', 'cus_1', operationId)
      await expect(
        refreshClientStripeInvoices(db, fake.stripe, context, 7)
      ).resolves.toBeUndefined()
      expect(
        db
          .select()
          .from(sessionBillingRefs)
          .where(eq(sessionBillingRefs.stripeInvoiceId, 'in_remote'))
          .all()
      ).toMatchObject([{ sessionId: 11 }])
    }
  )

  it('blocks while Stripe holds a live invoice from a cancelled draft', async () => {
    retainCustomerReference(db, 7, context, 'cus_1')
    const operationId = retainedOperation(null, 'cus_1')
    recordProviderResolution(db, operationId, { version: 1 })
    const rows = [
      invoice('in_late', 'cus_1', {
        status: 'draft',
        metadata: { clautime_operation_id: operationId }
      })
    ]
    await expect(
      refreshClientStripeInvoices(db, fakeStripe(rows).stripe, context, 7)
    ).rejects.toMatchObject({
      code: 'INVOICE_REFRESH_REVIEW',
      message: expect.stringContaining('cancelled')
    })
    rows[0].status = 'void'
    await expect(
      refreshClientStripeInvoices(db, fakeStripe(rows).stripe, context, 7)
    ).resolves.toBeUndefined()
  })

  it('fails rather than treating an unfinished pagination as complete', async () => {
    retainCustomerReference(db, 7, context, 'cus_1')
    let n = 0
    const stripe = {
      invoices: {
        list: vi.fn(async () => ({ data: [invoice(`in_page${++n}`, 'cus_1')], has_more: true })),
        listLineItems: vi.fn()
      },
      customers: { retrieve: vi.fn() }
    } as unknown as Stripe
    await expect(refreshClientStripeInvoices(db, stripe, context, 7)).rejects.toMatchObject({
      code: 'INVOICE_REFRESH_INCOMPLETE'
    })
  })
})

describe('invoiceService.importFromStripe', () => {
  it('matches a legacy reference through this account’s list without replacing a verified one', async () => {
    db.update(clients).set({ stripeCustomerId: 'cus_legacy' }).where(eq(clients.id, 7)).run()
    retainCustomerReference(db, 7, context, 'cus_current')
    const operationId = retainedOperation('in_op', 'cus_current')
    listInvoices.mockResolvedValue({
      account: { accountId: 'acct_fixture', testMode: true },
      providerDate: context.providerDate,
      invoices: [
        invoice('in_old', 'cus_legacy'),
        invoice('in_op', 'cus_current', { metadata: { clautime_operation_id: operationId } }),
        invoice('in_stranger', 'cus_unknown')
      ]
    })
    expect(await invoiceService.importFromStripe()).toBe(2)
    expect(db.select().from(clientProviderReferences).all()).toMatchObject([
      { customerId: 'cus_current' }
    ])
    expect(saved('in_old')).toMatchObject({ clientId: 7, providerAccountId: 'acct_fixture' })
    expect(saved('in_op')).toMatchObject({ operationId })
    expect(saved('in_stranger')).toBeUndefined()
  })
})
