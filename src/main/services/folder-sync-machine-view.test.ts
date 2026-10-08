import { sourceMachineCoverage } from './folder-sync-machine-coverage'
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  activityIdentities,
  activityObservations,
  activitySources
} from '../db/schema/activity-evidence'
import { activityObservers, sourceMachines } from '../db/schema/activity-observers'
import { syncChanges } from '../db/schema/folder-sync'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { sessionDerivations } from '../db/schema/session-derivations'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { sessions } from '../db/schema/sessions'
import {
  activityObservationId,
  activitySyncAdapter,
  collectActivitySyncChanges
} from './folder-sync-activity-records'
import {
  applyReadySyncBatches,
  assembleOutgoingBatch,
  recordLocalSyncChanges,
  retainIncomingBatch
} from './folder-sync-store'
import {
  filterSessionsBySourceMachine,
  listSourceMachines,
  readSessionSourceMachines,
  withSourceMachines
} from './folder-sync-machine-view'

type Db = ReturnType<typeof drizzle>
let current: Db
const settings: Record<string, string> = {}
vi.mock('../db', () => ({ getDb: () => current }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, Notification: vi.fn(), shell: {} }))
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('./settings-service', () => ({
  settingsService: { getSetting: (key: string) => settings[key] ?? null }
}))
vi.mock('../providers', () => ({
  enabledProviders: () => [],
  providerForFile: () => ({ id: 'claude' })
}))
vi.mock('./credential-service', () => ({
  credentialService: { getApiKey: () => null, isStripeTestMode: () => false }
}))
vi.mock('./stripe-service', () => ({ stripeService: {} }))
vi.mock('./ai-service', () => ({
  aiService: { summarizeSessionGroup: vi.fn().mockResolvedValue(null) }
}))
vi.mock('./widget-service', () => ({ widgetService: {} }))
import { sessionService } from './session-service'
import { clientProjectService } from './client-project-service'
import { invoiceService } from './invoice-service'

const WORKSPACE = '2fd7cbd1-7f6b-4935-b18c-367ae5ff5fb9'
// The test-setup device registration (src/renderer/src/test-setup.ts).
const DESK = '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222'
const LAPTOP = '7c8f7eab-af58-4cbb-9e74-d1e47f80d600'
const PRIVATE_FILE = 'C:\\Users\\private\\.claude\\projects\\secret\\PRIVATE_TRANSCRIPT.jsonl'
const opened: Database.Database[] = []

function database(): Db {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  opened.push(connection)
  const target = drizzle(connection)
  migrate(target, { migrationsFolder: join(__dirname, '../db/migrations') })
  return target
}
afterEach(() => {
  for (const connection of opened.splice(0)) connection.close()
})

const at = (minute: number) => new Date(Date.UTC(2026, 2, 4, 10, minute)).toISOString()
// The ledger's native Claude key, so shared facts validate on import.
const eventId = (name: string) =>
  `claude:v1:native:${createHash('sha256')
    .update(JSON.stringify(['claude', 1, 'conversation-a', 'native', name]))
    .digest('hex')}`

function machine(db: Db, deviceId: string, initialName: string): void {
  db.insert(sourceMachines).values({ deviceId, initialName }).onConflictDoNothing().run()
}

/** One normalized message fact with its observers and (optionally) its local source file. */
function observe(
  db: Db,
  name: string,
  minute: number,
  observers: Array<[string, 'observed' | 'imported']>,
  sourceFile?: string
): { eventId: string; observationId: string; timestamp: string } {
  const id = eventId(name)
  // Keys in canonical (sorted) order, as the ledger stores them.
  const payload = {
    hasToolUse: false,
    isToolResult: false,
    model: null,
    timestamp: at(minute),
    toolNames: [],
    type: 'user',
    usage: null
  }
  const observationId = activityObservationId(id, 'message', payload)
  db.insert(activityIdentities)
    .values({
      eventId: id,
      provider: 'claude',
      identityVersion: 1,
      conversationId: 'conversation-a',
      basis: 'native',
      nativeEventId: name
    })
    .onConflictDoNothing()
    .run()
  db.insert(activityObservations)
    .values({
      id: observationId,
      eventId: id,
      version: 1,
      kind: 'message',
      payloadJson: JSON.stringify(payload),
      createdAt: at(minute)
    })
    .onConflictDoNothing()
    .run()
  for (const [deviceId, basis] of observers) {
    machine(db, deviceId, deviceId === DESK ? 'PC' : 'Laptop')
    db.insert(activityObservers).values({ observationId, deviceId, basis }).run()
  }
  if (sourceFile)
    db.insert(activitySources).values({ observationId, sourceFile, isSubagent: 0 }).run()
  return { eventId: id, observationId, timestamp: at(minute) }
}

