// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type Stripe from 'stripe'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { invoices } from '../db/schema/invoices'
import { retainCustomerReference } from './invoice-provider-scope'
import { pendingInvoiceOperations } from './pending-invoice-operations'
import {
  providerOperations,
  providerOperationSteps,
  providerOperationRejections,
  providerOperationResolutions
} from '../db/schema/provider-operations'
import type { CreateInvoiceRequest } from '../../shared/types/invoice'
import {
  createDraftInvoiceOperation,
  invoiceOperationId,
  localInvoiceFromOperation,
  readStripeContext,
  sendInvoiceOperation,
  voidInvoiceOperation,
  type InvoiceClient
} from './stripe-operation-service'
import { cancelInvoiceOperation } from './invoice-operation-resolution'

type Row = Record<string, unknown> & { id: string }

const start = 'Mon, 28 Sep 2026 02:00:00 GMT'
const within = 'Mon, 28 Sep 2026 03:00:00 GMT'
const beyond = 'Wed, 30 Sep 2026 02:00:00 GMT'

/** In-memory Stripe: models idempotency keys and responses lost after the effect. */
function fakeStripe() {
  const state = {
    accountId: 'acct_fixture',
    livemode: false,
    date: start,
    customers: [] as Row[],
    invoices: [] as Row[],
    items: [] as Row[],
    writes: [] as Array<{ method: string; key: string }>,
    lose: new Set<string>(),
    /** Stripe refuses these writes before executing them (nothing saved under the key). */
    reject: new Map<string, Error>(),
    seq: 0
  }
  const keys = new Map<string, unknown>()
  const write =
    <P>(method: string, effect: (params: P, id?: string) => Row) =>
    async (...args: unknown[]): Promise<Row> => {
      const options = args[args.length - 1] as { idempotencyKey?: string }
      const key = options?.idempotencyKey ?? ''
      state.writes.push({ method, key })
      let result = keys.get(key) as Row | undefined
      // A saved result is replayed even when the request would now fail validation.
      const refusal = state.reject.get(method)
      if (!result && refusal) throw refusal
      if (!result) {
        result = typeof args[0] === 'string' ? effect(args[1] as P, args[0]) : effect(args[0] as P)
        if (key) keys.set(key, result)
      }
      if (state.lose.delete(method)) throw new Error('socket hang up')
      return { ...result }
    }
  const page = (rows: Row[], params: { limit?: number; starting_after?: string }) => {
    const from = params.starting_after
      ? rows.findIndex((row) => row.id === params.starting_after) + 1
      : 0
    const limit = params.limit ?? 10
    return { data: rows.slice(from, from + limit), has_more: from + limit < rows.length }
  }
  const missing = () =>
    Object.assign(new Error('No such object'), { code: 'resource_missing', statusCode: 404 })
  const invoice = (id: string) => {
    const found = state.invoices.find((row) => row.id === id)
    if (!found) throw missing()
    return found
  }
  const stripe = {
    accounts: { retrieve: vi.fn(async () => ({ id: state.accountId, email: 'secret@x' })) },
    balance: {
      retrieve: vi.fn(async () => ({
        livemode: state.livemode,
        available: [],
        lastResponse: { headers: { date: state.date, 'request-id': 'req_1' } }
      }))
    },
    customers: {
      retrieve: vi.fn(async (id: string) => {
        const found = state.customers.find((row) => row.id === id)
        if (!found) throw missing()
        return found
      }),
      list: vi.fn(async (params: { email: string; limit?: number; starting_after?: string }) =>
        page(
          state.customers.filter((row) => row.email === params.email),
          params
        )
      ),
      create: vi.fn(
        write('customers.create', (params: Record<string, unknown>) => {
          const row = { ...params, id: `cus_${++state.seq}`, livemode: state.livemode }
          state.customers.push(row)
          return row
        })
      )
    },
    invoices: {
      create: vi.fn(
        write('invoices.create', (params: Record<string, unknown>) => {
          const row = {
            ...params,
            id: `in_${++state.seq}`,
            livemode: state.livemode,
            status: 'draft',
            amount_due: 0,
            subtotal: 0,
            amount_paid: 0,
            currency: 'usd',
            hosted_invoice_url: null,
            invoice_pdf: null,
            due_date: null,
            created: 1790560000,
            status_transitions: { paid_at: null }
          }
          state.invoices.unshift(row)
          return row
        })
      ),
      list: vi.fn(async (params: { customer: string; limit?: number; starting_after?: string }) =>
        page(
          state.invoices.filter((row) => row.customer === params.customer),
          params
        )
      ),
      retrieve: vi.fn(async (id: string) => ({ ...invoice(id) })),
      finalizeInvoice: vi.fn(
        write('invoices.finalizeInvoice', (_: unknown, id?: string) =>
          Object.assign(invoice(id!), { status: 'open' })
        )
      ),
      sendInvoice: vi.fn(write('invoices.sendInvoice', (_: unknown, id?: string) => invoice(id!))),
      voidInvoice: vi.fn(
        write('invoices.voidInvoice', (_: unknown, id?: string) =>
          Object.assign(invoice(id!), { status: 'void' })
        )
      )
    },
    invoiceItems: {
      create: vi.fn(
        write('invoiceItems.create', (params: Record<string, unknown>) => {
          const amount =
            (params.amount as number | undefined) ??
            Math.round(Number(params.quantity_decimal) * Number(params.unit_amount_decimal))
          const row = { ...params, id: `ii_${++state.seq}`, livemode: state.livemode, amount }
          state.items.push(row)
          const target = invoice(params.invoice as string)
          target.amount_due = (target.amount_due as number) + amount
          target.subtotal = (target.subtotal as number) + amount
          return row
        })
      ),
      list: vi.fn(async (params: { invoice: string; limit?: number; starting_after?: string }) =>
        page(
          state.items.filter((row) => row.invoice === params.invoice),
          params
        )
      ),
      retrieve: vi.fn(async (id: string) => {
        const found = state.items.find((row) => row.id === id)
        if (!found) throw missing()
        return { ...found }
      })
    }
  }
  return { state, stripe: stripe as unknown as Stripe, mock: stripe }
}

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
let fake: ReturnType<typeof fakeStripe>
let client: InvoiceClient

beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  fake = fakeStripe()
  client = {
    syncId: randomUUID(),
    name: 'Acme',
    email: 'billing@acme.test',
    stripeCustomerId: null
  }
  // The billed rows named by draftRequest(); frozen requests name them by portable identity.
  db.insert(clients).values({ id: 7, syncId: client.syncId, name: 'Acme', color: '#000000' }).run()
  db.insert(projects).values({ id: 3, clientId: 7, name: 'Site' }).run()
  for (const id of [11, 12])
    db.insert(sessions)
      .values({
        id,
        projectPath: '',
        startedAt: '2026-09-02T10:00:00Z',
        endedAt: '2026-09-02T11:30:00Z',
        durationMinutes: 90,
        clientId: 7,
        projectId: 3
      })
      .run()
})
afterEach(() => sqlite.close())

function draftRequest(overrides: Partial<CreateInvoiceRequest> = {}): CreateInvoiceRequest {
  return {
    operationId: randomUUID(),
    clientId: 7,
    memo: 'September work',
    daysUntilDue: 14,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    lineItems: [
      { description: 'Day one', amountCents: 15000, hours: 1.5, rateCents: 10000 },
      { description: 'Fixed fee', amountCents: 2500 }
    ],
    lineMeta: [
      {
        lineDate: '2026-09-02',
        durationMinutes: 90,
        sessionIds: [11, 12],
        billedRanges: [
          {
            sessionId: 11,
            projectId: 3,
            clientId: 7,
            startedAt: '2026-09-02T10:00:00Z',
            endedAt: '2026-09-02T11:30:00Z'
          }
        ]
      },
      {}
    ],
    ...overrides
  }
}

const create = (request: CreateInvoiceRequest) =>
  createDraftInvoiceOperation(db, fake.stripe, true, request, client)
const writes = (method: string) => fake.state.writes.filter((w) => w.method === method)

describe('readStripeContext', () => {
  it('returns only account, mode and the server date', async () => {
    expect(await readStripeContext(fake.stripe, true)).toEqual({
      accountId: 'acct_fixture',
      testMode: true,
      providerDate: start
    })
  })

  it('rejects a key whose mode differs from the selected mode', async () => {
    fake.state.livemode = true
    await expect(readStripeContext(fake.stripe, true)).rejects.toMatchObject({
      code: 'STRIPE_MODE_MISMATCH'
    })
  })
})

