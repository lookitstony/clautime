import { collectAvailableActivity } from './folder-sync-activity-export'
// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import {
  activityIdentities,
  activityObservations,
  activitySources
} from '../db/schema/activity-evidence'
import {
  activityObservers,
  activityProvenanceImports,
  sourceMachines
} from '../db/schema/activity-observers'
import { appSettings } from '../db/schema/app-settings'
import { syncBatches, syncChanges, syncReceipts } from '../db/schema/folder-sync'
import { parseCodexSessionFile } from '../parsers/codex-parser'
import { parseGeminiSessionFile } from '../parsers/gemini-parser'
import { parseOpencodeSessionFile } from '../parsers/opencode-parser'
import { parseSessionFile } from '../parsers/session-parser'
import type { ParsedSessionData } from '../parsers/types'
import { storeActivityEvidence } from './activity-evidence'
import { readCanonicalActivity } from './canonical-activity'
import {
  activityObservationId,
  activityObserverEntityId,
  activitySyncAdapter,
  collectActivitySyncChanges,
  syncFactChangeId
} from './folder-sync-activity-records'
import { encodeSyncBatch, SyncError, type SyncBatch, type SyncChange } from './folder-sync-protocol'
import {
  applyReadySyncBatches,
  assembleOutgoingBatch,
  recordLocalSyncChanges,
  retainIncomingBatch
} from './folder-sync-store'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
let device = { deviceId: '', machineName: '' }
vi.mock('./device-context', () => ({ getLocalDeviceSession: () => device }))

type Db = ReturnType<typeof drizzle>
const WORKSPACE = '2fd7cbd1-7f6b-4935-b18c-367ae5ff5fb9'
const OTHER_WORKSPACE = '6a0c7f7e-3a58-4f2e-9d1f-0f3b8f1c2d4e'
const DEVICE_A = '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222'
const DEVICE_B = '7c8f7eab-af58-4cbb-9e74-d1e47f80d600'
const CAPTURED_A = '2031-03-04T05:06:07.000Z'
const CAPTURED_B = '2032-04-05T06:07:08.000Z'
const V8_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const migrationsFolder = join(__dirname, '../db/migrations')
const opened: Database.Database[] = []
let directory: string
let a: Db
let b: Db

function database(): Db {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  opened.push(connection)
  const target = drizzle(connection)
  migrate(target, { migrationsFolder })
  return target
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'clautime-activity-sync-'))
  a = database()
  b = database()
})
afterEach(() => {
  for (const connection of opened.splice(0)) connection.close()
  const target = resolve(directory)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('clautime-activity-sync-'))
    throw new Error('Unexpected fixture directory')
  rmSync(target, { recursive: true, force: true })
})

// Real-format provider fixtures, with transcript text and paths the ledger must not keep.
const at = (second: number) =>
  new Date(Date.parse('2026-07-19T18:07:00.000Z') + second * 1000).toISOString()