function session(
  db: Db,
  values: Partial<typeof sessions.$inferInsert> & { startedAt: string; endedAt: string }
) {
  return db
    .insert(sessions)
    .values({ projectPath: 'C:\\fixture', durationMinutes: 5, ...values })
    .returning()
    .get()
}

function historyObserver(db: Db, payload: Record<string, unknown>): void {
  const id = randomUUID()
  const change = {
    id,
    kind: 'fact',
    entityType: 'history-observer',
    entityId: JSON.stringify(payload),
    dependencies: [],
    payload
  }
  db.insert(syncChanges)
    .values({
      id,
      workspaceId: WORKSPACE,
      kind: 'fact',
      entityType: 'history-observer',
      entityId: change.entityId,
      changeJson: JSON.stringify(change),
      origin: 'imported',
      recordedAt: at(0)
    })
    .run()
}

describe('source machine association', () => {
  it('lists every machine that observed a mapped session’s coverage and counts it once', () => {
    const a = database()
    const b = database()
    // The same fact captured independently on two computers; only B saw the later message.
    const first = observe(a, 'message-1', 0, [[DESK, 'observed']])
    observe(b, 'message-1', 0, [[LAPTOP, 'observed']])
    const second = observe(a, 'message-2', 4, [[DESK, 'observed']])
    const shared = collectActivitySyncChanges(b, WORKSPACE)
    recordLocalSyncChanges(b, WORKSPACE, shared, activitySyncAdapter)
    const batch = assembleOutgoingBatch(b, WORKSPACE, {
      deviceId: LAPTOP,
      writerEpochId: randomUUID()
    })!
    retainIncomingBatch(a, WORKSPACE, batch, activitySyncAdapter)
    expect(applyReadySyncBatches(a, WORKSPACE, activitySyncAdapter).errors).toEqual([])

    const row = session(a, { startedAt: first.timestamp, endedAt: second.timestamp })
    a.insert(sessionActivityMappings)
      .values({
        id: randomUUID(),
        sessionId: row.id,
        version: 1,
        workspaceId: WORKSPACE,
        policyRevisionId: randomUUID(),
        policyJson: '{}',
        provider: 'claude',
        conversationId: 'conversation-a',
        intervalJson: JSON.stringify({
          startedAt: first.timestamp,
          endedAt: second.timestamp,
          durationMinutes: 4,
          promptCount: 2,
          inputTokens: 0,
          outputTokens: 0,
          modelUsage: [],
          coverage: {
            version: 1,
            messages: [first, second].map((item) => ({ ...item, kind: 'message' })),
            continuity: []
          }
        }),
        previewFingerprint: 'fixture',
        createdAt: at(0)
      })
      .run()

    expect(readSessionSourceMachines(a, [row]).get(row.id)).toEqual([
      { deviceId: LAPTOP, label: 'Laptop', basis: 'observed' },
      { deviceId: DESK, label: 'PC', basis: 'observed' }
    ])
    const onDesk = filterSessionsBySourceMachine(a, [row], DESK)
    const onLaptop = filterSessionsBySourceMachine(a, [row], LAPTOP)
    expect(onDesk.map((item) => item.id)).toEqual([row.id])
    expect(onLaptop.map((item) => item.id)).toEqual([row.id])
    // Both filters match; the session itself is still one session.
    expect(new Set([...onDesk, ...onLaptop].map((item) => item.id)).size).toBe(1)
    expect(filterSessionsBySourceMachine(a, [row], randomUUID())).toEqual([])
  })

  it('scopes unmapped local evidence to the detector interval, never the whole file', () => {
    const db = database()
    observe(db, 'early-1', 0, [[DESK, 'observed']], PRIVATE_FILE)
    observe(db, 'early-2', 5, [[DESK, 'observed']], PRIVATE_FILE)
    // A later copied part of the same file was also observed on the laptop.
    observe(
      db,
      'late-1',
      180,
      [
        [DESK, 'observed'],
        [LAPTOP, 'observed']
      ],
      PRIVATE_FILE
    )
    const early = session(db, {
      startedAt: at(-60),
      endedAt: at(240),
      sourceFile: PRIVATE_FILE
    })
    // The user widened the saved times; the detector baseline still bounds the evidence.
    db.insert(sessionDerivations)
      .values({ sessionId: early.id, startedAt: at(0), endedAt: at(5), durationMinutes: 5 })
      .run()
    const late = session(db, { startedAt: at(180), endedAt: at(180), sourceFile: PRIVATE_FILE })
    const other = session(db, { startedAt: at(0), endedAt: at(5), sourceFile: 'elsewhere.jsonl' })

    const result = readSessionSourceMachines(db, [early, late, other])
    expect(result.get(early.id)).toEqual([{ deviceId: DESK, label: 'PC', basis: 'observed' }])
    expect(result.get(late.id)).toEqual([
      { deviceId: LAPTOP, label: 'Laptop', basis: 'observed' },
      { deviceId: DESK, label: 'PC', basis: 'observed' }
    ])
    expect(result.get(other.id)).toEqual([])
    expect(
      filterSessionsBySourceMachine(db, [early, late, other], LAPTOP).map((row) => row.id)
    ).toEqual([late.id])
  })

  it('uses the manual entry device and basis, and never invents a missing origin', () => {
    const db = database()
    machine(db, DESK, 'PC')
    machine(db, LAPTOP, 'Laptop')
    const created = session(db, { source: 'manual', startedAt: at(0), endedAt: at(30) })
    const imported = session(db, { source: 'manual', startedAt: at(40), endedAt: at(50) })
    const pending = session(db, { source: 'manual', startedAt: at(60), endedAt: at(70) })
    const importedEntry = randomUUID()
    db.insert(manualTimeEntries)
      .values([
        { id: randomUUID(), sessionId: created.id, deviceId: DESK, basis: 'created' },
        { id: importedEntry, sessionId: imported.id, deviceId: DESK, basis: 'imported' },
        { id: randomUUID(), sessionId: pending.id, deviceId: null, basis: 'imported' }
      ])
      .run()
    // Another computer's shared record that it also imported this entry.
    historyObserver(db, {
      recordType: 'manual-entry',
      recordId: importedEntry,
      deviceId: LAPTOP,
      basis: 'imported'
    })
    const result = readSessionSourceMachines(db, [created, imported, pending])
    expect(result.get(created.id)).toEqual([{ deviceId: DESK, label: 'PC', basis: 'observed' }])
    expect(result.get(imported.id)).toEqual([
      { deviceId: LAPTOP, label: 'Laptop', basis: 'imported' },
      { deviceId: DESK, label: 'PC', basis: 'imported' }
    ])
    expect(result.get(pending.id)).toEqual([])
  })

  it('reads legacy provenance only from exact shared facts', () => {
    const db = database()
    machine(db, DESK, 'PC')
    const known = session(db, { startedAt: at(0), endedAt: at(30), sourceFile: PRIVATE_FILE })
    const unknown = session(db, { startedAt: at(40), endedAt: at(50), sourceFile: PRIVATE_FILE })
    // Local capture of the same file must not be used to guess a legacy origin.
    observe(db, 'legacy-copy', 45, [[DESK, 'observed']], PRIVATE_FILE)
    const legacyId = randomUUID()
    db.insert(sessionLegacyRecords)
      .values([
        {
          id: legacyId,
          sessionId: known.id,
          version: 1,
          session: known,
          modelUsage: [],
          createdAt: at(0)
        },
        {
          id: randomUUID(),
          sessionId: unknown.id,
          version: 1,
          session: unknown,
          modelUsage: [],
          createdAt: at(0)
        }
      ])
      .run()
    historyObserver(db, {
      recordType: 'legacy-session',
      recordId: legacyId,
      deviceId: DESK,
      basis: 'imported'
    })
    // Not the exact shape: ignored rather than guessed from.
    historyObserver(db, {
      recordType: 'legacy-session',
      recordId: legacyId,
      deviceId: LAPTOP,
      basis: 'imported',
      sourceFile: PRIVATE_FILE
    })
    const result = readSessionSourceMachines(db, [known, unknown])
    expect(result.get(known.id)).toEqual([{ deviceId: DESK, label: 'PC', basis: 'imported' }])
    expect(result.get(unknown.id)).toEqual([])
  })

  it('exposes labels and device IDs only, never source paths or transcript text', () => {
    const db = database()
    observe(db, 'private', 0, [[DESK, 'observed']], PRIVATE_FILE)
    const row = session(db, { startedAt: at(0), endedAt: at(0), sourceFile: PRIVATE_FILE })
    const [dto] = withSourceMachines(db, [row])
    expect(dto).toEqual({
      ...row,
      sourceMachines: [{ deviceId: DESK, label: 'PC', basis: 'observed' }]
    })
    const provenance = JSON.stringify([dto.sourceMachines, listSourceMachines(db)])
    expect(provenance).not.toContain('PRIVATE')
    expect(provenance).not.toContain('private')
    expect(provenance).not.toContain('observation:')
  })
})