describe('createDraftInvoiceOperation', () => {
  it('retains an unfinished draft across a reload and blocks a new operation for that client', async () => {
    const request = draftRequest()
    fake.state.lose.add('invoices.create')
    await expect(create(request)).rejects.toThrow('socket hang up')
    const reopened = drizzle(sqlite)
    expect(pendingInvoiceOperations(reopened)).toMatchObject([
      { operationId: request.operationId, amountCents: 17500, providerInvoiceId: null }
    ])
    await expect(
      createDraftInvoiceOperation(reopened, fake.stripe, true, draftRequest(), client)
    ).rejects.toMatchObject({ code: 'INVOICE_OPERATION_PENDING' })
    expect(writes('invoices.create')).toHaveLength(1)
    const result = await createDraftInvoiceOperation(reopened, fake.stripe, true, request, client)
    expect(fake.state.invoices).toHaveLength(1)
    expect(result.draft.invoiceId).toBe(fake.state.invoices[0].id)
  })

  it('requires the client?s saved account before creating a provider intent or object', async () => {
    client.localId = 7
    retainCustomerReference(db, 7, { accountId: 'acct_original', testMode: true }, 'cus_original')
    await expect(create(draftRequest())).rejects.toMatchObject({ code: 'STRIPE_ACCOUNT_MISMATCH' })
    expect(pendingInvoiceOperations(db)).toEqual([])
    expect(fake.state.writes).toEqual([])
  })

  it('uses separate test/live customer references', async () => {
    client.localId = 7
    retainCustomerReference(db, 7, { accountId: 'acct_fixture', testMode: false }, 'cus_live')
    retainCustomerReference(db, 7, { accountId: 'acct_fixture', testMode: true }, 'cus_test')
    fake.state.customers.push({ id: 'cus_test', livemode: false, email: client.email })
    client.stripeCustomerId = 'cus_live'
    expect((await create(draftRequest())).draft.stripeCustomerId).toBe('cus_test')
    expect(fake.mock.customers.retrieve).toHaveBeenCalledWith('cus_test')
    expect(writes('customers.create')).toHaveLength(0)
  })

  it('keeps a completed hidden invoice out of the unfinished-operation list', async () => {
    const request = draftRequest()
    const result = await create(request)
    db.insert(invoices)
      .values({
        clientId: 7,
        stripeInvoiceId: result.draft.invoiceId,
        operationId: request.operationId,
        providerAccountId: result.account.accountId,
        testMode: 1,
        hidden: 1,
        createdAt: 'x',
        updatedAt: 'x'
      })
      .run()
    expect(pendingInvoiceOperations(db)).toEqual([])
    await create(draftRequest())
    expect(fake.state.invoices).toHaveLength(2)
  })

  it('creates tagged objects once with frozen step keys and returns a safe snapshot', async () => {
    const request = draftRequest()
    const first = await create(request)
    expect(first.draft).toEqual({
      invoiceId: expect.stringMatching(/^in_/),
      stripeCustomerId: expect.stringMatching(/^cus_/),
      status: 'draft',
      amountDueCents: 17500,
      currency: 'usd',
      hostedUrl: null,
      invoicePdf: null,
      createdAt: new Date(1790560000 * 1000).toISOString()
    })
    expect(JSON.stringify(first)).not.toMatch(/lastResponse|request-id|secret/)
    const [created] = fake.state.invoices
    expect(created.metadata).toEqual({ clautime_operation_id: request.operationId })
    expect(fake.state.items.map((item) => item.metadata)).toEqual([
      { clautime_operation_id: request.operationId, clautime_step: 'item-0' },
      { clautime_operation_id: request.operationId, clautime_step: 'item-1' }
    ])
    expect(fake.state.items[0]).toMatchObject({
      quantity_decimal: '1.5',
      unit_amount_decimal: '10000'
    })
    expect(writes('invoices.create')[0].key).toBe(`clautime:${request.operationId}:invoice`)

    // Double-click / retry of the same draft: saved results, no provider writes.
    const count = fake.state.writes.length
    const [again, concurrent] = await Promise.all([create(request), create(request)])
    expect(again).toEqual(first)
    expect(concurrent).toEqual(first)
    expect(fake.state.writes).toHaveLength(count)
  })

  it('requires an operation ID and never contacts Stripe without one', async () => {
    await expect(create(draftRequest({ operationId: '' }))).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_OPERATION'
    })
    expect(fake.mock.accounts.retrieve).not.toHaveBeenCalled()
  })

  it('rejects a changed amount under the same operation ID', async () => {
    const request = draftRequest()
    await create(request)
    const count = fake.state.writes.length
    const changed = {
      ...request,
      lineItems: [{ ...request.lineItems[0], hours: 2 }, request.lineItems[1]]
    }
    await expect(create(changed)).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_CONFLICT' })
    expect(fake.state.writes).toHaveLength(count)
  })

  it('rejects a different Stripe account for a saved operation before any write', async () => {
    const request = draftRequest()
    fake.state.lose.add('invoices.create')
    await expect(create(request)).rejects.toThrow('socket hang up')
    fake.state.accountId = 'acct_other'
    const count = fake.state.writes.length
    await expect(create(request)).rejects.toMatchObject({ code: 'STRIPE_ACCOUNT_MISMATCH' })
    expect(fake.state.writes).toHaveLength(count)
  })

  it('recovers an invoice whose response was lost, even beyond the retry window', async () => {
    const request = draftRequest()
    fake.state.lose.add('invoices.create')
    await expect(create(request)).rejects.toThrow('socket hang up')
    fake.state.date = beyond
    const result = await create(request)
    expect(fake.state.invoices).toHaveLength(1)
    expect(writes('invoices.create')).toHaveLength(1)
    expect(result.draft.invoiceId).toBe(fake.state.invoices[0].id)
    expect(result.draft.amountDueCents).toBe(17500)
  })

  it('recovers a line item whose response was lost without adding it twice', async () => {
    const request = draftRequest()
    fake.state.lose.add('invoiceItems.create')
    await expect(create(request)).rejects.toThrow('socket hang up')
    fake.state.date = beyond
    await create(request)
    expect(fake.state.items).toHaveLength(2)
    expect(writes('invoiceItems.create')).toHaveLength(2)
  })

  it('holds an unproven invoice creation beyond the window instead of creating another', async () => {
    const request = draftRequest()
    fake.state.lose.add('invoices.create')
    await expect(create(request)).rejects.toThrow('socket hang up')
    // An empty lookup is not proof that the lost write did nothing.
    fake.mock.invoices.list.mockResolvedValueOnce({ data: [], has_more: false })
    fake.state.date = beyond
    await expect(create(request)).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_UNCERTAIN' })
    expect(writes('invoices.create')).toHaveLength(1)
  })

  it('retries an unproven step inside the window with the same key and frozen body', async () => {
    const request = draftRequest()
    fake.state.lose.add('invoices.create')
    await expect(create(request)).rejects.toThrow('socket hang up')
    fake.mock.invoices.list.mockResolvedValueOnce({ data: [], has_more: false })
    fake.state.date = within
    await create(request)
    const [a, b] = writes('invoices.create')
    expect(b.key).toBe(a.key)
    expect(fake.state.invoices).toHaveLength(1)
  })

  it('reuses a verified saved customer and propagates non-definitive retrieve errors', async () => {
    fake.state.customers.push({ id: 'cus_saved', email: 'old@acme.test', livemode: false })
    client.stripeCustomerId = 'cus_saved'
    const first = await create(draftRequest())
    expect(first.draft.stripeCustomerId).toBe('cus_saved')
    expect(writes('customers.create')).toHaveLength(0)

    // A separate client avoids the unfinished-draft guard in this lower-level fixture.
    client = { ...client, syncId: randomUUID() }
    fake.mock.customers.retrieve.mockRejectedValueOnce(
      Object.assign(new Error('rate limited'), { statusCode: 429 })
    )
    await expect(create(draftRequest())).rejects.toThrow('rate limited')
    expect(writes('customers.create')).toHaveLength(0)
  })

  it('replaces a saved customer only when Stripe definitely has no such customer', async () => {
    client.stripeCustomerId = 'cus_from_other_mode'
    const result = await create(draftRequest())
    expect(writes('customers.create')).toHaveLength(1)
    expect(result.draft.stripeCustomerId).not.toBe('cus_from_other_mode')
  })

  it('recovers a created customer by operation metadata', async () => {
    const request = draftRequest()
    fake.state.lose.add('customers.create')
    await expect(create(request)).rejects.toThrow('socket hang up')
    fake.state.date = beyond
    await create(request)
    expect(fake.state.customers).toHaveLength(1)
    expect(fake.state.invoices[0].customer).toBe(fake.state.customers[0].id)
  })

  it('maps the retained request, including local billing metadata, for local saving', async () => {
    const request = draftRequest()
    const { draft, frozen, localBilling } = await create(request)
    expect(frozen).not.toHaveProperty('clientId')
    expect(frozen).not.toHaveProperty('operationId')
    expect(frozen).not.toHaveProperty('localBilling')
    expect(frozen.clientSyncId).toBe(client.syncId)
    // Portable: no local row numbers; the anchor-less rows exclude by client/project bucket.
    expect(JSON.stringify(frozen)).not.toMatch(/sessionId|"clientId"|"projectId"/)
    expect(frozen.billing.lines[0].billed).toEqual([
      {
        anchor: { kind: 'bucket' },
        clientSyncId: client.syncId,
        projectSyncId: expect.any(String),
        startedAt: '2026-09-02T10:00:00.000Z',
        endedAt: '2026-09-02T11:30:00.000Z'
      }
    ])
    expect(localInvoiceFromOperation(frozen, draft, 7, true, localBilling)).toMatchObject({
      clientId: 7,
      stripeInvoiceId: draft.invoiceId,
      memo: 'September work',
      periodStart: '2026-09-01',
      testMode: true,
      lineItems: [
        {
          lineDate: '2026-09-02',
          amountCents: 15000,
          durationMinutes: 90,
          sessionIds: [11, 12],
          billedRanges: request.lineMeta![0].billedRanges,
          sortOrder: 0
        },
        { description: 'Fixed fee', amountCents: 2500, sessionIds: null, sortOrder: 1 }
      ]
    })
  })
})