function writeLines(name: string, lines: unknown[]): string {
  const path = join(directory, name)
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  return path
}
async function claude(name = 'claude.jsonl', usage = 100): Promise<ParsedSessionData> {
  const base = { sessionId: 'conversation-a', cwd: 'C:\\private-project', gitBranch: 'main' }
  const path = writeLines(name, [
    {
      ...base,
      type: 'user',
      uuid: 'message-1',
      parentUuid: null,
      timestamp: at(0),
      message: { role: 'user', content: 'PRIVATE_TRANSCRIPT prompt' }
    },
    {
      ...base,
      type: 'progress',
      uuid: 'progress-1',
      parentUuid: 'message-1',
      timestamp: at(30),
      data: { type: 'hook_progress', output: 'PRIVATE_TRANSCRIPT output' }
    },
    {
      ...base,
      type: 'assistant',
      uuid: 'message-2',
      parentUuid: 'message-1',
      timestamp: at(60),
      message: {
        role: 'assistant',
        model: 'fixture-model',
        content: [{ type: 'text', text: 'PRIVATE_TRANSCRIPT reply' }],
        usage: { input_tokens: usage, output_tokens: 10, cache_read_input_tokens: 5 }
      }
    }
  ])
  return (await parseSessionFile(path))!
}
async function orphanProgress(): Promise<ParsedSessionData> {
  const path = writeLines('orphan.jsonl', [
    {
      type: 'progress',
      sessionId: 'progress-session',
      uuid: 'progress-a',
      parentUuid: 'message-not-yet-imported',
      timestamp: at(0),
      data: { type: 'agent_progress', message: { content: 'PRIVATE_TRANSCRIPT' } }
    }
  ])
  return (await parseSessionFile(path))!
}
async function codex(): Promise<ParsedSessionData> {
  const time = (minute: number) => at(minute * 60)
  const item = (minute: number, payload: Record<string, unknown>) => ({
    timestamp: time(minute),
    type: 'response_item',
    payload
  })
  const tokens = (minute: number, input: number, cached: number, output: number) => ({
    timestamp: time(minute),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: 0,
          total_tokens: input + output
        },
        last_token_usage: {},
        model_context_window: 272000
      }
    }
  })
  const path = writeLines('rollout.jsonl', [
    {
      timestamp: time(0),
      type: 'session_meta',
      payload: {
        id: '019f7b8d-9ce6-7502-9bc5-014887fbd70e',
        session_id: '019f7b8d-9ce6-7502-9bc5-014887fbd70e',
        cwd: 'C:\\private-project',
        originator: 'codex-tui',
        cli_version: '0.144.6'
      }
    },
    {
      timestamp: time(0),
      type: 'turn_context',
      payload: { cwd: 'C:\\private-project', model: 'model-a' }
    },
    item(1, {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'PRIVATE_TRANSCRIPT' }]
    }),
    // An anchored progress leaf: type and time only.
    {
      timestamp: time(1.2),
      type: 'event_msg',
      payload: { type: 'agent_reasoning', text: 'PRIVATE_TRANSCRIPT' }
    },
    item(1.5, { type: 'reasoning', summary: [], encrypted_content: 'PRIVATE_TRANSCRIPT' }),
    item(2, {
      type: 'function_call',
      name: 'shell',
      arguments: '{"command":["ls","C:\\\\private-project"]}',
      call_id: 'call-1'
    }),
    tokens(2.1, 100, 20, 10),
    item(20, { type: 'function_call_output', call_id: 'call-1', output: 'PRIVATE_TRANSCRIPT' }),
    item(21, {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'PRIVATE_TRANSCRIPT' }]
    }),
    tokens(21.1, 250, 120, 30)
  ])
  const parsed = (await parseCodexSessionFile(path))!
  expect(parsed.codexActivityEvidence?.status).toBe('captured')
  expect(parsed.codexActivityEvidence?.progress).toHaveLength(1)
  return parsed
}
async function gemini(): Promise<ParsedSessionData> {
  const path = join(directory, 'gemini.json')
  writeFileSync(
    path,
    JSON.stringify({
      sessionId: 'gemini-a',
      messages: [
        { id: 'user-1', type: 'user', timestamp: at(0), content: 'PRIVATE_TRANSCRIPT' },
        { id: 'info-1', type: 'info', timestamp: at(5), content: 'PRIVATE_TRANSCRIPT' }
      ]
    })
  )
  return (await parseGeminiSessionFile(path))!
}
async function opencode(): Promise<ParsedSessionData> {
  const root = join(directory, 'opencode')
  const sessionDir = join(root, 'session', 'project')
  const messageDir = join(root, 'message', 'ses_a')
  const partDir = join(root, 'part', 'msg_a')
  for (const path of [sessionDir, messageDir, partDir]) mkdirSync(path, { recursive: true })
  const source = join(sessionDir, 'ses_a.json')
  const start = Date.parse(at(0))
  writeFileSync(source, JSON.stringify({ id: 'ses_a', directory: root }))
  writeFileSync(
    join(messageDir, 'msg_a.json'),
    JSON.stringify({
      id: 'msg_a',
      sessionID: 'ses_a',
      role: 'assistant',
      time: { created: start, completed: start + 2000 },
      modelID: 'fixture-model',
      tokens: { input: 100, output: 10 }
    })
  )
  writeFileSync(
    join(partDir, 'prt_a.json'),
    JSON.stringify({
      id: 'prt_a',
      sessionID: 'ses_a',
      messageID: 'msg_a',
      type: 'tool',
      tool: 'read',
      state: {
        status: 'completed',
        input: { path: 'PRIVATE_PATH' },
        output: 'PRIVATE_TRANSCRIPT',
        time: { start: start + 1000, end: start + 2000 }
      }
    })
  )
  return (await parseOpencodeSessionFile(source))!
}

