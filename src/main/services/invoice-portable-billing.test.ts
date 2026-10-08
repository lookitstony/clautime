// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { sessions } from '../db/schema/sessions'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import {
  portableBillingFromLocal,
  resolvePortableBilling,
  type LocalInvoiceBilling,
  type PortableInvoiceBilling
} from './invoice-portable-billing'
import { freezeInvoiceRequest, type FrozenInvoiceRequest } from './stripe-operation-service'
import { retainProviderOperation } from './provider-operation-store'
import type { JsonObject } from './folder-sync-protocol'
import { checkNewInvoiceBilling } from './invoice-preflight'

/*
 * Canonical billed-work anchors (folder-sync-plan.md decision H): work frozen into an invoice
 * request stays billed through a transcript append, a split, a project reassignment and a blank
 * restore with different local row numbers, and never excludes unrelated work.
 */

type Db = ReturnType<typeof drizzle>
let db: Db
const opened: Database.Database[] = []

vi.mock('../db', () => ({ getDb: () => db }))
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

const clientSyncId = randomUUID()
const siteSyncId = randomUUID()
const otherSyncId = randomUUID()
const hex = (label: string) => createHash('sha256').update(label).digest('hex')
const at = (time: string) => `2026-09-02T${time}:00.000Z`
const message = (conversation: string, n: number, time: string) => ({
  eventId: `claude:v1:native:${hex(`${conversation}-${n}`)}`,
  observationId: `observation:v1:${hex(`${conversation}-observation-${n}`)}`,
  kind: 'message' as const,
  timestamp: at(time)
})
type Message = ReturnType<typeof message>
const conversation = [
  message('conversation', 0, '10:00'),
  message('conversation', 1, '10:20'),
  message('conversation', 2, '10:40'),
  message('conversation', 3, '11:00')
]
const ALREADY_BILLED = expect.objectContaining({ code: 'INVOICE_WORK_ALREADY_BILLED' })
const IDENTITY_PENDING = expect.objectContaining({ code: 'SYNC_BILLING_INCOMPLETE' })

/** A computer's database; `ids` are its local rows for the shared client and two projects. */
function open(ids = { client: 7, site: 3, other: 4 }): Db {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  opened.push(sqlite)
  const target = drizzle(sqlite)
  migrate(target, { migrationsFolder: join(__dirname, '../db/migrations') })
  target
    .insert(clients)
    .values({ id: ids.client, syncId: clientSyncId, name: 'Acme', color: '#000000' })
    .run()
  target
    .insert(projects)
    .values({ id: ids.site, clientId: ids.client, name: 'Site', syncId: siteSyncId })
    .run()
  target
    .insert(projects)
    .values({ id: ids.other, clientId: ids.client, name: 'Other', syncId: otherSyncId })
    .run()
  return target
}

function interval(events: Message[]): string {
  const startedAt = events[0].timestamp
  const endedAt = events[events.length - 1].timestamp
  return JSON.stringify({
    startedAt,
    endedAt,
    durationMinutes: (Date.parse(endedAt) - Date.parse(startedAt)) / 60_000,
    promptCount: events.length,
    inputTokens: 0,
    outputTokens: 0,
    modelUsage: [],
    coverage: { version: 1, messages: events, continuity: [] }
  })
}

function row(target: Db, id: number, clientId: number, projectId: number, events: Message[]): void {
  const startedAt = events[0].timestamp
  const endedAt = events[events.length - 1].timestamp
  target
    .insert(sessions)
    .values({
      id,
      projectPath: '',
      startedAt,
      endedAt,
      durationMinutes: (Date.parse(endedAt) - Date.parse(startedAt)) / 60_000,
      clientId,
      projectId
    })
    .run()
}

function map(
  target: Db,
  sessionId: number,
  events: Message[],
  conversationId = 'conversation'
): void {
  target
    .insert(sessionActivityMappings)
    .values({
      id: randomUUID(),
      sessionId,
      version: 1,
      workspaceId: 'workspace',
      policyRevisionId: 'revision',
      policyJson: '{}',
      provider: 'claude',
      conversationId,
      intervalJson: interval(events),
      previewFingerprint: 'fixture',
      createdAt: at('12:00')
    })
    .run()
}

function receipt(
  sessionId: number,
  clientId: number,
  projectId: number,
  startedAt: string,
  endedAt: string
): LocalInvoiceBilling {
  return {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    lines: [
      {
        lineDate: '2026-09-02',
        durationMinutes: (Date.parse(endedAt) - Date.parse(startedAt)) / 60_000,
        sessionIds: [sessionId],
        billedRanges: [{ sessionId, clientId, projectId, startedAt, endedAt }]
      }
    ]
  }
}

