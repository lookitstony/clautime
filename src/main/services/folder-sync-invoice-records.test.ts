// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { and, eq } from 'drizzle-orm'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type Stripe from 'stripe'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { invoices, invoiceLineItems } from '../db/schema/invoices'
import { sessionBillingRefs } from '../db/schema/session-history'
import { sourceMachines } from '../db/schema/activity-observers'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { folderSyncSettings, syncChanges } from '../db/schema/folder-sync'
import {
  providerOperations,
  providerOperationSteps,
  providerOperationResults,
  providerOperationResolutions
} from '../db/schema/provider-operations'
import type { InvoiceStatus } from '../../shared/types/invoice'
import {
  canonicalJson,
  type JsonObject,
  type SyncBatch,
  type SyncChange
} from './folder-sync-protocol'
import {
  applyReadySyncBatches,
  assembleOutgoingBatch,
  recordLocalSyncChanges,
  retainIncomingBatch,
  type SyncDomainAdapter
} from './folder-sync-store'
import { activitySyncAdapter, collectActivitySyncChanges } from './folder-sync-activity-records'
import { collectManualSyncChanges, manualRecordsAdapter } from './folder-sync-manual-records'
import {
  directoryRecordsAdapter,
  isDirectoryEntityType,
  planDirectoryExport
} from './folder-sync-directory-records'
import { findClientByPortableId } from './folder-sync-builtin-client'
import { unbilledSessions } from './session-billing'
import {
  configureProviderOperationJournal,
  recordProviderResolution,
  retainProviderOperation
} from './provider-operation-store'
import {
  createDraftInvoiceOperation,
  freezeInvoiceRequest,
  readFrozenInvoiceRequest,
  type InvoiceClient
} from './stripe-operation-service'
import { requestFromFrozenInvoice, requireNoPendingInvoice } from './pending-invoice-operations'
import { portableBillingFromLocal, resolvePortableBilling } from './invoice-portable-billing'
import {
  collectInvoiceSyncChanges,
  invoiceBillingBlockers,
  invoiceRecordsAdapter,
  invoiceSyncId,
  isInvoiceEntityType,
  operationBilledRanges,
  portableBilledRanges,
  providerIntentJournal,
  providerObservationView,
  readProviderObservation,
  recordProviderObservation,
  refreshInvoiceSyncProjections,
  requireNoInvoiceBillingBlockers,
  validateInvoiceChange,
  type PortableProviderObservation
} from './folder-sync-invoice-records'

const workspaceId = '6a0f8f64-3c1d-4b8e-9f51-2d7c4e9b1a30'
const account = { accountId: 'acct_fixture', testMode: true }
const stripeInvoiceId = 'in_fixture1'
type Db = ReturnType<typeof drizzle>
const opened: Database.Database[] = []
let a: Db
let b: Db
let clientSyncId: string
let entryId: string

function database(): Db {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  opened.push(connection)
  const db = drizzle(connection)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  db.insert(folderSyncSettings)
    .values({ slot: 1, workspaceId, folderPath: 'unused', enabled: 1 })
    .run()
  return db
}

const route = (change: SyncChange): SyncDomainAdapter =>
  isInvoiceEntityType(change.entityType)
    ? invoiceRecordsAdapter
    : isDirectoryEntityType(change.entityType)
      ? directoryRecordsAdapter
      : change.entityType === 'manual-entry'
        ? manualRecordsAdapter
        : activitySyncAdapter
const adapter: SyncDomainAdapter = {
  validate: (change) => route(change).validate(change),
  apply: (tx, workspace, change) => route(change).apply(tx, workspace, change)
}
const record = (db: Db, changes: unknown[]): string[] =>
  recordLocalSyncChanges(db, workspaceId, changes, adapter)
const sent: SyncBatch[] = []
function transfer(from: Db, to: Db): void {
  while (true) {
    const batch = assembleOutgoingBatch(from, workspaceId, {
      writerEpochId: randomUUID(),
      deviceId: randomUUID()
    })
    if (!batch) break
    sent.push(batch)
    retainIncomingBatch(to, workspaceId, batch, adapter)
  }
  const result = applyReadySyncBatches(to, workspaceId, adapter)
  expect(result.errors).toEqual([])
  expect(result.waiting).toEqual([])
  refreshInvoiceSyncProjections(to)
}
function exchange(): void {
  transfer(a, b)
  transfer(b, a)
}