function capture(
  target: Db,
  parsed: ParsedSessionData[],
  deviceId: string,
  machineName: string,
  capturedAt: string
): void {
  device = { deviceId, machineName }
  for (const source of parsed)
    target.transaction((tx) => storeActivityEvidence(tx, source, capturedAt))
}
function publish(target: Db, deviceId: string): SyncBatch {
  recordLocalSyncChanges(
    target,
    WORKSPACE,
    collectActivitySyncChanges(target, WORKSPACE),
    activitySyncAdapter
  )
  return assembleOutgoingBatch(target, WORKSPACE, { writerEpochId: randomUUID(), deviceId })!
}
function deliver(target: Db, batch: SyncBatch) {
  retainIncomingBatch(target, WORKSPACE, JSON.parse(JSON.stringify(batch)), activitySyncAdapter)
  return applyReadySyncBatches(target, WORKSPACE, activitySyncAdapter)
}
function encode(changes: SyncChange[], sequence: number, writerEpochId: string): SyncBatch {
  const ids = new Set(changes.map((change) => change.id))
  return encodeSyncBatch({
    workspaceId: WORKSPACE,
    batchId: randomUUID(),
    writerEpochId,
    deviceId: DEVICE_A,
    sequence,
    changes,
    dependencies: [...new Set(changes.flatMap((change) => change.dependencies))]
      .filter((id) => !ids.has(id))
      .sort()
  }).batch
}
/** The portable ledger: everything except local capture times and source links. */
function ledger(target: Db) {
  return {
    identities: target.select().from(activityIdentities).orderBy(activityIdentities.eventId).all(),
    observations: target
      .select({
        id: activityObservations.id,
        eventId: activityObservations.eventId,
        version: activityObservations.version,
        kind: activityObservations.kind,
        payloadJson: activityObservations.payloadJson
      })
      .from(activityObservations)
      .orderBy(activityObservations.id)
      .all(),
    observers: target
      .select()
      .from(activityObservers)
      .orderBy(activityObservers.observationId, activityObservers.deviceId)
      .all(),
    machines: target.select().from(sourceMachines).orderBy(sourceMachines.deviceId).all()
  }
}
function errorCode(action: () => unknown): string | null {
  try {
    action()
  } catch (error) {
    expect(error).toBeInstanceOf(SyncError)
    return (error as SyncError).code
  }
  return null
}
const byType = (changes: SyncChange[], entityType: SyncChange['entityType']) =>
  changes.filter((change) => change.entityType === entityType)

it('exports only allowlisted facts with deterministic IDs in dependency order', async () => {
  const parsed = [await claude(), await codex(), await gemini(), await opencode()]
  capture(a, parsed, DEVICE_A, 'Desk', CAPTURED_A)
  a.insert(appSettings).values({ key: 'stripeSecretKey', value: 'sk_test_PRIVATE_KEY' }).run()
  const changes = collectActivitySyncChanges(a, WORKSPACE)
  expect(collectActivitySyncChanges(a, WORKSPACE)).toEqual(changes)
  const order = ['machine', 'activity-identity', 'activity-observation', 'activity-observer']
  const ranks = changes.map((change) => order.indexOf(change.entityType))
  expect(ranks).toEqual([...ranks].sort((x, y) => x - y))
  expect(new Set(ranks)).toEqual(new Set([0, 1, 2, 3]))
  expect(byType(changes, 'activity-identity')).toHaveLength(
    a.select().from(activityIdentities).all().length
  )
  expect(byType(changes, 'activity-observation')).toHaveLength(
    a.select().from(activityObservations).all().length
  )
  const codexBases = byType(changes, 'activity-identity')
    .filter((change) => change.payload.provider === 'codex')
    .map((change) => change.payload.basis)
  expect(new Set(codexBases)).toEqual(new Set(['fingerprint', 'checkpoint', 'progress']))

  for (const change of changes) {
    expect(change.kind).toBe('fact')
    expect(change.id).toMatch(V8_UUID)
    expect(change.id).toBe(syncFactChangeId(WORKSPACE, change.entityType, change.entityId))
    const keys = Object.keys(change.payload).sort()
    if (change.entityType === 'machine') {
      expect(keys).toEqual(['deviceId', 'initialName'])
      expect(change.dependencies).toEqual([])
    } else if (change.entityType === 'activity-identity') {
      expect(keys).toEqual([
        'basis',
        'conversationId',
        'eventId',
        'identityVersion',
        'nativeEventId',
        'provider'
      ])
      expect(change.dependencies).toEqual([])
    } else if (change.entityType === 'activity-observation') {
      expect(keys).toEqual(['eventId', 'kind', 'payload', 'version'])
      expect(change.dependencies).toEqual([
        syncFactChangeId(WORKSPACE, 'activity-identity', change.payload.eventId as string)
      ])
    } else {
      expect(keys).toEqual(['basis', 'deviceId', 'observationId'])
      expect(change.entityId).toBe(
        activityObserverEntityId(
          change.payload.observationId as string,
          change.payload.deviceId as string,
          change.payload.basis as string
        )
      )
      expect(change.dependencies).toEqual(
        [
          syncFactChangeId(
            WORKSPACE,
            'activity-observation',
            change.payload.observationId as string
          ),
          syncFactChangeId(WORKSPACE, 'machine', change.payload.deviceId as string)
        ].sort()
      )
    }
  }
  const timing = byType(changes, 'activity-observation')
    .map((change) => change.payload.payload as Record<string, unknown>)
    .filter((fact) => fact.timing)
    .map((fact) => fact.timing)
  expect(timing).toEqual(
    expect.arrayContaining([{ completedAt: at(2) }, { startedAt: at(1), endedAt: at(2) }])
  )

  const exported = JSON.stringify(publish(a, DEVICE_A))
  for (const secret of [
    'PRIVATE_',
    'private-project',
    'sk_test',
    basename(directory),
    CAPTURED_A,
    'sourceFile',
    'source_file',
    'createdAt',
    'isSubagent'
  ])
    expect(exported).not.toContain(secret)
})

