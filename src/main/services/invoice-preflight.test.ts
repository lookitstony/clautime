// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type Stripe from 'stripe'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { sessionBillingRefs } from '../db/schema/session-history'
import { folderSyncSettings } from '../db/schema/folder-sync'
import { providerOperationSteps, providerOperationResults } from '../db/schema/provider-operations'
import { portableBillingFromLocal, type LocalInvoiceBilling } from './invoice-portable-billing'
import { freezeInvoiceRequest, type FrozenInvoiceRequest } from './stripe-operation-service'
import { recordProviderResolution, retainProviderOperation } from './provider-operation-store'
import type { JsonObject } from './folder-sync-protocol'
import {
  checkBeforeSend,
  checkNewInvoiceBilling,
  configureInvoicePreflight,
  importBeforeInvoiceWrite,
  type InvoiceImportStatus
} from './invoice-preflight'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>

vi.mock('../db', () => ({ getDb: () => db }))
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  db.insert(clients).values({ id: 7, syncId: randomUUID(), name: 'Acme', color: '#000000' }).run()
  db.insert(projects).values({ id: 3, clientId: 7, name: 'Site' }).run()
  db.insert(sessions)
    .values({
      id: 11,
      projectPath: '',
      startedAt: '2026-09-02T10:00:00.000Z',
      endedAt: '2026-09-02T12:00:00.000Z',
      durationMinutes: 120,
      clientId: 7,
      projectId: 3
    })
    .run()
})
afterEach(() => {
  configureInvoicePreflight(null)
  sqlite.close()
})

const frozen = {
  billing: { periodStart: '2026-09-01', periodEnd: '2026-09-30', lines: [] }
} as unknown as FrozenInvoiceRequest

function receipt(startedAt: string, endedAt: string): LocalInvoiceBilling {
  return {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    lines: [
      {
        lineDate: '2026-09-02',
        durationMinutes: 60,
        sessionIds: [11],
        billedRanges: [{ sessionId: 11, clientId: 7, projectId: 3, startedAt, endedAt }]
      }
    ]
  }
}

function billElsewhere(startedAt: string, endedAt: string): void {
  db.insert(sessionBillingRefs)
    .values({
      sessionId: 11,
      stripeInvoiceId: 'in_other',
      testMode: 1,
      billedRanges: [{ sessionId: 11, clientId: 7, projectId: 3, startedAt, endedAt }]
    })
    .run()
}

describe('checkNewInvoiceBilling', () => {
  it('accepts work that is still unbilled', () => {
    billElsewhere('2026-09-02T10:00:00.000Z', '2026-09-02T11:00:00.000Z')
    expect(() =>
      checkNewInvoiceBilling(
        db,
        7,
        frozen,
        receipt('2026-09-02T11:00:00.000Z', '2026-09-02T12:00:00.000Z'),
        true
      )
    ).not.toThrow()
  })

  it('rejects a preview whose work was billed since (e.g. an invoice imported from the folder)', () => {
    billElsewhere('2026-09-02T10:30:00.000Z', '2026-09-02T11:00:00.000Z')
    expect(() =>
      checkNewInvoiceBilling(
        db,
        7,
        frozen,
        receipt('2026-09-02T10:00:00.000Z', '2026-09-02T12:00:00.000Z'),
        true
      )
    ).toThrow(expect.objectContaining({ code: 'INVOICE_WORK_ALREADY_BILLED' }))
  })

  it('keeps test and live billing separate', () => {
    billElsewhere('2026-09-02T10:00:00.000Z', '2026-09-02T12:00:00.000Z')
    expect(() =>
      checkNewInvoiceBilling(
        db,
        7,
        frozen,
        receipt('2026-09-02T10:00:00.000Z', '2026-09-02T12:00:00.000Z'),
        false
      )
    ).not.toThrow()
  })

  it('rejects a preview naming a session that no longer exists', () => {
    const stale = receipt('2026-09-02T10:00:00.000Z', '2026-09-02T11:00:00.000Z')
    stale.lines[0].sessionIds = [99]
    expect(() => checkNewInvoiceBilling(db, 7, frozen, stale, true)).toThrow(
      expect.objectContaining({ code: 'BILLING_REFERENCE_UNAVAILABLE' })
    )
  })
})