/** An unfinished draft operation: its frozen work is billed until cancelled with proof. */
function retain(target: Db, billing: PortableInvoiceBilling): void {
  const operationId = randomUUID()
  const frozen = freezeInvoiceRequest(
    { operationId, clientId: 7, lineItems: [{ description: 'Earlier draft', amountCents: 10000 }] },
    { syncId: clientSyncId, name: 'Acme', email: 'a@acme.test', stripeCustomerId: null },
    billing
  )
  retainProviderOperation(target, {
    id: operationId,
    accountId: 'acct_fixture',
    testMode: true,
    kind: 'create-invoice',
    request: frozen as unknown as JsonObject
  })
}

const preview = {
  billing: { periodStart: '2026-09-01', periodEnd: '2026-09-30', lines: [] }
} as unknown as FrozenInvoiceRequest
const check = (target: Db, clientId: number, bill: LocalInvoiceBilling) => () =>
  checkNewInvoiceBilling(target, clientId, preview, bill, true)

let billing: PortableInvoiceBilling

beforeEach(() => {
  db = open()
  row(db, 11, 7, 3, conversation)
  map(db, 11, conversation)
  billing = portableBillingFromLocal(db, receipt(11, 7, 3, at('10:00'), at('11:00')))
})
afterEach(() => {
  for (const sqlite of opened.splice(0)) sqlite.close()
})