it('restores a blank installation to identical canonical totals without any source files', async () => {
  const claudeFixture = await claude()
  const parsed = [claudeFixture, await codex(), await gemini(), await opencode()]
  capture(a, parsed, DEVICE_A, 'Desk', CAPTURED_A)
  const batch = publish(a, DEVICE_A)
  rmSync(resolve(directory), { recursive: true, force: true })
  mkdirSync(directory)

  expect(deliver(b, batch)).toEqual({ applied: [batch.batchId], waiting: [], errors: [] })
  expect(ledger(b)).toEqual(ledger(a))
  expect(b.select().from(activitySources).all()).toEqual([])
  expect(b.select().from(activityProvenanceImports).all()).toEqual([])
  expect(
    b
      .select()
      .from(activityObservations)
      .all()
      .every((row) => row.createdAt !== CAPTURED_A)
  ).toBe(true)
  expect(ledger(b).observers.every((row) => row.deviceId === DEVICE_A)).toBe(true)
  expect(ledger(b).machines).toEqual([{ deviceId: DEVICE_A, initialName: 'Desk' }])

  const canonical = readCanonicalActivity(a)
  expect(readCanonicalActivity(b)).toEqual(canonical)
  const resolved = (provider: string) => {
    const conversation = canonical.find((entry) => entry.provider === provider)!
    if (conversation.status !== 'resolved')
      throw new Error(`Expected resolved ${provider} history, got ${conversation.reason}`)
    return conversation
  }
  expect(resolved('claude').recording.totalTokenUsage).toEqual(claudeFixture.totalTokenUsage)
  expect(resolved('codex').recording.totalTokenUsage.inputTokens).toBeGreaterThan(0)

  // Imported facts are never published again from the receiving computer.
  recordLocalSyncChanges(
    b,
    WORKSPACE,
    collectActivitySyncChanges(b, WORKSPACE),
    activitySyncAdapter
  )
  expect(
    assembleOutgoingBatch(b, WORKSPACE, { writerEpochId: randomUUID(), deviceId: DEVICE_B })
  ).toBeNull()
})