const localClient = (db: Db) => findClientByPortableId(db, clientSyncId)!.id
const manualSession = (db: Db) =>
  db.select().from(manualTimeEntries).where(eq(manualTimeEntries.id, entryId)).get()!.sessionId
const savedInvoice = (db: Db) =>
  db.select().from(invoices).where(eq(invoices.stripeInvoiceId, stripeInvoiceId)).get()
const status = (overrides: Partial<InvoiceStatus>): InvoiceStatus => ({
  invoiceId: stripeInvoiceId,
  status: 'open',
  amountDueCents: 15000,
  amountPaidCents: 0,
  currency: 'usd',
  hostedUrl: 'https://invoice.stripe.com/i/acct_fixture/test_abc',
  invoicePdf: null,
  dueDate: null,
  paidAt: null,
  ...overrides
})

beforeEach(() => {
  sent.length = 0
  configureProviderOperationJournal(providerIntentJournal)
  a = database()
  b = database()
  // Different local row numbers on B for every shared record.
  b.insert(clients).values({ name: 'Other', color: '#111111' }).run()
  b.insert(clients).values({ name: 'Another', color: '#222222' }).run()
  for (let i = 0; i < 3; i++)
    b.insert(sessions)
      .values({
        projectPath: 'C:/elsewhere',
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:30:00Z',
        durationMinutes: 30
      })
      .run()

  const deviceA = randomUUID()
  a.insert(sourceMachines).values({ deviceId: deviceA, initialName: 'Desktop' }).run()
  const client = a
    .insert(clients)
    .values({ name: 'Acme', color: '#000000', billableRate: 100 })
    .returning()
    .get()
  clientSyncId = client.syncId
  const project = a
    .insert(projects)
    .values({ clientId: client.id, name: 'Site', directoryPath: '/home/fixture/secret-project' })
    .returning()
    .get()
  const session = a
    .insert(sessions)
    .values({
      projectPath: '/home/fixture/secret-project',
      source: 'manual',
      startedAt: '2026-09-02T10:00:00.000Z',
      endedAt: '2026-09-02T11:30:00.000Z',
      durationMinutes: 90,
      description: 'Build',
      clientId: client.id,
      projectId: project.id
    })
    .returning()
    .get()
  entryId = randomUUID()
  a.insert(manualTimeEntries)
    .values({ id: entryId, sessionId: session.id, deviceId: deviceA, basis: 'created' })
    .run()
  const directory = planDirectoryExport(a, workspaceId)
  expect(directory).toMatchObject({ blocked: [], invalid: [] })
  record(a, directory.changes)
  record(a, collectActivitySyncChanges(a, workspaceId))
  record(a, collectManualSyncChanges(a, workspaceId).changes)

  // A saved invoice on A with its frozen billed-work reference.
  const invoice = a
    .insert(invoices)
    .values({
      clientId: client.id,
      stripeInvoiceId,
      providerAccountId: account.accountId,
      status: 'open',
      amountDueCents: 15000,
      currency: 'usd',
      memo: 'September work',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      testMode: 1,
      createdAt: '2026-09-28T02:00:00.000Z'
    })
    .returning()
    .get()
  a.insert(invoiceLineItems)
    .values({
      invoiceId: invoice.id,
      lineDate: '2026-09-02',
      description: '09/02/26 Site: Build',
      amountCents: 15000,
      durationMinutes: 90,
      sessionIds: String(session.id),
      sortOrder: 0
    })
    .run()
  a.insert(sessionBillingRefs)
    .values({
      sessionId: session.id,
      stripeInvoiceId,
      testMode: 1,
      billedRanges: [
        {
          sessionId: session.id,
          clientId: client.id,
          projectId: project.id,
          startedAt: session.startedAt,
          endedAt: session.endedAt
        }
      ]
    })
    .run()
  const exported = collectInvoiceSyncChanges(a, workspaceId)
  expect(exported.withheld).toEqual([])
  record(a, exported.changes)
})