describe('frozen request integrity', () => {
  it('ignores a renderer-injected portableBilling', async () => {
    const request = draftRequest()
    const injected = {
      ...request,
      portableBilling: { periodStart: null, periodEnd: null, lines: [] }
    } as CreateInvoiceRequest
    const { frozen } = await create(injected)
    expect(frozen.billing.periodStart).toBe('2026-09-01')
    expect(frozen.billing.lines[0].billed).toHaveLength(1)
  })

  it('reuses the retained billing on retry even when local anchors changed meanwhile', async () => {
    const request = draftRequest()
    fake.state.lose.add('invoices.create')
    await expect(create(request)).rejects.toThrow('socket hang up')
    const saved = JSON.parse(
      (
        sqlite.prepare('SELECT request_json AS json FROM provider_operations').get() as {
          json: string
        }
      ).json
    )
    // Row 11 gains a stable identity after the first attempt; recomputing would change the
    // frozen request and strand the uncertain write.
    sqlite.exec(
      `INSERT INTO manual_time_entries (id, session_id, basis) VALUES ('${randomUUID()}', 11, 'created')`
    )
    const result = await create(request)
    expect(result.frozen).toEqual(saved)
    expect(fake.state.invoices).toHaveLength(1)
  })

  it('runs preflight only when first retaining a new operation', async () => {
    const request = draftRequest()
    const preflight = vi.fn()
    fake.state.lose.add('invoices.create')
    await expect(
      createDraftInvoiceOperation(db, fake.stripe, true, request, client, { preflight })
    ).rejects.toThrow('socket hang up')
    await createDraftInvoiceOperation(db, fake.stripe, true, request, client, { preflight })
    expect(preflight).toHaveBeenCalledTimes(1)
  })

  it('a failed preflight retains nothing and writes nothing', async () => {
    const request = draftRequest()
    await expect(
      createDraftInvoiceOperation(db, fake.stripe, true, request, client, {
        preflight: () => {
          throw Object.assign(new Error('billed'), { code: 'INVOICE_WORK_ALREADY_BILLED' })
        }
      })
    ).rejects.toThrow('billed')
    expect(pendingInvoiceOperations(db)).toEqual([])
    expect(fake.state.writes).toEqual([])
  })

  it('resume uses the retained request as saved and rejects an unknown operation', async () => {
    const request = draftRequest()
    fake.state.lose.add('invoices.create')
    await expect(create(request)).rejects.toThrow('socket hang up')
    const changed = draftRequest({ operationId: request.operationId, memo: 'edited' })
    const resumed = await createDraftInvoiceOperation(db, fake.stripe, true, changed, client, {
      resume: true
    })
    expect(resumed.frozen.description).toBe('September work')
    await expect(
      createDraftInvoiceOperation(db, fake.stripe, true, draftRequest(), client, { resume: true })
    ).rejects.toMatchObject({ code: 'INVOICE_OPERATION_NOT_FOUND' })
  })

  it('returns the full retrieved status so a resumed paid invoice is not saved unpaid', async () => {
    const request = draftRequest()
    await create(request)
    Object.assign(fake.state.invoices[0], {
      status: 'paid',
      amount_paid: 17500,
      status_transitions: { paid_at: 1790600000 }
    })
    const again = await create(request)
    expect(again.observation.status).toMatchObject({
      status: 'paid',
      amountPaidCents: 17500,
      paidAt: new Date(1790600000 * 1000).toISOString()
    })
    expect(again.observation.account).toEqual({ accountId: 'acct_fixture', testMode: true })
  })
})