it('deduplicates exact copies observed on two computers at different capture times', async () => {
  const parsed = [await claude()]
  capture(a, parsed, DEVICE_A, 'Desk', CAPTURED_A)
  capture(b, [await claude('copy.jsonl')], DEVICE_B, 'Laptop', CAPTURED_B)
  const single = readCanonicalActivity(a)
  const fromA = publish(a, DEVICE_A)
  const fromB = publish(b, DEVICE_B)
  const facts = (batch: SyncBatch) =>
    batch.changes
      .filter((change) => ['activity-identity', 'activity-observation'].includes(change.entityType))
      .map((change) => change.id)
      .sort()
  expect(facts(fromB)).toEqual(facts(fromA))

  expect(deliver(a, fromB).errors).toEqual([])
  expect(deliver(b, fromA).errors).toEqual([])
  expect(ledger(b)).toEqual(ledger(a))
  const { identities, observations, observers, machines } = ledger(a)
  expect(identities).toHaveLength(3)
  expect(observations).toHaveLength(3)
  expect(observers).toHaveLength(6)
  for (const observation of observations)
    expect(
      observers.filter((row) => row.observationId === observation.id).map((row) => row.deviceId)
    ).toEqual([DEVICE_A, DEVICE_B].sort())
  expect(machines).toEqual(
    [
      { deviceId: DEVICE_A, initialName: 'Desk' },
      { deviceId: DEVICE_B, initialName: 'Laptop' }
    ].sort((x, y) => (x.deviceId < y.deviceId ? -1 : 1))
  )
  // Each copy keeps its own local capture time; usage still counts once.
  expect(
    new Set(
      a
        .select()
        .from(activityObservations)
        .all()
        .map((row) => row.createdAt)
    )
  ).toEqual(new Set([CAPTURED_A]))
  expect(
    new Set(
      b
        .select()
        .from(activityObservations)
        .all()
        .map((row) => row.createdAt)
    )
  ).toEqual(new Set([CAPTURED_B]))
  expect(readCanonicalActivity(a)).toEqual(single)
  expect(readCanonicalActivity(b)).toEqual(single)
})

it('keeps differing observations of one event as separate held facts', async () => {
  capture(a, [await claude('claude.jsonl', 100)], DEVICE_A, 'Desk', CAPTURED_A)
  capture(b, [await claude('corrected.jsonl', 200)], DEVICE_B, 'Laptop', CAPTURED_B)
  const fromA = publish(a, DEVICE_A)
  const fromB = publish(b, DEVICE_B)
  expect(deliver(a, fromB).errors).toEqual([])
  expect(deliver(b, fromA).errors).toEqual([])
  expect(ledger(b)).toEqual(ledger(a))
  const { identities, observations } = ledger(a)
  expect(identities).toHaveLength(3)
  expect(observations).toHaveLength(4)
  expect(
    observations
      .map((row) => JSON.parse(row.payloadJson).usage?.inputTokens)
      .filter((value) => value !== undefined && value !== null)
      .sort()
  ).toEqual([100, 200])
  for (const target of [a, b])
    expect(readCanonicalActivity(target)).toEqual([
      expect.objectContaining({ status: 'unresolved', reason: 'conflicting-observations' })
    ])
})

it('waits for identity and machine facts when batches arrive in reverse order', async () => {
  capture(a, [await claude()], DEVICE_A, 'Desk', CAPTURED_A)
  const changes = collectActivitySyncChanges(a, WORKSPACE)
  const first = changes.filter((change) =>
    ['machine', 'activity-identity'].includes(change.entityType)
  )
  const second = changes.filter((change) => !first.includes(change))
  const writer = randomUUID()
  const early = encode(first, 1, writer)
  const late = encode(second, 2, writer)

  const waiting = deliver(b, late)
  expect(waiting.applied).toEqual([])
  expect(waiting.errors).toEqual([])
  expect(waiting.waiting).toEqual([
    { batchId: late.batchId, missing: first.map((change) => change.id).sort() }
  ])
  expect(ledger(b)).toEqual({ identities: [], observations: [], observers: [], machines: [] })
  expect(b.select().from(syncReceipts).all()).toEqual([])

  expect(deliver(b, early)).toEqual({
    applied: [early.batchId, late.batchId],
    waiting: [],
    errors: []
  })
  expect(ledger(b)).toEqual(ledger(a))
})

it('retains observations whose ancestry has not arrived and holds them from totals', async () => {
  capture(a, [await orphanProgress()], DEVICE_A, 'Desk', CAPTURED_A)
  expect(deliver(b, publish(a, DEVICE_A)).errors).toEqual([])
  expect(ledger(b)).toEqual(ledger(a))
  expect(ledger(b).observations).toHaveLength(1)
  expect(readCanonicalActivity(b)).toEqual([
    expect.objectContaining({ status: 'unresolved', reason: 'missing-predecessor' })
  ])
  expect(readCanonicalActivity(b)).toEqual(readCanonicalActivity(a))
})