afterEach(() => {
  configureProviderOperationJournal(null)
  vi.restoreAllMocks()
  for (const connection of opened.splice(0)) connection.close()
})

describe('portable invoice restore', () => {
  it('restores the header, lines and billed work on a database with different local IDs', () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    exchange()
    expect(fetch).not.toHaveBeenCalled()
    const restored = savedInvoice(b)!
    expect(localClient(b)).not.toBe(localClient(a))
    expect(manualSession(b)).not.toBe(manualSession(a))
    expect(restored).toMatchObject({
      clientId: localClient(b),
      providerAccountId: account.accountId,
      testMode: 1,
      memo: 'September work',
      status: 'open',
      amountDueCents: 15000,
      periodStart: '2026-09-01',
      createdAt: '2026-09-28T02:00:00.000Z'
    })
    expect(
      b.select().from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, restored.id)).all()
    ).toMatchObject([
      { description: '09/02/26 Site: Build', amountCents: 15000, durationMinutes: 90 }
    ])
    const refs = b.select().from(sessionBillingRefs).all()
    expect(refs).toMatchObject([{ sessionId: manualSession(b), stripeInvoiceId, testMode: 1 }])
    const session = b
      .select()
      .from(sessions)
      .where(eq(sessions.id, manualSession(b)))
      .get()!
    expect(unbilledSessions(b, [session], true)).toEqual([])
    expect(invoiceBillingBlockers(b, workspaceId, clientSyncId)).toEqual([])
  })

  it('exports only allowlisted portable facts', () => {
    exchange()
    expect(JSON.stringify(sent)).not.toContain('secret-project')
    const invoiceChanges = sent.flatMap((batch) =>
      batch.changes.filter((change) => isInvoiceEntityType(change.entityType))
    )
    expect(new Set(invoiceChanges.map((change) => change.entityType))).toEqual(
      new Set(['invoice', 'invoice-line', 'billing-reference', 'provider-observation'])
    )
    const text = JSON.stringify(invoiceChanges)
    expect(text).not.toMatch(/sessionIds|"sessionId"|"clientId"|"projectId"|localId|"id":\d/)
    expect(text).not.toMatch(/sk_(live|test)_|x-api-key|request-id|lastResponse/i)
  })

  it('keeps issued amounts and billed exclusion through session edits, hiding and re-imports', () => {
    exchange()
    const id = manualSession(b)
    b.update(sessions)
      .set({ endedAt: '2026-09-02T12:00:00.000Z', durationMinutes: 120 })
      .where(eq(sessions.id, id))
      .run()
    b.update(invoices).set({ hidden: 1 }).where(eq(invoices.stripeInvoiceId, stripeInvoiceId)).run()
    // Re-delivering the same batches changes nothing.
    for (const batch of sent) retainIncomingBatch(b, workspaceId, batch, adapter)
    applyReadySyncBatches(b, workspaceId, adapter)
    const lines = b.select().from(invoiceLineItems).all()
    expect(lines.map((line) => line.amountCents)).toEqual([15000])
    const session = b.select().from(sessions).where(eq(sessions.id, id)).get()!
    // Only the half hour after the frozen range is eligible.
    expect(unbilledSessions(b, [session], true)).toMatchObject([
      { startedAt: '2026-09-02T11:30:00.000Z', endedAt: '2026-09-02T12:00:00.000Z' }
    ])
    expect(portableBilledRanges(b, true)).toMatchObject([
      { sessionId: id, clientId: localClient(b), startedAt: '2026-09-02T10:00:00.000Z' }
    ])
    expect(portableBilledRanges(b, false)).toEqual([])
  })
})