describe('importBeforeInvoiceWrite', () => {
  const connect = (enabled: number) =>
    db
      .insert(folderSyncSettings)
      .values({ slot: 1, workspaceId: randomUUID(), folderPath: 'C:/sync', enabled })
      .run()
  const hook = (status: InvoiceImportStatus['status']) =>
    vi.fn(async (_: { paused: boolean }): Promise<InvoiceImportStatus> => ({ status, issues: [] }))

  it('does nothing without a folder connection', async () => {
    const importAvailableChanges = hook('idle')
    configureInvoicePreflight({ importAvailableChanges })
    await importBeforeInvoiceWrite(db)
    expect(importAvailableChanges).not.toHaveBeenCalled()
  })

  it('imports available changes before a write and blocks when that fails or is unwired', async () => {
    connect(1)
    await expect(importBeforeInvoiceWrite(db)).rejects.toMatchObject({
      code: 'SYNC_BILLING_INCOMPLETE'
    })
    const importAvailableChanges = hook('idle')
    configureInvoicePreflight({ importAvailableChanges })
    await importBeforeInvoiceWrite(db)
    expect(importAvailableChanges).toHaveBeenCalledWith({ paused: false })
    importAvailableChanges.mockRejectedValueOnce(new Error('batch unreadable'))
    await expect(importBeforeInvoiceWrite(db)).rejects.toMatchObject({
      code: 'SYNC_BILLING_INCOMPLETE'
    })
  })

  it('never silently skips a paused folder: one import-only pass, or an explicit resume', async () => {
    connect(0)
    const imported = hook('idle')
    configureInvoicePreflight({ importAvailableChanges: imported })
    await importBeforeInvoiceWrite(db)
    expect(imported).toHaveBeenCalledWith({ paused: true })
    configureInvoicePreflight({ importAvailableChanges: hook('disabled') })
    await expect(importBeforeInvoiceWrite(db)).rejects.toMatchObject({
      code: 'SYNC_PAUSED_BILLING'
    })
  })

  it.each([
    ['incomplete', null],
    ['unavailable', 'SYNC_BILLING_INCOMPLETE'],
    ['update-required', 'SYNC_UPDATE_REQUIRED']
  ] as const)('decides by the coordinator status %s', async (status, code) => {
    connect(1)
    configureInvoicePreflight({ importAvailableChanges: hook(status) })
    if (code) await expect(importBeforeInvoiceWrite(db)).rejects.toMatchObject({ code })
    else await expect(importBeforeInvoiceWrite(db)).resolves.toBeUndefined()
  })
})

describe('billed work of retained operations', () => {
  const account = { accountId: 'acct_other', testMode: true }
  function retainFor(localBilling: LocalInvoiceBilling): string {
    const client = db.select().from(clients).where(eq(clients.id, 7)).get()!
    const frozen = freezeInvoiceRequest(
      {
        operationId: randomUUID(),
        clientId: 7,
        lineItems: [{ description: 'Earlier draft', amountCents: 10000 }]
      },
      { syncId: client.syncId, name: 'Acme', email: 'a@acme.test', stripeCustomerId: null },
      portableBillingFromLocal(db, localBilling)
    )
    const id = randomUUID()
    retainProviderOperation(db, {
      id,
      ...account,
      kind: 'create-invoice',
      request: frozen as unknown as JsonObject
    })
    return id
  }

  it('excludes an unfinished draft’s work (any account) until it is cancelled with proof', () => {
    const id = retainFor(receipt('2026-09-02T10:00:00.000Z', '2026-09-02T11:00:00.000Z'))
    expect(() =>
      checkNewInvoiceBilling(
        db,
        7,
        frozen,
        receipt('2026-09-02T10:00:00.000Z', '2026-09-02T12:00:00.000Z'),
        true
      )
    ).toThrow(expect.objectContaining({ code: 'INVOICE_WORK_ALREADY_BILLED' }))
    // Live billing is separate from a test-mode draft.
    expect(() =>
      checkNewInvoiceBilling(
        db,
        7,
        frozen,
        receipt('2026-09-02T10:00:00.000Z', '2026-09-02T12:00:00.000Z'),
        false
      )
    ).not.toThrow()
    recordProviderResolution(db, id, { version: 1 })
    expect(() =>
      checkNewInvoiceBilling(
        db,
        7,
        frozen,
        receipt('2026-09-02T10:00:00.000Z', '2026-09-02T12:00:00.000Z'),
        true
      )
    ).not.toThrow()
  })
})