describe('sendInvoiceOperation', () => {
  async function draftInvoice(): Promise<string> {
    return (await create(draftRequest())).draft.invoiceId
  }

  it('finalizes and sends once; a repeat returns the saved result', async () => {
    const invoiceId = await draftInvoice()
    const read = await sendInvoiceOperation(db, fake.stripe, true, invoiceId)
    expect(read.status).toMatchObject({ invoiceId, status: 'open', amountDueCents: 17500 })
    // Provenance for recordProviderObservation: the reading account and Stripe's Date.
    expect(read.account).toEqual({ accountId: 'acct_fixture', testMode: true })
    expect(read.providerDate).toBe(start)
    await sendInvoiceOperation(db, fake.stripe, true, invoiceId)
    expect(writes('invoices.finalizeInvoice')).toHaveLength(1)
    expect(writes('invoices.sendInvoice')).toHaveLength(1)
    const operationId = invoiceOperationId(
      'send-invoice',
      { accountId: 'acct_fixture', testMode: true },
      invoiceId
    )
    expect(writes('invoices.sendInvoice')[0].key).toBe(`clautime:${operationId}:send`)
  })

  it('never repeats an uncertain send beyond the window although the invoice is open', async () => {
    const invoiceId = await draftInvoice()
    fake.state.lose.add('invoices.sendInvoice')
    await expect(sendInvoiceOperation(db, fake.stripe, true, invoiceId)).rejects.toThrow(
      'socket hang up'
    )
    fake.state.date = beyond
    await expect(sendInvoiceOperation(db, fake.stripe, true, invoiceId)).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_UNCERTAIN'
    })
    expect(writes('invoices.sendInvoice')).toHaveLength(1)
  })

  it('reuses the send key inside the window', async () => {
    const invoiceId = await draftInvoice()
    fake.state.lose.add('invoices.sendInvoice')
    await expect(sendInvoiceOperation(db, fake.stripe, true, invoiceId)).rejects.toThrow()
    fake.state.date = within
    await sendInvoiceOperation(db, fake.stripe, true, invoiceId)
    const [a, b] = writes('invoices.sendInvoice')
    expect(b.key).toBe(a.key)
  })

  it('recovers a lost finalize response from the retrieved status', async () => {
    const invoiceId = await draftInvoice()
    fake.state.lose.add('invoices.finalizeInvoice')
    await expect(sendInvoiceOperation(db, fake.stripe, true, invoiceId)).rejects.toThrow()
    fake.state.date = beyond
    await sendInvoiceOperation(db, fake.stripe, true, invoiceId)
    expect(writes('invoices.finalizeInvoice')).toHaveLength(1)
    expect(writes('invoices.sendInvoice')).toHaveLength(1)
  })

  it('refuses an invoice from the other mode and a paid invoice', async () => {
    const invoiceId = await draftInvoice()
    fake.state.invoices[0].livemode = true
    await expect(sendInvoiceOperation(db, fake.stripe, true, invoiceId)).rejects.toMatchObject({
      code: 'STRIPE_ACCOUNT_MISMATCH'
    })
    fake.state.invoices[0].livemode = false
    fake.state.invoices[0].status = 'paid'
    await expect(sendInvoiceOperation(db, fake.stripe, true, invoiceId)).rejects.toMatchObject({
      code: 'INVOICE_NOT_SENDABLE'
    })
    expect(writes('invoices.sendInvoice')).toHaveLength(0)
    expect(
      db
        .select()
        .from(providerOperationSteps)
        .all()
        .map((s) => s.name)
    ).not.toContain('send')
  })
})