describe('provider observations', () => {
  it('keeps a known paid state against a concurrent stale observation with a later server date', () => {
    exchange()
    recordProviderObservation(a, {
      providerInvoiceId: stripeInvoiceId,
      account,
      providerDate: 'Mon, 28 Sep 2026 03:00:00 GMT',
      status: status({ status: 'paid', amountPaidCents: 15000, amountDueCents: 15000 })
    })
    recordProviderObservation(b, {
      providerInvoiceId: stripeInvoiceId,
      account,
      providerDate: 'Mon, 28 Sep 2026 05:00:00 GMT',
      status: status({ amountPaidCents: 5000 })
    })
    expect(savedInvoice(b)!.amountPaidCents).toBe(5000)
    exchange()
    for (const db of [a, b]) {
      expect(savedInvoice(db)).toMatchObject({ status: 'paid', amountPaidCents: 15000 })
      const view = readProviderObservation(db, workspaceId, stripeInvoiceId)
      expect(view.effective).toMatchObject({
        status: 'paid',
        providerDate: '2026-09-28T03:00:00.000Z'
      })
      expect(view.heads).toHaveLength(2)
    }
  })

  it('persists a partial payment whose status string is unchanged', () => {
    exchange()
    recordProviderObservation(a, {
      providerInvoiceId: stripeInvoiceId,
      account,
      providerDate: 'Mon, 28 Sep 2026 03:00:00 GMT',
      status: status({})
    })
    exchange()
    const result = recordProviderObservation(b, {
      providerInvoiceId: stripeInvoiceId,
      account,
      providerDate: 'Mon, 28 Sep 2026 02:00:00 GMT',
      status: status({ amountPaidCents: 4000, amountDueCents: 15000 })
    })
    expect(result.changed).toBe(true)
    exchange()
    // Causally later, so it wins even with an earlier server date.
    expect(savedInvoice(a)).toMatchObject({ status: 'open', amountPaidCents: 4000 })
    // Repeating an identical retrieved observation adds nothing.
    expect(
      recordProviderObservation(a, {
        providerInvoiceId: stripeInvoiceId,
        account,
        providerDate: 'Mon, 28 Sep 2026 06:00:00 GMT',
        status: status({ amountPaidCents: 4000 })
      }).changeId
    ).toBeNull()
  })

  it('never lets a wrong-account key refresh a saved invoice', () => {
    exchange()
    expect(() =>
      recordProviderObservation(b, {
        providerInvoiceId: stripeInvoiceId,
        account: { accountId: 'acct_other', testMode: true },
        providerDate: null,
        status: status({ status: 'void' })
      })
    ).toThrow(expect.objectContaining({ code: 'STRIPE_ACCOUNT_MISMATCH' }))
    expect(savedInvoice(b)!.status).toBe('open')
  })

  it('ignores a regression that claims to follow a terminal state', () => {
    const invoiceId = invoiceSyncId(stripeInvoiceId)
    const base: PortableProviderObservation = {
      version: 1,
      invoiceId,
      providerInvoiceId: stripeInvoiceId,
      accountId: account.accountId,
      testMode: true,
      basis: 'retrieved',
      status: 'void',
      amountDueCents: 0,
      amountPaidCents: 0,
      currency: 'usd',
      hostedUrl: null,
      invoicePdf: null,
      dueDate: null,
      paidAt: null,
      providerDate: '2026-09-28T03:00:00.000Z',
      supersedes: []
    }
    const voided = { id: '00000000-0000-8000-8000-000000000001', dependencies: [], payload: base }
    const later = {
      id: '00000000-0000-8000-8000-000000000002',
      dependencies: [],
      payload: { ...base, status: 'open' as const, supersedes: [voided.id] }
    }
    const view = providerObservationView([voided, later])
    expect(view.effective).toMatchObject({ status: 'void' })
    expect(view.ignoredRegressions).toEqual([later.id])
  })
})

describe('strict portable records', () => {
  const invoiceChange = (): SyncChange => {
    const row = a.select().from(syncChanges).where(eq(syncChanges.entityType, 'invoice')).get()!
    return JSON.parse(row.changeJson) as SyncChange
  }

  it('rejects unknown fields, credential-shaped text, revisions and forged keys', () => {
    const change = invoiceChange()
    expect(() => validateInvoiceChange(change)).not.toThrow()
    expect(() =>
      validateInvoiceChange({ ...change, payload: { ...change.payload, apiKey: 'x' } })
    ).toThrow(/unsupported fields/)
    expect(() =>
      validateInvoiceChange({
        ...change,
        payload: { ...change.payload, memo: 'key sk_live_abc123' }
      })
    ).toThrow(/credential/)
    expect(() => validateInvoiceChange({ ...change, kind: 'revision' })).toThrow(/immutable/)
    expect(() =>
      validateInvoiceChange({
        ...change,
        payload: { ...change.payload, providerInvoiceId: 'in_forged' }
      })
    ).toThrow(/keyed/)
    const step: SyncChange = {
      id: randomUUID(),
      kind: 'fact',
      entityType: 'provider-intent',
      entityId: randomUUID(),
      dependencies: [randomUUID()],
      payload: {}
    }
    step.payload = {
      version: 1,
      record: 'step',
      operationId: step.entityId,
      name: 'send',
      request: { invoice: stripeInvoiceId, headers: { authorization: 'x' } },
      idempotencyKey: `clautime:${step.entityId}:send`,
      startedProviderAt: '2026-09-28T02:00:00.000Z'
    }
    expect(() => validateInvoiceChange(step)).toThrow(/unsupported fields/)
  })

  it('rejects a change whose ID is not its content ID', () => {
    exchange()
    const change = { ...invoiceChange(), id: randomUUID() }
    expect(() => record(b, [change])).toThrow(/content ID/)
  })
})