it('requires an update for newer identity, observation, provider and kind versions', async () => {
  capture(a, [await claude()], DEVICE_A, 'Desk', CAPTURED_A)
  const changes = collectActivitySyncChanges(a, WORKSPACE)
  const identity = byType(changes, 'activity-identity')[0]
  const observation = byType(changes, 'activity-observation')[0]
  const observer = byType(changes, 'activity-observer')[0]
  const hash = 'a'.repeat(64)
  const newerEvent = `claude:v2:native:${hash}`
  const cases: SyncChange[] = [
    {
      ...identity,
      entityId: newerEvent,
      payload: { ...identity.payload, eventId: newerEvent, identityVersion: 2 }
    },
    {
      ...identity,
      entityId: `cursor:v1:native:${hash}`,
      payload: { ...identity.payload, eventId: `cursor:v1:native:${hash}`, provider: 'cursor' }
    },
    {
      ...identity,
      entityId: `claude:v1:progress:${hash}`,
      payload: { ...identity.payload, eventId: `claude:v1:progress:${hash}`, basis: 'progress' }
    },
    { ...observation, payload: { ...observation.payload, version: 2 } },
    { ...observation, payload: { ...observation.payload, eventId: newerEvent } },
    { ...observation, payload: { ...observation.payload, kind: 'snapshot' } },
    { ...observation, entityId: `observation:v2:${hash}` },
    { ...observer, payload: { ...observer.payload, observationId: `observation:v2:${hash}` } }
  ]
  for (const change of cases)
    expect(errorCode(() => activitySyncAdapter.validate(change))).toBe('SYNC_UPDATE_REQUIRED')

  const newer = encode([cases[0]], 1, randomUUID())
  expect(errorCode(() => retainIncomingBatch(b, WORKSPACE, newer, activitySyncAdapter))).toBe(
    'SYNC_UPDATE_REQUIRED'
  )
  expect(b.select().from(syncBatches).all()).toEqual([])
})