describe('checkBeforeSend', () => {
  const context = {
    accountId: 'acct_fixture',
    testMode: true,
    providerDate: 'Mon, 28 Sep 2026 02:00:00 GMT'
  }
  const stripeInvoice = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'in_send',
      status: 'draft',
      subtotal: 15000,
      metadata: {},
      livemode: false,
      ...overrides
    }) as unknown as Stripe.Invoice
  function saveLocal(status = 'draft', operationId: string | null = null): void {
    sqlite.exec(
      `INSERT INTO invoices (id, client_id, stripe_invoice_id, provider_account_id, operation_id, status, test_mode, created_at, updated_at) VALUES (21, 7, 'in_send', 'acct_fixture', ${operationId ? `'${operationId}'` : 'NULL'}, '${status}', 1, 'x', 'x')`
    )
    sqlite.exec(
      "INSERT INTO invoice_line_items (invoice_id, description, amount_cents, sort_order, created_at) VALUES (21, 'Work', 10000, 0, 'x'), (21, 'More', 5000, 1, 'x')"
    )
  }
  function operation(lines: number, completed: number, invoiceId = 'in_send'): string {
    const client = db.select().from(clients).where(eq(clients.id, 7)).get()!
    const id = randomUUID()
    const frozenRequest = freezeInvoiceRequest(
      {
        operationId: id,
        clientId: 7,
        lineItems: Array.from({ length: lines }, (_, i) => ({
          description: `Line ${i}`,
          amountCents: 7500
        }))
      },
      { syncId: client.syncId, name: 'Acme', email: 'a@acme.test', stripeCustomerId: null },
      {
        periodStart: null,
        periodEnd: null,
        lines: Array.from({ length: lines }, () => ({
          lineDate: null,
          durationMinutes: null,
          billed: null
        }))
      }
    )
    retainProviderOperation(db, {
      id,
      accountId: 'acct_fixture',
      testMode: true,
      kind: 'create-invoice',
      request: frozenRequest as unknown as JsonObject
    })
    const step = (name: string, result: JsonObject | null) => {
      db.insert(providerOperationSteps)
        .values({
          operationId: id,
          name,
          requestJson: '{}',
          idempotencyKey: `clautime:${id}:${name}`,
          startedProviderAt: '2026-09-28T02:00:00.000Z'
        })
        .run()
      if (result)
        db.insert(providerOperationResults)
          .values({ operationId: id, name, resultJson: JSON.stringify(result) })
          .run()
    }
    step('invoice', { invoiceId })
    for (let i = 0; i < lines; i++)
      step(`item-${i}`, i < completed ? { invoiceItemId: `ii_${i}` } : null)
    return id
  }

  it('passes a draft that still holds the saved amounts (a cent of rounding per line allowed)', () => {
    saveLocal()
    expect(() => checkBeforeSend(db, stripeInvoice(), context)).not.toThrow()
    expect(() => checkBeforeSend(db, stripeInvoice({ subtotal: 15002 }), context)).not.toThrow()
    expect(() => checkBeforeSend(db, stripeInvoice({ subtotal: 17500 }), context)).toThrow(
      expect.objectContaining({ code: 'INVOICE_AMOUNT_CHANGED' })
    )
  })

  it('blocks a shared terminal status that Stripe contradicts', () => {
    saveLocal('void')
    expect(() => checkBeforeSend(db, stripeInvoice({ status: 'open' }), context)).toThrow(
      expect.objectContaining({ code: 'INVOICE_STATUS_CONFLICT' })
    )
  })

  it('blocks a draft whose operation never confirmed every line', () => {
    const id = operation(2, 1)
    expect(() =>
      checkBeforeSend(db, stripeInvoice({ metadata: { clautime_operation_id: id } }), context)
    ).toThrow(expect.objectContaining({ code: 'INVOICE_DRAFT_INCOMPLETE' }))
  })

  it('checks a complete operation’s draft against its frozen amounts and its cancellation', () => {
    const id = operation(2, 2)
    const invoice = stripeInvoice({ metadata: { clautime_operation_id: id } })
    expect(() => checkBeforeSend(db, invoice, context)).not.toThrow()
    expect(() =>
      checkBeforeSend(
        db,
        stripeInvoice({ metadata: { clautime_operation_id: id }, subtotal: 99 }),
        context
      )
    ).toThrow(expect.objectContaining({ code: 'INVOICE_AMOUNT_CHANGED' }))
    expect(() => checkBeforeSend(db, invoice, { ...context, accountId: 'acct_other' })).toThrow(
      expect.objectContaining({ code: 'PROVIDER_RESULT_CONFLICT' })
    )
    recordProviderResolution(db, id, { version: 1 })
    expect(() => checkBeforeSend(db, invoice, context)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_RESULT_CONFLICT' })
    )
  })

  it('waits for a draft operation from another computer when shared history is connected', () => {
    const invoice = stripeInvoice({ metadata: { clautime_operation_id: randomUUID() } })
    expect(() => checkBeforeSend(db, invoice, context)).not.toThrow()
    db.insert(folderSyncSettings)
      .values({ slot: 1, workspaceId: randomUUID(), folderPath: 'C:/sync', enabled: 1 })
      .run()
    expect(() => checkBeforeSend(db, invoice, context)).toThrow(
      expect.objectContaining({ code: 'SYNC_BILLING_INCOMPLETE' })
    )
  })
})