describe('Sessions filter versus invoicing', () => {
  beforeEach(() => {
    current = database()
    for (const key of Object.keys(settings)) delete settings[key]
  })

  it('filters Sessions by machine on the server but invoices all machines in scope', async () => {
    const client = clientProjectService.createClient({ name: 'Fixture', billableRate: 100 })
    const project = clientProjectService.createProject({
      clientId: client.id,
      name: 'Fixture',
      directoryPath: 'C:\\fixture'
    })
    const desk = sessionService.createSession({
      projectPath: 'C:\\fixture',
      startedAt: '2026-03-04T10:00:00.000Z',
      endedAt: '2026-03-04T11:00:00.000Z',
      durationMinutes: 60,
      projectId: project.id,
      clientId: client.id,
      description: 'Desk work'
    })
    const laptop = sessionService.createSession({
      projectPath: 'C:\\fixture',
      startedAt: '2026-03-04T12:00:00.000Z',
      endedAt: '2026-03-04T13:00:00.000Z',
      durationMinutes: 60,
      projectId: project.id,
      clientId: client.id,
      description: 'Laptop work'
    })
    // The second entry arrived from the laptop.
    machine(current, LAPTOP, 'Laptop')
    current
      .update(manualTimeEntries)
      .set({ deviceId: LAPTOP })
      .where(eq(manualTimeEntries.sessionId, laptop.id))
      .run()

    expect(sessionService.getAllSessions({ sourceMachine: LAPTOP }).map((row) => row.id)).toEqual([
      laptop.id
    ])
    expect(sessionService.getAllSessions({ sourceMachine: DESK }).map((row) => row.id)).toEqual([
      desk.id
    ])
    expect(sessionService.getAllSessions().map((row) => row.id)).toEqual([desk.id, laptop.id])

    // Invoice generation has its own client/date/project scope and no machine filter.
    const { lineItems } = await invoiceService.generateLineItems(
      client.id,
      '2026-03-01',
      '2026-03-10'
    )
    expect(lineItems.flatMap((item) => item.sessionIds).sort()).toEqual([desk.id, laptop.id].sort())
    expect(lineItems.reduce((sum, item) => sum + item.durationMinutes, 0)).toBe(120)
  })
})