// ── Cross-computer resume with a mocked Stripe account shared by both computers ──

type Row = Record<string, unknown> & { id: string }

function fakeStripe() {
  const state = {
    date: 'Mon, 28 Sep 2026 02:00:00 GMT',
    customers: [] as Row[],
    invoices: [] as Row[],
    items: [] as Row[],
    writes: [] as Array<{ method: string; key: string }>,
    lose: new Set<string>(),
    seq: 0
  }
  const keys = new Map<string, Row>()
  const write =
    (method: string, effect: (params: Record<string, unknown>) => Row) =>
    async (params: Record<string, unknown>, options: { idempotencyKey: string }) => {
      state.writes.push({ method, key: options.idempotencyKey })
      let result = keys.get(options.idempotencyKey)
      if (!result) {
        result = effect(params)
        keys.set(options.idempotencyKey, result)
      }
      if (state.lose.delete(method)) throw new Error('socket hang up')
      return { ...result }
    }
  const page = (rows: Row[]) => ({ data: rows, has_more: false })
  const stripe = {
    accounts: { retrieve: async () => ({ id: account.accountId }) },
    balance: {
      retrieve: async () => ({ livemode: false, lastResponse: { headers: { date: state.date } } })
    },
    customers: {
      retrieve: async () => {
        throw Object.assign(new Error('missing'), { code: 'resource_missing', statusCode: 404 })
      },
      list: async (params: { email: string }) =>
        page(state.customers.filter((row) => row.email === params.email)),
      create: write('customers.create', (params) => {
        const row = { ...params, id: `cus_${++state.seq}`, livemode: false }
        state.customers.push(row)
        return row
      })
    },
    invoices: {
      create: write('invoices.create', (params) => {
        const row = {
          ...params,
          id: `in_op${++state.seq}`,
          livemode: false,
          status: 'draft',
          amount_due: 0,
          currency: 'usd',
          created: 1790560000
        }
        state.invoices.push(row)
        return row
      }),
      list: async (params: { customer: string }) =>
        page(state.invoices.filter((row) => row.customer === params.customer)),
      retrieve: async (id: string) => ({ ...state.invoices.find((row) => row.id === id)! })
    },
    invoiceItems: {
      create: write('invoiceItems.create', (params) => {
        const row = { ...params, id: `ii_${++state.seq}`, livemode: false }
        state.items.push(row)
        return row
      }),
      list: async (params: { invoice: string }) =>
        page(state.items.filter((row) => row.invoice === params.invoice))
    }
  }
  return { state, stripe: stripe as unknown as Stripe }
}