describe('canonical billed anchors', () => {
  it('freezes the canonical activity and portable scope, never local row numbers', () => {
    expect(billing.lines[0].billed).toEqual([
      expect.objectContaining({
        anchor: expect.objectContaining({
          kind: 'activity',
          provider: 'claude',
          conversationId: 'conversation'
        }),
        clientSyncId,
        projectSyncId: siteSyncId,
        startedAt: at('10:00'),
        endedAt: at('11:00')
      })
    ])
    expect(JSON.stringify(billing)).not.toMatch(/sessionId|"clientId"|"projectId"/)
  })

  it('keeps the frozen part billed when the transcript grows, and bills only the appended time', () => {
    retain(db, billing)
    const grown = [...conversation, message('conversation', 4, '11:30')]
    db.update(sessions)
      .set({ endedAt: at('11:30'), durationMinutes: 90 })
      .where(eq(sessions.id, 11))
      .run()
    db.update(sessionActivityMappings)
      .set({ intervalJson: interval(grown) })
      .where(eq(sessionActivityMappings.sessionId, 11))
      .run()
    // A save while Stripe ran resolves to the grown row with the frozen bounds, not the new ones.
    expect(resolvePortableBilling(db, billing).lines[0]).toMatchObject({
      sessionIds: [11],
      billedRanges: [
        { sessionId: 11, clientId: 7, projectId: 3, startedAt: at('10:00'), endedAt: at('11:00') }
      ]
    })
    expect(check(db, 7, receipt(11, 7, 3, at('10:00'), at('11:30')))).toThrow(ALREADY_BILLED)
    expect(check(db, 7, receipt(11, 7, 3, at('11:00'), at('11:30')))).not.toThrow()
  })

  it('follows a split into new rows, including a fragment reassigned to another project', () => {
    retain(db, billing)
    db.delete(sessionActivityMappings).where(eq(sessionActivityMappings.sessionId, 11)).run()
    db.delete(sessions).where(eq(sessions.id, 11)).run()
    row(db, 12, 7, 3, conversation.slice(0, 2))
    map(db, 12, conversation.slice(0, 2))
    row(db, 13, 7, 4, conversation.slice(2))
    map(db, 13, conversation.slice(2))
    const resolved = resolvePortableBilling(db, billing).lines[0]
    expect(resolved.sessionIds).toEqual(expect.arrayContaining([12, 13]))
    expect(resolved.billedRanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 13,
          projectId: 3,
          startedAt: at('10:00'),
          endedAt: at('11:00')
        })
      ])
    )
    // Only the anchor connects the reassigned fragment; its bucket no longer matches.
    expect(check(db, 7, receipt(13, 7, 4, at('10:40'), at('11:00')))).toThrow(ALREADY_BILLED)
    expect(check(db, 7, receipt(12, 7, 3, at('10:00'), at('10:20')))).toThrow(ALREADY_BILLED)
  })

  it('keeps reassigned work billed without excluding unrelated work in the new project', () => {
    retain(db, billing)
    db.update(sessions).set({ projectId: 4 }).where(eq(sessions.id, 11)).run()
    expect(check(db, 7, receipt(11, 7, 4, at('10:00'), at('11:00')))).toThrow(ALREADY_BILLED)
    const other = [message('other', 0, '10:00'), message('other', 1, '11:00')]
    row(db, 20, 7, 4, other)
    map(db, 20, other, 'other')
    expect(check(db, 7, receipt(20, 7, 4, at('10:00'), at('11:00')))).not.toThrow()
  })

  it('restores on a blank computer with different row numbers, before and after the mapping arrives', () => {
    // Billed on computer A; computer B restores the operation and history under other local IDs.
    db = open({ client: 70, site: 30, other: 40 })
    retain(db, billing)
    row(db, 501, 70, 40, conversation)
    row(db, 502, 70, 30, conversation)
    // No mapping yet: the frozen range resolves to no row and excludes its own bucket only.
    expect(resolvePortableBilling(db, billing).lines[0]).toMatchObject({
      sessionIds: null,
      billedRanges: []
    })
    expect(check(db, 70, receipt(502, 70, 30, at('10:00'), at('11:00')))).toThrow(ALREADY_BILLED)
    // Once restored history maps the conversation, the anchor names the local row here.
    map(db, 501, conversation)
    expect(resolvePortableBilling(db, billing).lines[0]).toMatchObject({
      sessionIds: [501],
      billedRanges: [
        {
          sessionId: 501,
          clientId: 70,
          projectId: 30,
          startedAt: at('10:00'),
          endedAt: at('11:00')
        }
      ]
    })
    expect(check(db, 70, receipt(501, 70, 40, at('10:00'), at('11:00')))).toThrow(ALREADY_BILLED)
  })

  it('holds an unmapped split fragment even after another billed fragment has arrived', () => {
    db = open({ client: 70, site: 30, other: 40 })
    retain(db, billing)
    row(db, 501, 70, 40, conversation.slice(2))
    row(db, 502, 70, 30, conversation.slice(0, 2))
    map(db, 502, conversation.slice(0, 2))
    expect(check(db, 70, receipt(501, 70, 40, at('10:40'), at('11:00')))).toThrow(IDENTITY_PENDING)
    map(db, 501, conversation.slice(2))
    expect(check(db, 70, receipt(501, 70, 40, at('10:40'), at('11:00')))).toThrow(ALREADY_BILLED)
  })

  it('holds unmapped work moved to another project until the billed identity arrives', () => {
    db = open({ client: 70, site: 30, other: 40 })
    retain(db, billing)
    // Restored history reassigned to Other before its mapping arrived: its bucket no longer matches.
    row(db, 501, 70, 40, conversation)
    expect(check(db, 70, receipt(501, 70, 40, at('10:00'), at('11:00')))).toThrow(IDENTITY_PENDING)
    expect(check(db, 70, receipt(501, 70, 40, at('10:40'), at('11:00')))).toThrow(IDENTITY_PENDING)
    // The same conversation named on the row is still no identity without its mapping.
    db.update(sessions).set({ claudeSessionId: 'conversation' }).where(eq(sessions.id, 501)).run()
    expect(check(db, 70, receipt(501, 70, 40, at('10:00'), at('11:00')))).toThrow(IDENTITY_PENDING)
    // A corrupt mapping is no identity either.
    map(db, 501, conversation)
    db.update(sessionActivityMappings)
      .set({ intervalJson: '{"broken":true}' })
      .where(eq(sessionActivityMappings.sessionId, 501))
      .run()
    expect(check(db, 70, receipt(501, 70, 40, at('10:00'), at('11:00')))).toThrow(IDENTITY_PENDING)
    db.delete(sessionActivityMappings).where(eq(sessionActivityMappings.sessionId, 501)).run()

    // Unrelated work stays billable: mapped work of another conversation, an unmapped row whose
    // known conversation or provider differs, and later time that does not overlap.
    const other = [message('other', 0, '10:00'), message('other', 1, '11:00')]
    row(db, 503, 70, 40, other)
    map(db, 503, other, 'other')
    expect(check(db, 70, receipt(503, 70, 40, at('10:00'), at('11:00')))).not.toThrow()
    row(db, 504, 70, 40, other)
    db.update(sessions).set({ claudeSessionId: 'other' }).where(eq(sessions.id, 504)).run()
    expect(check(db, 70, receipt(504, 70, 40, at('10:00'), at('11:00')))).not.toThrow()
    row(db, 505, 70, 40, other)
    db.update(sessions).set({ tool: 'codex' }).where(eq(sessions.id, 505)).run()
    expect(check(db, 70, receipt(505, 70, 40, at('10:00'), at('11:00')))).not.toThrow()
    const appended = [message('conversation', 4, '11:00'), message('conversation', 5, '11:30')]
    row(db, 506, 70, 40, appended)
    expect(check(db, 70, receipt(506, 70, 40, at('11:00'), at('11:30')))).not.toThrow()

    // Once the matching mapping arrives, the moved work is simply already billed.
    map(db, 501, conversation)
    expect(check(db, 70, receipt(501, 70, 40, at('10:00'), at('11:00')))).toThrow(ALREADY_BILLED)
    expect(check(db, 70, receipt(503, 70, 40, at('10:00'), at('11:00')))).not.toThrow()
    expect(check(db, 70, receipt(506, 70, 40, at('11:00'), at('11:30')))).not.toThrow()
  })
})