describe('voidInvoiceOperation', () => {
  it('recovers a lost void response from the retrieved status beyond the window', async () => {
    const invoiceId = (await create(draftRequest())).draft.invoiceId
    fake.state.invoices[0].status = 'open'
    fake.state.lose.add('invoices.voidInvoice')
    await expect(voidInvoiceOperation(db, fake.stripe, true, invoiceId)).rejects.toThrow()
    fake.state.date = beyond
    expect((await voidInvoiceOperation(db, fake.stripe, true, invoiceId)).status).toMatchObject({
      status: 'void'
    })
    expect(writes('invoices.voidInvoice')).toHaveLength(1)
  })

  it('does not void a draft', async () => {
    const invoiceId = (await create(draftRequest())).draft.invoiceId
    await expect(voidInvoiceOperation(db, fake.stripe, true, invoiceId)).rejects.toMatchObject({
      code: 'INVOICE_NOT_VOIDABLE'
    })
  })
})

/** The Stripe SDK's shape for a request Stripe refused before executing it. */
function refusal(message: string, statusCode = 400, rawType = 'invalid_request_error'): Error {
  return Object.assign(new Error(message), {
    type: 'StripeInvalidRequestError',
    rawType,
    statusCode,
    code: 'parameter_invalid',
    requestId: 'req_fixture'
  })
}

const rejections = () => db.select().from(providerOperationRejections).all()
const resolutions = () => db.select().from(providerOperationResolutions).all()