describe('provider intents', () => {
  it('resumes an uncertain create on the other computer with its frozen request and keys', async () => {
    exchange()
    const fake = fakeStripe()
    const session = a
      .select()
      .from(sessions)
      .where(eq(sessions.id, manualSession(a)))
      .get()!
    const operationId = randomUUID()
    const clientA: InvoiceClient = {
      localId: localClient(a),
      syncId: clientSyncId,
      name: 'Acme',
      email: 'billing@acme.test',
      stripeCustomerId: null
    }
    const request = {
      operationId,
      clientId: localClient(a),
      memo: 'October',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      lineItems: [{ description: 'Build', amountCents: 15000, hours: 1.5, rateCents: 10000 }],
      lineMeta: [
        {
          lineDate: '2026-09-02',
          durationMinutes: 90,
          sessionIds: [session.id],
          billedRanges: [
            {
              sessionId: session.id,
              clientId: session.clientId,
              projectId: session.projectId,
              startedAt: session.startedAt,
              endedAt: session.endedAt
            }
          ]
        }
      ]
    }
    fake.state.lose.add('invoices.create')
    await expect(
      createDraftInvoiceOperation(a, fake.stripe, true, request, clientA)
    ).rejects.toThrow('socket hang up')
    const stepA = a
      .select()
      .from(providerOperationSteps)
      .where(
        and(
          eq(providerOperationSteps.operationId, operationId),
          eq(providerOperationSteps.name, 'invoice')
        )
      )
      .get()!

    const fetch = vi.spyOn(globalThis, 'fetch')
    exchange()
    expect(fetch).not.toHaveBeenCalled()
    expect(fake.state.writes.filter((w) => w.method === 'invoices.create')).toHaveLength(1)

    // B restored the operation, the uncertain step (same key and Stripe start Date) and the customer.
    const operation = b
      .select()
      .from(providerOperations)
      .where(eq(providerOperations.id, operationId))
      .get()!
    expect(
      b
        .select()
        .from(providerOperationSteps)
        .where(
          and(
            eq(providerOperationSteps.operationId, operationId),
            eq(providerOperationSteps.name, 'invoice')
          )
        )
        .get()
    ).toEqual(stepA)
    expect(b.select().from(providerOperationResults).all()).toMatchObject([{ name: 'customer' }])
    // The pending guard carries across: a new operation for this client is blocked on B.
    expect(() => requireNoPendingInvoice(b, randomUUID(), clientSyncId, account)).toThrow(
      expect.objectContaining({ code: 'INVOICE_OPERATION_PENDING' })
    )

    const frozen = readFrozenInvoiceRequest(JSON.parse(operation.requestJson))
    const local = resolvePortableBilling(b, frozen.billing)
    expect(local.lines[0].sessionIds).toEqual([manualSession(b)])
    const created = await createDraftInvoiceOperation(
      b,
      fake.stripe,
      true,
      requestFromFrozenInvoice(operationId, localClient(b), frozen, local),
      { localId: localClient(b), syncId: clientSyncId, ...frozen.customer, stripeCustomerId: null },
      { resume: true }
    )
    expect(created.frozen).toEqual(frozen)
    expect(created.localBilling.lines[0].sessionIds).toEqual([manualSession(b)])
    expect(fake.state.invoices).toHaveLength(1)
    expect(fake.state.customers).toHaveLength(1)
    expect(fake.state.items).toHaveLength(1)
    expect(created.draft.invoiceId).toBe(fake.state.invoices[0].id)

    // B's result is journaled with the step; A imports it without contacting Stripe.
    const writes = fake.state.writes.length
    exchange()
    expect(fake.state.writes).toHaveLength(writes)
    expect(
      a
        .select()
        .from(providerOperationResults)
        .where(
          and(
            eq(providerOperationResults.operationId, operationId),
            eq(providerOperationResults.name, 'invoice')
          )
        )
        .get()
    ).toMatchObject({ resultJson: JSON.stringify({ invoiceId: created.draft.invoiceId }) })
  })
})

// ── Cancellations revalidated against later facts (delayed or reordered folder files) ──