it('reports evidence time separately from receipt time without assuming remote completeness', () => {
  const a = database()
  const b = database()
  machine(a, DESK, 'Desktop')
  machine(a, LAPTOP, 'Laptop')
  observe(a, 'latest-work', 50, [[DESK, 'observed']], PRIVATE_FILE)
  recordLocalSyncChanges(
    a,
    WORKSPACE,
    collectActivitySyncChanges(a, WORKSPACE),
    activitySyncAdapter
  )
  const batch = assembleOutgoingBatch(a, WORKSPACE, {
    writerEpochId: randomUUID(),
    deviceId: DESK
  })!
  retainIncomingBatch(b, WORKSPACE, batch, activitySyncAdapter)
  expect(sourceMachineCoverage(b, LAPTOP)).toEqual([])
  applyReadySyncBatches(b, WORKSPACE, activitySyncAdapter)
  const coverage = sourceMachineCoverage(b, LAPTOP)
  expect(coverage.find((row) => row.deviceId === DESK)).toMatchObject({
    latestActivityAt: at(50),
    isThisComputer: false
  })
  expect(coverage.find((row) => row.deviceId === DESK)?.lastReceivedAt).toMatch(/^20/)
  expect(coverage.find((row) => row.deviceId === LAPTOP)).toMatchObject({
    latestActivityAt: null,
    lastReceivedAt: null,
    isThisComputer: true
  })
  const firstReceipt = coverage.find((row) => row.deviceId === DESK)!.lastReceivedAt
  retainIncomingBatch(b, WORKSPACE, batch, activitySyncAdapter)
  applyReadySyncBatches(b, WORKSPACE, activitySyncAdapter)
  expect(
    sourceMachineCoverage(b, LAPTOP).find((row) => row.deviceId === DESK)?.lastReceivedAt
  ).toBe(firstReceipt)
  expect(JSON.stringify(coverage)).not.toContain(PRIVATE_FILE)
})
it('includes manual history when no native activity exists on a computer', () => {
  const db = database()
  machine(db, DESK, 'Desktop')
  const saved = session(db, { source: 'manual', startedAt: at(10), endedAt: at(45) })
  db.insert(manualTimeEntries)
    .values({ id: randomUUID(), sessionId: saved.id, deviceId: DESK, basis: 'created' })
    .run()
  expect(sourceMachineCoverage(db, DESK)[0]).toMatchObject({
    latestActivityAt: at(45),
    lastReceivedAt: null
  })
})