describe('definite Stripe rejections', () => {
  it('makes a rejected invoice step terminal, then allows a proven cancellation and a new draft', async () => {
    const request = draftRequest()
    fake.state.reject.set(
      'invoices.create',
      refusal('The payment method type us_bank_account is invalid.')
    )
    await expect(create({ ...request, achOnly: true })).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_REJECTED',
      message: expect.stringContaining('us_bank_account')
    })
    expect(rejections()).toMatchObject([{ name: 'invoice' }])
    expect(JSON.parse(rejections()[0].proofJson)).toEqual({
      version: 1,
      provider: 'stripe',
      type: 'invalid_request_error',
      statusCode: 400,
      code: 'parameter_invalid',
      param: null,
      requestId: 'req_fixture',
      message: 'The payment method type us_bank_account is invalid.',
      // Stripe's Date from the account read before the attempt, never this computer's clock.
      attemptedProviderAt: '2026-09-28T02:00:00.000Z'
    })
    expect(pendingInvoiceOperations(db)).toMatchObject([
      { operationId: request.operationId, state: 'rejected', rejectionMessage: expect.any(String) }
    ])

    // Enabling ACH afterwards does not make the frozen attempt run again: it stays terminal.
    fake.state.reject.clear()
    const count = writes('invoices.create').length
    await expect(create({ ...request, achOnly: true })).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_REJECTED'
    })
    await expect(
      createDraftInvoiceOperation(db, fake.stripe, true, draftRequest(), client)
    ).rejects.toMatchObject({ code: 'INVOICE_OPERATION_PENDING' })
    expect(writes('invoices.create')).toHaveLength(count)

    // No invoice exists, so no Stripe key or read is needed for the proof.
    const reads = fake.mock.accounts.retrieve.mock.calls.length
    expect(await cancelInvoiceOperation(db, request.operationId, null)).toEqual({
      version: 1,
      basis: 'rejected-before-invoice',
      rejectedSteps: ['invoice'],
      invoiceId: null,
      itemIds: [],
      checkedProviderAt: null
    })
    expect(fake.mock.accounts.retrieve.mock.calls.length).toBe(reads)
    expect(pendingInvoiceOperations(db)).toEqual([])

    // The cancelled ID never runs again; a new ID for the same work does.
    await expect(create({ ...request, achOnly: true })).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_CANCELLED'
    })
    expect(fake.mock.accounts.retrieve.mock.calls.length).toBe(reads)
    const again = await create(draftRequest())
    expect(fake.state.invoices).toEqual([expect.objectContaining({ id: again.draft.invoiceId })])
  })

  it.each([
    ['lost response', () => fake.state.lose.add('invoices.create')],
    [
      'server error',
      () => fake.state.reject.set('invoices.create', refusal('boom', 500, 'api_error'))
    ],
    ['key in use', () => fake.state.reject.set('invoices.create', refusal('in use', 409))],
    [
      'rate limit',
      () => fake.state.reject.set('invoices.create', refusal('slow down', 429, 'rate_limit_error'))
    ],
    [
      'idempotency error',
      () =>
        fake.state.reject.set('invoices.create', refusal('keys differ', 400, 'idempotency_error'))
    ]
  ])('keeps a %s uncertain: never cancellable, even beyond the retry window', async (_, fail) => {
    const request = draftRequest()
    fail()
    await expect(create(request)).rejects.toThrow()
    fake.state.reject.clear()
    expect(rejections()).toEqual([])
    fake.state.date = beyond
    fake.mock.invoices.list.mockResolvedValue({ data: [], has_more: false })
    await expect(cancelInvoiceOperation(db, request.operationId, null)).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_NOT_CANCELLABLE'
    })
    expect(resolutions()).toEqual([])
    expect(pendingInvoiceOperations(db)).toMatchObject([{ state: 'unfinished' }])
  })

  it('never turns a replayed success into a rejection', async () => {
    const request = draftRequest()
    fake.state.lose.add('invoices.create')
    await expect(create(request)).rejects.toThrow('socket hang up')
    // Validation would now fail, but the key's saved success is replayed inside the window.
    fake.state.reject.set('invoices.create', refusal('customer is deleted'))
    fake.mock.invoices.list.mockResolvedValueOnce({ data: [], has_more: false })
    fake.state.date = within
    const result = await create(request)
    expect(result.draft.invoiceId).toBe(fake.state.invoices[0].id)
    expect(rejections()).toEqual([])
  })

  it('cancels a draft with a rejected item only after Stripe shows the draft and its items deleted', async () => {
    const request = draftRequest()
    fake.state.reject.set('invoiceItems.create', refusal('Amount must be no more than $999,999.99'))
    await expect(create(request)).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_REJECTED' })
    expect(rejections()).toMatchObject([{ name: 'item-0' }])
    const provider = { stripe: fake.stripe, expectedTestMode: true }
    await expect(cancelInvoiceOperation(db, request.operationId, null)).rejects.toMatchObject({
      code: 'STRIPE_NO_KEY'
    })
    await expect(cancelInvoiceOperation(db, request.operationId, provider)).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_NOT_CANCELLABLE',
      message: expect.stringContaining(fake.state.invoices[0].id)
    })
    // The user deletes the draft in Stripe; ClauTime only reads.
    const deleted = fake.state.invoices.splice(0)[0]
    const writesBefore = fake.state.writes.length
    expect(await cancelInvoiceOperation(db, request.operationId, provider)).toMatchObject({
      basis: 'draft-deleted',
      invoiceId: deleted.id,
      rejectedSteps: ['item-0'],
      itemIds: [],
      checkedProviderAt: '2026-09-28T02:00:00.000Z'
    })
    expect(fake.state.writes).toHaveLength(writesBefore)
    expect(pendingInvoiceOperations(db)).toEqual([])
  })

  it('refuses a deleted-draft cancellation while an item it created still exists', async () => {
    const request = draftRequest()
    fake.state.reject.set('invoiceItems.create', refusal('rejected'))
    fake.mock.invoiceItems.create.mockImplementationOnce(async (...args: unknown[]) => {
      const params = args[0] as Record<string, unknown>
      const row = { ...params, id: 'ii_kept', livemode: false }
      fake.state.items.push(row)
      return row
    })
    await expect(create(request)).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_REJECTED' })
    fake.state.invoices.splice(0)
    const provider = { stripe: fake.stripe, expectedTestMode: true }
    await expect(cancelInvoiceOperation(db, request.operationId, provider)).rejects.toMatchObject({
      message: expect.stringContaining('ii_kept')
    })
    fake.state.items.splice(0)
    expect(await cancelInvoiceOperation(db, request.operationId, provider)).toMatchObject({
      itemIds: ['ii_kept']
    })
  })

  it('verifies a deleted draft only with the operation account', async () => {
    const request = draftRequest()
    fake.state.reject.set('invoiceItems.create', refusal('rejected'))
    await expect(create(request)).rejects.toThrow()
    fake.state.invoices.splice(0)
    fake.state.accountId = 'acct_other'
    await expect(
      cancelInvoiceOperation(db, request.operationId, {
        stripe: fake.stripe,
        expectedTestMode: true
      })
    ).rejects.toMatchObject({ code: 'STRIPE_ACCOUNT_MISMATCH' })
    expect(resolutions()).toEqual([])
  })

  it('never cancels a saved invoice or a completed draft', async () => {
    const request = draftRequest()
    await create(request)
    await expect(cancelInvoiceOperation(db, request.operationId, null)).rejects.toMatchObject({
      code: 'STRIPE_NO_KEY'
    })
    await expect(
      cancelInvoiceOperation(db, request.operationId, {
        stripe: fake.stripe,
        expectedTestMode: true
      })
    ).rejects.toMatchObject({ code: 'PROVIDER_OPERATION_NOT_CANCELLABLE' })
    db.insert(invoices)
      .values({
        clientId: 7,
        stripeInvoiceId: fake.state.invoices[0].id as string,
        operationId: request.operationId,
        testMode: 1,
        createdAt: 'x',
        updatedAt: 'x'
      })
      .run()
    await expect(cancelInvoiceOperation(db, request.operationId, null)).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_NOT_CANCELLABLE'
    })
  })

  it('retries a rejected send under a new attempt key, but never after an uncertain one', async () => {
    const invoiceId = (await create(draftRequest())).draft.invoiceId
    fake.state.reject.set('invoices.sendInvoice', refusal('Customer has no email address'))
    await expect(sendInvoiceOperation(db, fake.stripe, true, invoiceId)).rejects.toMatchObject({
      code: 'PROVIDER_OPERATION_REJECTED',
      message: expect.stringContaining('Nothing was changed')
    })
    fake.state.reject.clear()
    fake.state.date = beyond
    const operationId = invoiceOperationId(
      'send-invoice',
      { accountId: 'acct_fixture', testMode: true },
      invoiceId
    )
    await sendInvoiceOperation(db, fake.stripe, true, invoiceId)
    expect(writes('invoices.sendInvoice').map((w) => w.key)).toEqual([
      `clautime:${operationId}:send`,
      `clautime:${operationId}:send-2`
    ])
    expect(writes('invoices.finalizeInvoice')).toHaveLength(1)
  })

  it('runs the send preflight with the current retrieval until a send attempt starts', async () => {
    const invoiceId = (await create(draftRequest())).draft.invoiceId
    const preflight = vi.fn(() => {
      throw Object.assign(new Error('blocked'), { code: 'INVOICE_SYNC_BLOCKED' })
    })
    await expect(sendInvoiceOperation(db, fake.stripe, true, invoiceId, preflight)).rejects.toThrow(
      'blocked'
    )
    expect(preflight).toHaveBeenCalledWith(
      expect.objectContaining({ id: invoiceId, status: 'draft' }),
      expect.objectContaining({ accountId: 'acct_fixture', testMode: true })
    )
    expect(
      fake.state.writes.filter(
        (w) =>
          w.method !== 'customers.create' &&
          w.method !== 'invoices.create' &&
          w.method !== 'invoiceItems.create'
      )
    ).toEqual([])
    expect(
      db
        .select()
        .from(providerOperations)
        .all()
        .map((o) => o.kind)
    ).not.toContain('send-invoice')

    // An uncertain send is completed under its key without re-checking (it may have emailed).
    fake.state.lose.add('invoices.sendInvoice')
    await expect(sendInvoiceOperation(db, fake.stripe, true, invoiceId)).rejects.toThrow(
      'socket hang up'
    )
    fake.state.date = within
    preflight.mockClear()
    await sendInvoiceOperation(db, fake.stripe, true, invoiceId, preflight)
    expect(preflight).not.toHaveBeenCalled()
  })
})