describe('imported cancellations', () => {
  const draftId = 'in_draft1'
  const startedProviderAt = '2026-09-28T02:00:00.000Z'

  /** Each call is an independent batch file (its own writer), deliverable in any order. */
  function publish(from: Db): SyncBatch[] {
    const batches: SyncBatch[] = []
    while (true) {
      const batch = assembleOutgoingBatch(from, workspaceId, {
        writerEpochId: randomUUID(),
        deviceId: randomUUID()
      })
      if (!batch) return batches
      sent.push(batch)
      batches.push(batch)
    }
  }
  function deliver(to: Db, batches: SyncBatch[]): void {
    for (const batch of batches) retainIncomingBatch(to, workspaceId, batch, adapter)
    const result = applyReadySyncBatches(to, workspaceId, adapter)
    expect(result.errors).toEqual([])
    expect(result.waiting).toEqual([])
    refreshInvoiceSyncProjections(to)
  }
  const intents = (batches: SyncBatch[]) =>
    batches
      .flatMap((batch) => batch.changes)
      .filter((change) => change.entityType === 'provider-intent')
      .map((change) => `${change.payload.record}:${change.payload.name ?? ''}`)

  function step(db: Db, operationId: string, name: string, request: JsonObject): void {
    const row = db
      .insert(providerOperationSteps)
      .values({
        operationId,
        name,
        requestJson: canonicalJson(request),
        idempotencyKey: `clautime:${operationId}:${name}`,
        startedProviderAt
      })
      .returning()
      .get()
    providerIntentJournal.step(db, row)
  }
  function result(db: Db, operationId: string, name: string, value: JsonObject): void {
    const row = db
      .insert(providerOperationResults)
      .values({ operationId, name, resultJson: canonicalJson(value) })
      .returning()
      .get()
    providerIntentJournal.result(db, row)
  }
  const item = (operationId: string, name: string): JsonObject => ({
    customer: 'cus_1',
    invoice: draftId,
    description: 'Build',
    currency: 'usd',
    amount: 7500,
    metadata: { clautime_operation_id: operationId, clautime_step: name }
  })

  /** A draft on A with a customer, the draft invoice and item-0 confirmed. */
  function draftOnA(): string {
    const session = a
      .select()
      .from(sessions)
      .where(eq(sessions.id, manualSession(a)))
      .get()!
    const operationId = randomUUID()
    const billing = portableBillingFromLocal(a, {
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      lines: [
        {
          lineDate: '2026-09-02',
          durationMinutes: 90,
          sessionIds: [session.id],
          billedRanges: [
            {
              sessionId: session.id,
              clientId: session.clientId,
              projectId: session.projectId,
              startedAt: session.startedAt,
              endedAt: session.endedAt
            }
          ]
        },
        { lineDate: '2026-09-02', durationMinutes: null, sessionIds: null, billedRanges: null }
      ]
    })
    const frozen = freezeInvoiceRequest(
      {
        operationId,
        clientId: localClient(a),
        lineItems: [
          { description: 'Build', amountCents: 7500 },
          { description: 'Review', amountCents: 7500 }
        ]
      },
      {
        localId: localClient(a),
        syncId: clientSyncId,
        name: 'Acme',
        email: 'billing@acme.test',
        stripeCustomerId: null
      },
      billing
    )
    retainProviderOperation(a, {
      id: operationId,
      ...account,
      kind: 'create-invoice',
      request: frozen as unknown as JsonObject
    })
    step(a, operationId, 'customer', {
      email: 'billing@acme.test',
      name: 'Acme',
      metadata: { clautime_operation_id: operationId, clautime_client_sync_id: clientSyncId }
    })
    result(a, operationId, 'customer', { customerId: 'cus_1' })
    step(a, operationId, 'invoice', {
      customer: 'cus_1',
      auto_advance: false,
      pending_invoice_items_behavior: 'exclude',
      collection_method: 'send_invoice',
      days_until_due: 30,
      payment_settings: { payment_method_types: ['card'] },
      metadata: { clautime_operation_id: operationId }
    })
    result(a, operationId, 'invoice', { invoiceId: draftId })
    step(a, operationId, 'item-0', item(operationId, 'item-0'))
    result(a, operationId, 'item-0', { invoiceItemId: 'ii_0' })
    return operationId
  }

  /** A deleted the draft in Stripe and cancelled with proof covering only what A knew. */
  function cancelOnA(operationId: string): void {
    recordProviderResolution(a, operationId, {
      version: 1,
      basis: 'draft-deleted',
      rejectedSteps: [],
      invoiceId: draftId,
      itemIds: ['ii_0'],
      checkedProviderAt: '2026-09-28T03:00:00.000Z'
    })
  }

  const resolved = (db: Db, operationId: string) =>
    db
      .select()
      .from(providerOperationResolutions)
      .where(eq(providerOperationResolutions.operationId, operationId))
      .get()
  const held = (db: Db, operationId: string) =>
    invoiceBillingBlockers(db, workspaceId, clientSyncId).some(
      (blocker) => blocker.entityType === 'provider-intent' && blocker.entityId === operationId
    )
  const frozenWork = (db: Db) => [
    expect.objectContaining({ sessionId: manualSession(db), startedAt: '2026-09-02T10:00:00.000Z' })
  ]

  it('holds a cancellation contradicted by a late item, in either arrival order, without Stripe', () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    exchange()
    const c = database()
    deliver(c, [...sent])
    const operationId = draftOnA()
    const draft = publish(a)
    expect(intents(draft)).toEqual(
      expect.arrayContaining(['operation:', 'step:invoice', 'result:invoice', 'result:item-0'])
    )
    deliver(b, draft)
    deliver(c, draft)

    // C resumed the draft and started item-1; Stripe's response was lost (unsettled).
    step(c, operationId, 'item-1', item(operationId, 'item-1'))
    const lateStep = publish(c)
    expect(intents(lateStep)).toEqual(['step:item-1'])

    // A, unaware of item-1, cancels. Locally that releases the frozen work.
    cancelOnA(operationId)
    const cancellation = publish(a)
    expect(intents(cancellation)).toEqual(['resolution:'])
    expect(operationBilledRanges(a, true)).toEqual([])

    // Late step first (C): the unsettled step is never released by the imported cancellation.
    deliver(c, cancellation)
    expect(resolved(c, operationId)).toBeUndefined()
    expect(held(c, operationId)).toBe(true)
    expect(operationBilledRanges(c, true)).toEqual(frozenWork(c))

    // Cancellation first (B): released on arrival, then held again once the late step arrives.
    deliver(b, cancellation)
    expect(resolved(b, operationId)).toBeDefined()
    expect(held(b, operationId)).toBe(false)
    expect(operationBilledRanges(b, true)).toEqual([])
    deliver(b, lateStep)
    expect(resolved(b, operationId)).toBeDefined() // kept for audit
    expect(held(b, operationId)).toBe(true)
    expect(operationBilledRanges(b, true)).toEqual(frozenWork(b))
    expect(() => requireNoInvoiceBillingBlockers(b, clientSyncId)).toThrow(
      expect.objectContaining({ code: 'INVOICE_SYNC_BLOCKED' })
    )

    // The lost response arrives: item-1 exists and was never verified deleted, so it stays held.
    result(c, operationId, 'item-1', { invoiceItemId: 'ii_9' })
    const lateResult = publish(c)
    expect(intents(lateResult)).toEqual(['result:item-1'])
    deliver(b, lateResult)
    expect(held(b, operationId)).toBe(true)
    expect(operationBilledRanges(b, true)).toEqual(frozenWork(b))

    // The cancelling computer itself revalidates its own cancellation on the late arrivals.
    deliver(a, [...lateStep, ...lateResult])
    expect(resolved(a, operationId)).toBeDefined()
    expect(held(a, operationId)).toBe(true)
    expect(operationBilledRanges(a, true)).toEqual(frozenWork(a))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('releases a reordered cancellation once the delayed facts it covers settle consistently', () => {
    exchange()
    const operationId = draftOnA()
    const draft = publish(a)
    // item-1 was confirmed on A before cancelling, but its file is delayed behind the cancellation.
    step(a, operationId, 'item-1', item(operationId, 'item-1'))
    result(a, operationId, 'item-1', { invoiceItemId: 'ii_1' })
    const delayed = publish(a)
    recordProviderResolution(a, operationId, {
      version: 1,
      basis: 'draft-deleted',
      rejectedSteps: [],
      invoiceId: draftId,
      itemIds: ['ii_0', 'ii_1'],
      checkedProviderAt: '2026-09-28T03:00:00.000Z'
    })
    const cancellation = publish(a)
    deliver(b, draft)
    deliver(b, cancellation)
    expect(resolved(b, operationId)).toBeDefined()
    expect(operationBilledRanges(b, true)).toEqual([])
    // The step is briefly unsettled while applying; its covered result settles it again.
    deliver(b, delayed)
    expect(held(b, operationId)).toBe(false)
    expect(operationBilledRanges(b, true)).toEqual([])
    expect(() => requireNoInvoiceBillingBlockers(b, clientSyncId)).not.toThrow()
  })
})