it('rejects unknown fields and mismatched contents instead of forwarding payloads', async () => {
  capture(a, [await claude()], DEVICE_A, 'Desk', CAPTURED_A)
  const changes = collectActivitySyncChanges(a, WORKSPACE)
  const identity = byType(changes, 'activity-identity')[0]
  const observations = byType(changes, 'activity-observation')
  const observer = byType(changes, 'activity-observer')[0]
  const machine = byType(changes, 'machine')[0]
  const reobserve = (change: SyncChange, fact: Record<string, unknown>): SyncChange => ({
    ...change,
    entityId: activityObservationId(
      change.payload.eventId as string,
      change.payload.kind as string,
      fact
    ),
    payload: { ...change.payload, payload: fact as SyncChange['payload'] }
  })
  const message = observations.find(
    (change) =>
      change.payload.kind === 'message' &&
      (change.payload.payload as Record<string, unknown>).usage !== null
  )!
  const fact = message.payload.payload as Record<string, unknown>
  const dependency = randomUUID()
  const checkpoint = (totals: Record<string, unknown>): SyncChange =>
    reobserve(
      {
        id: randomUUID(),
        kind: 'fact',
        entityType: 'activity-observation',
        entityId: '',
        dependencies: [dependency],
        payload: {
          eventId: `codex:v1:checkpoint:${'b'.repeat(64)}`,
          version: 1,
          kind: 'checkpoint'
        }
      },
      { previousCheckpointId: null, activityEventId: null, timestamp: at(0), totals, model: null }
    )
  const part = (timing: Record<string, unknown>): SyncChange =>
    reobserve(
      {
        id: randomUUID(),
        kind: 'fact',
        entityType: 'activity-observation',
        entityId: '',
        dependencies: [dependency],
        payload: { eventId: `opencode:v1:native:${'c'.repeat(64)}`, version: 1, kind: 'activity' }
      },
      {
        kind: 'tool',
        timing,
        parentEventId: `opencode:v1:native:${'d'.repeat(64)}`,
        parentConversationId: null
      }
    )
  const totals = { input_tokens: 10, output_tokens: 1, cached_input_tokens: 0 }
  // Valid hand-built facts pass, so each rejection below is caused by its one change.
  for (const valid of [
    checkpoint(totals),
    checkpoint({ ...totals, reasoning_output_tokens: 0 }),
    part({ startedAt: at(1), endedAt: at(2) }),
    reobserve(message, { ...fact })
  ])
    expect(errorCode(() => activitySyncAdapter.validate(valid))).toBeNull()

  const malformed: SyncChange[] = [
    reobserve(message, { ...fact, content: 'PRIVATE_TRANSCRIPT' }),
    reobserve(message, { ...fact, usage: { ...(fact.usage as object), cost: 1 } }),
    reobserve(message, { ...fact, cwd: 'C:\\private-project' }),
    reobserve(message, { ...fact, timestamp: 'yesterday' }),
    { ...message, payload: { ...message.payload, createdAt: CAPTURED_A } },
    { ...message, entityId: observations.find((change) => change !== message)!.entityId },
    { ...message, dependencies: [] },
    { ...message, kind: 'revision' },
    { ...identity, payload: { ...identity.payload, sourceFile: 'C:\\private-project\\a.jsonl' } },
    { ...identity, payload: { ...identity.payload, nativeEventId: 'another-message' } },
    { ...identity, payload: { ...identity.payload, conversationId: 'another-conversation' } },
    { ...machine, payload: { ...machine.payload, apiKey: 'sk_test_PRIVATE_KEY' } },
    { ...machine, payload: { ...machine.payload, initialName: ' ' } },
    { ...observer, payload: { ...observer.payload, basis: 'claimed' } },
    { ...observer, entityId: activityObserverEntityId('x', DEVICE_B, 'observed') },
    checkpoint({ ...totals, input_tokens: 1.5 }),
    checkpoint({ input_tokens: 10, output_tokens: 1 }),
    checkpoint({ ...totals, 'Input Tokens': 3 }),
    part({ startedAt: at(1), compactedAt: at(9) }),
    part({})
  ]
  for (const change of malformed)
    expect(errorCode(() => activitySyncAdapter.validate(change))).toBe('SYNC_MALFORMED')

  // A tampered local row is refused rather than forwarded or skipped.
  opened[0]
    .prepare('UPDATE activity_observations SET payload_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...fact, content: 'PRIVATE_TRANSCRIPT' }), message.entityId)
  expect(errorCode(() => collectActivitySyncChanges(a, WORKSPACE))).toBe('SYNC_MALFORMED')
})

it('rolls back the whole batch and its receipt when an existing fact differs', async () => {
  capture(a, [await claude()], DEVICE_A, 'Desk', CAPTURED_A)
  const batch = publish(a, DEVICE_A)
  const [identity] = a.select().from(activityIdentities).all()
  b.insert(activityIdentities)
    .values({ ...identity, conversationId: 'other-conversation' })
    .run()
  const conflicted = deliver(b, batch)
  expect(conflicted.applied).toEqual([])
  expect(conflicted.errors).toHaveLength(1)
  expect(b.select().from(syncReceipts).all()).toEqual([])
  expect(b.select().from(syncChanges).all()).toEqual([])
  expect(ledger(b)).toEqual({
    identities: [{ ...identity, conversationId: 'other-conversation' }],
    observations: [],
    observers: [],
    machines: []
  })
})

it('rejects an existing observation with the same ID but different contents', async () => {
  capture(a, [await claude()], DEVICE_A, 'Desk', CAPTURED_A)
  const batch = publish(a, DEVICE_A)
  for (const identity of a.select().from(activityIdentities).all())
    b.insert(activityIdentities).values(identity).run()
  const [observation] = a.select().from(activityObservations).orderBy(activityObservations.id).all()
  const damaged = { ...observation, payloadJson: '{"tampered":true}', createdAt: CAPTURED_B }
  b.insert(activityObservations).values(damaged).run()
  const conflicted = deliver(b, batch)
  expect(conflicted.applied).toEqual([])
  expect(conflicted.errors).toHaveLength(1)
  expect(b.select().from(syncReceipts).all()).toEqual([])
  expect(b.select().from(syncChanges).all()).toEqual([])
  expect(b.select().from(activityObservations).all()).toEqual([damaged])
  expect(b.select().from(sourceMachines).all()).toEqual([])
})

it('rejects facts whose change ID or dependencies belong to another fact or workspace', async () => {
  capture(a, [await claude()], DEVICE_A, 'Desk', CAPTURED_A)
  const changes = collectActivitySyncChanges(a, WORKSPACE)
  const machine = byType(changes, 'machine')[0]
  expect(() =>
    recordLocalSyncChanges(b, WORKSPACE, [{ ...machine, id: randomUUID() }], activitySyncAdapter)
  ).toThrow('not derived from its fact')
  expect(() => recordLocalSyncChanges(b, OTHER_WORKSPACE, changes, activitySyncAdapter)).toThrow()
  expect(b.select().from(syncChanges).all()).toEqual([])
  expect(ledger(b).machines).toEqual([])

  // Correct IDs under another workspace are separate facts that dedupe independently.
  const other = collectActivitySyncChanges(a, OTHER_WORKSPACE)
  expect(other.map((change) => change.entityId)).toEqual(changes.map((change) => change.entityId))
  expect(other.some((change) => changes.some((entry) => entry.id === change.id))).toBe(false)
  recordLocalSyncChanges(b, OTHER_WORKSPACE, other, activitySyncAdapter)
  expect(ledger(b)).toEqual(ledger(a))
})

it('collects one observation with only its identity, observers and machines', async () => {
  capture(a, [await claude()], DEVICE_A, 'Desk', CAPTURED_A)
  capture(a, [await claude('copy.jsonl')], DEVICE_B, 'Laptop', CAPTURED_B)
  const [observation] = ledger(a).observations
  const scoped = collectActivitySyncChanges(a, WORKSPACE, [observation.id, observation.id])
  expect(scoped.map((change) => [change.entityType, change.entityId])).toEqual([
    ['machine', [DEVICE_A, DEVICE_B].sort()[0]],
    ['machine', [DEVICE_A, DEVICE_B].sort()[1]],
    ['activity-identity', observation.eventId],
    ['activity-observation', observation.id],
    ...[DEVICE_A, DEVICE_B]
      .map((deviceId) => activityObserverEntityId(observation.id, deviceId, 'observed'))
      .sort()
      .map((entityId) => ['activity-observer', entityId])
  ])
  const all = collectActivitySyncChanges(a, WORKSPACE)
  for (const change of scoped) expect(all).toContainEqual(change)
  expect(collectActivitySyncChanges(a, WORKSPACE, [])).toEqual([])
  expect(() => collectActivitySyncChanges(a, WORKSPACE, ['observation:v1:missing'])).toThrow(
    'not in the local ledger'
  )
})

it('derives fact change IDs from the workspace, entity type and entity ID only', () => {
  const id = syncFactChangeId(WORKSPACE, 'machine', DEVICE_A)
  expect(id).toMatch(V8_UUID)
  expect(syncFactChangeId(WORKSPACE, 'machine', DEVICE_A)).toBe(id)
  expect(
    new Set([
      id,
      syncFactChangeId(OTHER_WORKSPACE, 'machine', DEVICE_A),
      syncFactChangeId(WORKSPACE, 'activity-identity', DEVICE_A),
      syncFactChangeId(WORKSPACE, 'machine', DEVICE_B)
    ]).size
  ).toBe(4)
})

it('withholds an unsupported local capture while exporting valid independent activity', async () => {
  capture(a, [await claude()], DEVICE_A, 'Desktop', CAPTURED_A)
  const complete = collectActivitySyncChanges(a, WORKSPACE)
  const identity = a.select().from(activityIdentities).get()!
  a.insert(activityObservations)
    .values({
      id: 'unsupported-local-observation',
      eventId: identity.eventId,
      version: 999,
      kind: 'message',
      payloadJson: '{}',
      createdAt: CAPTURED_A
    })
    .run()
  expect(() => collectActivitySyncChanges(a, WORKSPACE)).toThrow()
  const available = collectAvailableActivity(a, WORKSPACE)
  expect(available.issues).toMatchObject([
    { source: 'unsupported-local-observation', code: 'SYNC_LOCAL_ACTIVITY_WITHHELD' }
  ])
  expect(new Set(available.changes.map((change) => change.id))).toEqual(
    new Set(complete.map((change) => change.id))
  )
  recordLocalSyncChanges(a, WORKSPACE, available.changes, activitySyncAdapter)
  const batch = assembleOutgoingBatch(a, WORKSPACE, {
    deviceId: DEVICE_A,
    writerEpochId: randomUUID()
  })!
  expect(deliver(b, batch).errors).toEqual([])
  expect(b.select().from(activityObservations).all()).toHaveLength(
    a.select().from(activityObservations).all().length - 1
  )
  expect(
    a
      .select()
      .from(activityObservations)
      .all()
      .some((row) => row.id === 'unsupported-local-observation')
  ).toBe(true)
})

it('bounds malformed-capture diagnostics while retaining valid independent work', async () => {
  capture(a, [await claude()], DEVICE_A, 'Desktop', CAPTURED_A)
  const identity = a.select().from(activityIdentities).get()!
  for (let i = 0; i < 25; i++)
    a.insert(activityObservations)
      .values({
        id: `bad-${i}`,
        eventId: identity.eventId,
        version: 999,
        kind: 'message',
        payloadJson: '{}',
        createdAt: CAPTURED_A
      })
      .run()
  const available = collectAvailableActivity(a, WORKSPACE)
  expect(available.issues).toHaveLength(11)
  expect(available.issues[10].message).toContain('15 additional')
  expect(available.changes.some((change) => change.entityType === 'activity-observation')).toBe(
    true
  )
})