describe('new-draft refresh hook', () => {
  it('refreshes with the captured client and account only before retaining a new operation', async () => {
    const request = draftRequest()
    const refresh = vi.fn(async () => {})
    fake.state.lose.add('invoices.create')
    await expect(
      createDraftInvoiceOperation(db, fake.stripe, true, request, client, { refresh })
    ).rejects.toThrow('socket hang up')
    expect(refresh).toHaveBeenCalledWith(fake.stripe, {
      accountId: 'acct_fixture',
      testMode: true,
      providerDate: start
    })
    await createDraftInvoiceOperation(db, fake.stripe, true, request, client, { refresh })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('a failed refresh retains nothing and writes nothing', async () => {
    const refresh = vi.fn(async () => {
      throw Object.assign(new Error('review'), { code: 'INVOICE_REFRESH_REVIEW' })
    })
    await expect(
      createDraftInvoiceOperation(db, fake.stripe, true, draftRequest(), client, { refresh })
    ).rejects.toThrow('review')
    expect(pendingInvoiceOperations(db)).toEqual([])
    expect(fake.state.writes).toEqual([])
  })
})

describe('amounts Stripe accepts', () => {
  it('sends plain decimals of at most 12 places and computes the local amount from them', async () => {
    const hours = 0.1 + 0.2
    const { frozen } = await create(
      draftRequest({
        lineItems: [{ description: 'Float hours', amountCents: 3000, hours, rateCents: 10000 }],
        lineMeta: [{}]
      })
    )
    expect(frozen.lines[0]).toMatchObject({
      quantityDecimal: '0.3',
      unitAmountDecimal: '10000',
      amountCents: 3000
    })
    expect(fake.state.items[0]).toMatchObject({ quantity_decimal: '0.3' })
  })

  it('refuses amounts Stripe would reject before retaining anything', async () => {
    await expect(
      create(
        draftRequest({
          lineItems: [{ description: 'Huge', amountCents: 100_000_000 }],
          lineMeta: [{}]
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_LINE_ITEM' })
    expect(pendingInvoiceOperations(db)).toEqual([])
    expect(fake.state.writes).toEqual([])
  })
})
