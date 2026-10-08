// @vitest-environment node
import { folderSyncAdapter } from './folder-sync-domains'
import { bootstrapFolderSync } from './folder-sync-bootstrap'
import {
  journalSessionMutation,
  prepareSessionSync,
  journalMappedSplitCopies,
  mappedSessionObservedHeads
} from './folder-sync-session-local'
import { clients } from '../db/schema/clients'
import { projects } from '../db/schema/projects'
import { sessionBillingRefs } from '../db/schema/session-history'
import { billingRange } from './session-billing'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { and, eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import { folderSyncSettings, syncChanges } from '../db/schema/folder-sync'
import { sessions } from '../db/schema/sessions'
import { sessionDerivations } from '../db/schema/session-derivations'
import { sessionModelUsage } from '../db/schema/session-model-usage'
import { activeSessionCondition, sessionDeletions } from '../db/schema/session-deletions'
import { sessionReplacements } from '../db/schema/session-history'
import { sessionMappingDecisions } from '../db/schema/session-mapping-revisions'
import { activityObservationId, collectActivitySyncChanges } from './folder-sync-activity-records'
import {
  applyReadySyncBatches,
  assembleOutgoingBatch,
  recordLocalSyncChanges,
  retainIncomingBatch
} from './folder-sync-store'
import { canonicalJson } from './folder-sync-protocol'
import { collectHistorySyncChanges } from './folder-sync-history-records'
import {
  adoptInitialWorkspacePolicy,
  previewLedgerWorkspacePolicy,
  readCanonicalHistoryConstraints
} from './workspace-policy'
import {
  adoptSessionActivityMappings,
  previewSessionActivityAdoption
} from './session-activity-mappings'
import { readCanonicalHistoryProofs } from './canonical-history-proof'
import { deleteMappedSession, splitMappedSession } from './canonical-history-operations'
import {
  projectSharedSessions,
  sharedSessionConversationKeys
} from './folder-sync-session-projection'
import { readCanonicalActivity } from './canonical-activity'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'

// Pass-through spy: records which conversations each ledger read covered.
vi.mock('./canonical-activity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./canonical-activity')>()
  return { ...actual, readCanonicalActivity: vi.fn(actual.readCanonicalActivity) }
})

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('./device-context', () => ({
  getLocalDeviceSession: () => ({
    deviceId: '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222',
    machineName: 'Fixture'
  })
}))

type Db = ReturnType<typeof drizzle>
const policy = {
  version: 1,
  normalizationVersion: 1,
  detectorVersion: 1,
  idleTimeoutMinutes: 15,
  reportingTimeZone: 'UTC'
}
const CONVERSATION = 'conversation-1'
const KEY = JSON.stringify(['claude', CONVERSATION])
const at = (time: string) => `2026-09-26T${time.length === 5 ? `${time}:00` : time}.000Z`
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const eventId = (conversation: string, name: string) =>
  `claude:v1:native:${sha(JSON.stringify(['claude', 1, conversation, 'native', name]))}`

let workspaceId: string
let policySnapshot: { workspaceId: string; revisionId: string; policy: typeof policy }
const opened: Database.Database[] = []
const observations = new Map<string, string>()

function open(): Db {
  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  opened.push(sqlite)
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  adoptInitialWorkspacePolicy(db, policySnapshot)
  db.insert(folderSyncSettings).values({ slot: 1, workspaceId, folderPath: 'C:/sync' }).run()
  return db
}

beforeEach(() => {
  workspaceId = randomUUID()
  policySnapshot = { workspaceId: randomUUID(), revisionId: randomUUID(), policy }
})
afterEach(() => {
  while (opened.length) opened.pop()!.close()
})

const adapter = folderSyncAdapter

function deliver(from: Db, to: Db) {
  const batch = assembleOutgoingBatch(from, workspaceId, {
    writerEpochId: randomUUID(),
    deviceId: randomUUID()
  })
  if (!batch) throw new Error('Nothing to deliver')
  retainIncomingBatch(to, workspaceId, JSON.parse(JSON.stringify(batch)), adapter)
  const result = applyReadySyncBatches(to, workspaceId, adapter)
  expect(result.errors).toEqual([])
}

function message(
  db: Db,
  name: string,
  parent: string | null,
  time: string,
  type: 'user' | 'assistant' = 'user',
  conversation = CONVERSATION
) {
  const id = eventId(conversation, name)
  const payload = {
    type,
    timestamp: at(time),
    parentEventId: parent && eventId(conversation, parent),
    model: type === 'assistant' ? 'model-a' : null,
    usage:
      type === 'assistant'
        ? {
            inputTokens: 100,
            outputTokens: 10,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0
          }
        : null,
    isToolResult: false,
    hasToolUse: false,
    toolNames: []
  }
  db.insert(activityIdentities)
    .values({
      eventId: id,
      provider: 'claude',
      conversationId: conversation,
      identityVersion: 1,
      basis: 'native',
      nativeEventId: name
    })
    .run()
  const observation = activityObservationId(id, 'message', payload)
  observations.set(`${conversation}:${name}`, observation)
  db.insert(activityObservations)
    .values({
      id: observation,
      eventId: id,
      version: 1,
      kind: 'message',
      createdAt: at(time),
      payloadJson: canonicalJson(payload)
    })
    .run()
}

/** Captured events: 10:00–10:05 and 10:40–10:45, separated by idle time. */
function twoIntervalEvents(db: Db, conversation = CONVERSATION) {
  message(db, 'm0', null, '10:00', 'user', conversation)
  message(db, 'm1', 'm0', '10:05', 'assistant', conversation)
  message(db, 'm2', 'm1', '10:40', 'user', conversation)
  message(db, 'm3', 'm2', '10:45', 'assistant', conversation)
}

/** Saved local rows for the ledger's current intervals; optionally adopted. */
function saveRows(db: Db, conversation = CONVERSATION, adopt = true) {
  const ledger = previewLedgerWorkspacePolicy(db, policy).conversations.find(
    (row) => row.conversationId === conversation
  )
  if (ledger?.status !== 'resolved') throw new Error('Unresolved fixture')
  const ids = ledger.before.map((interval) => {
    const row = db
      .insert(sessions)
      .values({
        projectPath: 'C:/fixture',
        sourceFile: `C:/fixture/${conversation}.jsonl`,
        tool: 'claude',
        claudeSessionId: conversation,
        startedAt: interval.startedAt,
        endedAt: interval.endedAt,
        durationMinutes: interval.durationMinutes,
        promptCount: interval.promptCount,
        inputTokens: interval.inputTokens,
        outputTokens: interval.outputTokens
      })
      .returning()
      .get()
    db.insert(sessionDerivations)
      .values({
        sessionId: row.id,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        durationMinutes: row.durationMinutes
      })
      .run()
    for (const usage of interval.modelUsage)
      db.insert(sessionModelUsage)
        .values({ sessionId: row.id, ...usage })
        .run()
    return row.id
  })
  if (adopt) adoptSessionActivityMappings(db, previewSessionActivityAdoption(db).fingerprint, ids)
  return ids
}

function exportActivity(db: Db) {
  recordLocalSyncChanges(db, workspaceId, collectActivitySyncChanges(db, workspaceId), adapter)
}

const active = (db: Db) =>
  db
    .select()
    .from(sessions)
    .where(and(eq(sessions.claudeSessionId, CONVERSATION), activeSessionCondition))
    .orderBy(sessions.startedAt)
    .all()

it('materializes remote-only history on a blank computer and replays idempotently', () => {
  const a = open()
  const b = open()
  twoIntervalEvents(a)
  saveRows(a)
  exportActivity(a)
  deliver(a, b)

  const first = projectSharedSessions(b, workspaceId)
  expect(first).toMatchObject({ status: 'projected', deleted: [], issues: [], billingBlockers: [] })
  expect(first.applied).toHaveLength(1)
  const rows = active(b)
  expect(rows.map((row) => [row.startedAt, row.endedAt])).toEqual([
    [at('10:00'), at('10:05')],
    [at('10:40'), at('10:45')]
  ])
  // Remote history carries no source path and no guessed project folder.
  expect(rows.map((row) => [row.sourceFile, row.projectPath])).toEqual([
    [null, ''],
    [null, '']
  ])

  const decisions = b.select().from(sessionMappingDecisions).all().length
  const again = projectSharedSessions(b, workspaceId)
  expect(again).toMatchObject({ applied: [], deleted: [], updated: [], issues: [] })
  expect(b.select().from(sessionMappingDecisions).all()).toHaveLength(decisions)
  expect(active(b)).toEqual(rows)
})

it('keeps local IDs stable when imported activity appends to an interval', () => {
  const a = open()
  const b = open()
  twoIntervalEvents(a)
  saveRows(a)
  exportActivity(a)
  deliver(a, b)
  projectSharedSessions(b, workspaceId)
  const before = active(b).map((row) => row.id)

  message(a, 'm4', 'm3', '10:50')
  exportActivity(a)
  deliver(a, b)
  const result = projectSharedSessions(b, workspaceId)
  expect(result.applied).toHaveLength(1)
  expect(result.applied[0].retiredSessionIds).toEqual([])
  const after = active(b)
  expect(after.map((row) => row.id)).toEqual(before)
  expect(after[1].endedAt).toBe(at('10:50'))
})

it('binds a receiver row to an imported deletion without inventing a local deletion proof', () => {
  const a = open()
  const b = open()
  twoIntervalEvents(a)
  twoIntervalEvents(b)
  saveRows(a)
  const [keptB, deletedB] = saveRows(b)
  deleteMappedSession(a, saveRowsIds(a)[1])
  deliver(a, b)

  const result = projectSharedSessions(b, workspaceId)
  expect(result.deleted).toEqual([
    expect.objectContaining({ conversation: KEY, sessionId: deletedB, billed: false })
  ])
  expect(result.held).toEqual([])
  expect(active(b).map((row) => row.id)).toEqual([keptB])
  // The retired row stays as audit history with its deletion bound to the portable fact.
  expect(b.select().from(sessions).where(eq(sessions.id, deletedB)).get()).toBeDefined()
  const proofs = readCanonicalHistoryProofs(b, [KEY]).get(KEY)!
  expect(proofs.deletions).toEqual([])
  expect(proofs.invalid).toEqual([])
  expect(proofs.projected).toEqual([
    expect.objectContaining({
      sessionId: deletedB,
      portableOperationIds: result.deleted[0].operationIds
    })
  ])
  expect(readCanonicalHistoryConstraints(b, [KEY]).get(KEY)!.invalid).toEqual([])
  // Re-exporting B's history never republishes the projection as a new deletion fact.
  expect(
    collectHistorySyncChanges(b, workspaceId).changes.filter(
      (change) => change.entityType === 'session-deletion'
    )
  ).toEqual([])

  // Repeated replay changes nothing.
  const deletions = b.select().from(sessionDeletions).all()
  expect(projectSharedSessions(b, workspaceId)).toMatchObject({ applied: [], deleted: [] })
  expect(b.select().from(sessionDeletions).all()).toEqual(deletions)
})

it('retires a receiver row at an imported cut and preserves the original as audit history', () => {
  const a = open()
  const b = open()
  twoIntervalEvents(a)
  twoIntervalEvents(b)
  saveRows(a)
  const [wholeB, laterB] = saveRows(b)
  splitMappedSession(a, saveRowsIds(a)[0], at('10:02'))
  deliver(a, b)

  const result = projectSharedSessions(b, workspaceId)
  expect(result.applied).toHaveLength(1)
  expect(result.applied[0].retiredSessionIds).toEqual([wholeB])
  const rows = active(b)
  expect(rows.map((row) => [row.startedAt, row.endedAt])).toEqual([
    [at('10:00'), at('10:02')],
    [at('10:02'), at('10:05')],
    [at('10:40'), at('10:45')]
  ])
  expect(rows[2].id).toBe(laterB)
  expect(
    b
      .select()
      .from(sessionReplacements)
      .where(eq(sessionReplacements.predecessorSessionId, wholeB))
      .all()
  ).toHaveLength(2)
  expect(projectSharedSessions(b, workspaceId)).toMatchObject({ applied: [], deleted: [] })
})

it('retires a partly deleted receiver row, keeping only the surviving part counted', () => {
  const a = open()
  const b = open()
  twoIntervalEvents(a)
  twoIntervalEvents(b)
  saveRows(a)
  const [wholeB] = saveRows(b)
  const [early] = splitMappedSession(a, saveRowsIds(a)[0], at('10:02'))
  deleteMappedSession(a, early.id)
  deliver(a, b)

  const result = projectSharedSessions(b, workspaceId)
  expect(result.held).toEqual([])
  expect(result.applied[0].retiredSessionIds).toEqual([wholeB])
  expect(active(b).map((row) => [row.startedAt, row.endedAt])).toEqual([
    [at('10:02'), at('10:05')],
    [at('10:40'), at('10:45')]
  ])
})

it('lets unaffected conversations progress while unlinked local history stays held', () => {
  const a = open()
  const b = open()
  twoIntervalEvents(a)
  twoIntervalEvents(b)
  saveRows(a)
  const [, deletedB] = saveRows(b)
  twoIntervalEvents(b, 'conversation-2')
  const unlinked = saveRows(b, 'conversation-2', false)
  deleteMappedSession(a, saveRowsIds(a)[1])
  deliver(a, b)

  const result = projectSharedSessions(b, workspaceId)
  expect(result.deleted.map((row) => row.sessionId)).toEqual([deletedB])
  expect(result.held).toEqual([
    {
      conversation: JSON.stringify(['claude', 'conversation-2']),
      reasons: ['unadopted-history'],
      sessionIds: unlinked
    }
  ])
  // Held local rows are untouched.
  for (const id of unlinked)
    expect(
      b.select().from(sessionDeletions).where(eq(sessionDeletions.sessionId, id)).get()
    ).toBeUndefined()
})

it('holds a deletion whose evidence has not arrived and keeps the receiver row counting', () => {
  const a = open()
  const b = open()
  twoIntervalEvents(a)
  // A saw one more event before deleting; its activity is not delivered to B.
  message(a, 'm4', 'm3', '10:50')
  twoIntervalEvents(b)
  const [, partialB] = saveRows(b)
  saveRows(a)
  deleteMappedSession(a, saveRowsIds(a)[1])
  deliver(a, b)

  const result = projectSharedSessions(b, workspaceId)
  expect(result.deleted).toEqual([])
  expect(result.issues.map((row) => [row.code, row.sessionIds])).toContainEqual([
    'deletion-waiting',
    [partialB]
  ])
  expect(active(b).map((row) => row.id)).toContain(partialB)
  expect(b.select().from(sessionDeletions).all()).toEqual([])
  expect(
    b.select().from(syncChanges).where(eq(syncChanges.entityType, 'session-deletion')).all()
  ).toHaveLength(1)
})

/** Adopted rows of the fixture conversation on one computer, in time order. */
function saveRowsIds(db: Db): number[] {
  return active(db).map((row) => row.id)
}

it('bootstraps saved assignments and merges disjoint edits across remapped local client IDs', () => {
  const a = open()
  const b = open()
  a.insert(clients).values({ id: 7, name: 'Shared client', color: '#123456' }).run()
  const project = a
    .insert(projects)
    .values({ clientId: 7, name: 'Shared project' })
    .returning()
    .get()
  b.insert(clients).values({ id: 44, name: 'Existing local client', color: '#654321' }).run()
  twoIntervalEvents(a)
  const [id] = saveRows(a)
  a.update(sessions)
    .set({ clientId: 7, projectId: project.id, description: 'Saved description' })
    .where(eq(sessions.id, id))
    .run()
  expect(bootstrapFolderSync(a, workspaceId)).toEqual([])
  const count = a.select().from(syncChanges).all().length
  expect(bootstrapFolderSync(a, workspaceId)).toEqual([])
  expect(a.select().from(syncChanges).all()).toHaveLength(count)
  deliver(a, b)
  expect(projectSharedSessions(b, workspaceId).issues).toEqual([])
  const remote = active(b)[0]
  expect(remote).toMatchObject({
    description: 'Saved description',
    projectPath: '',
    sourceFile: null
  })
  expect(remote.clientId).not.toBe(7)
  expect(b.select().from(clients).where(eq(clients.id, remote.clientId!)).get()?.name).toBe(
    'Shared client'
  )
  a.transaction((tx) =>
    journalSessionMutation(tx, id, () =>
      tx.update(sessions).set({ description: 'Edited on A' }).where(eq(sessions.id, id)).run()
    )
  )
  b.transaction((tx) =>
    journalSessionMutation(tx, remote.id, () =>
      tx.update(sessions).set({ billable: 0 }).where(eq(sessions.id, remote.id)).run()
    )
  )
  deliver(a, b)
  deliver(b, a)
  expect(projectSharedSessions(a, workspaceId).issues).toEqual([])
  expect(projectSharedSessions(b, workspaceId).issues).toEqual([])
  expect(active(a)[0]).toMatchObject({ description: 'Edited on A', billable: 0 })
  expect(active(b)[0]).toMatchObject({ description: 'Edited on A', billable: 0 })
})

it('keeps a split copy held when another computer edited its source offline', () => {
  const a = open()
  const b = open()
  twoIntervalEvents(a)
  const [id] = saveRows(a)
  a.update(sessions).set({ description: 'Before split' }).where(eq(sessions.id, id)).run()
  bootstrapFolderSync(a, workspaceId)
  deliver(a, b)
  projectSharedSessions(b, workspaceId)
  const remote = active(b)[0]
  a.transaction((tx) => {
    prepareSessionSync(tx)
    const children = splitMappedSession(tx, id, at('10:02'))
    journalMappedSplitCopies(
      tx,
      id,
      children.map((row) => row.id)
    )
  })
  b.transaction((tx) =>
    journalSessionMutation(tx, remote.id, () =>
      tx
        .update(sessions)
        .set({ description: 'Offline edit' })
        .where(eq(sessions.id, remote.id))
        .run()
    )
  )
  deliver(b, a)
  const result = projectSharedSessions(a, workspaceId)
  expect(result.issues.some((issue) => issue.code === 'metadata-held')).toBe(true)
  expect(result.billingBlockers.length).toBeGreaterThan(0)
  expect(active(a).find((row) => row.startedAt === at('10:02'))?.description).toBe('Before split')
})

it('retains billed audit rows and reports a concurrent edit when a remote deletion arrives', () => {
  const a = open()
  const b = open()
  twoIntervalEvents(a)
  const [id] = saveRows(a)
  bootstrapFolderSync(a, workspaceId)
  deliver(a, b)
  projectSharedSessions(b, workspaceId)
  const remote = active(b)[0]
  b.insert(sessionBillingRefs)
    .values({
      sessionId: remote.id,
      stripeInvoiceId: 'in_saved',
      testMode: 1,
      billedRanges: [billingRange(remote)]
    })
    .run()
  a.transaction((tx) =>
    deleteMappedSession(tx, id, { observedSessionEditHeads: mappedSessionObservedHeads(tx, id) })
  )
  b.transaction((tx) =>
    journalSessionMutation(tx, remote.id, () =>
      tx
        .update(sessions)
        .set({ description: 'Offline after deletion elsewhere' })
        .where(eq(sessions.id, remote.id))
        .run()
    )
  )
  deliver(a, b)
  const result = projectSharedSessions(b, workspaceId)
  expect(active(b).some((row) => row.id === remote.id)).toBe(false)
  expect(b.select().from(sessions).where(eq(sessions.id, remote.id)).get()).toBeDefined()
  expect(b.select().from(sessionBillingRefs).all()).toHaveLength(1)
  expect(result.issues.some((issue) => issue.code === 'edit-delete-conflict')).toBe(true)
})

const ledgerScopes = () =>
  vi.mocked(readCanonicalActivity).mock.calls.map(([, conversationKeys]) => conversationKeys)
const onlyScope = (key: string) =>
  ledgerScopes().length > 0 &&
  ledgerScopes().every((keys) => JSON.stringify(keys) === JSON.stringify([key]))

it('projects one conversation at a time without reading another conversation ledger', () => {
  const a = open()
  const b = open()
  const LARGE = JSON.stringify(['claude', 'large'])
  twoIntervalEvents(a)
  twoIntervalEvents(a, 'large')
  saveRows(a)
  saveRows(a, 'large')
  exportActivity(a)
  deliver(a, b)
  expect(sharedSessionConversationKeys(b)).toEqual([KEY, LARGE].sort())

  vi.mocked(readCanonicalActivity).mockClear()
  const scoped = projectSharedSessions(b, workspaceId, { conversationKeys: [KEY] })
  expect(onlyScope(KEY)).toBe(true)
  expect(scoped.applied.map((row) => row.conversation)).toEqual([KEY])
  expect(active(b)).toHaveLength(2)
  expect(b.select().from(sessions).where(eq(sessions.claudeSessionId, 'large')).all()).toEqual([])

  const rest = projectSharedSessions(b, workspaceId, { conversationKeys: [LARGE] })
  expect(rest.applied.map((row) => row.conversation)).toEqual([LARGE])
  // Iterating every key leaves nothing for an unscoped projection.
  expect(projectSharedSessions(b, workspaceId)).toMatchObject({
    applied: [],
    deleted: [],
    issues: []
  })
})

it('keeps imported deletions, billing retention and conflicts when projecting one conversation', () => {
  const a = open()
  const b = open()
  twoIntervalEvents(a)
  const [id] = saveRows(a)
  bootstrapFolderSync(a, workspaceId)
  deliver(a, b)
  projectSharedSessions(b, workspaceId, { conversationKeys: [KEY] })
  const remote = active(b)[0]
  // Unlinked local history of another conversation stays outside every scoped step below.
  twoIntervalEvents(b, 'unrelated')
  const unrelated = saveRows(b, 'unrelated', false)
  b.insert(sessionBillingRefs)
    .values({
      sessionId: remote.id,
      stripeInvoiceId: 'in_saved',
      testMode: 1,
      billedRanges: [billingRange(remote)]
    })
    .run()
  a.transaction((tx) =>
    deleteMappedSession(tx, id, { observedSessionEditHeads: mappedSessionObservedHeads(tx, id) })
  )
  b.transaction((tx) =>
    journalSessionMutation(tx, remote.id, () =>
      tx
        .update(sessions)
        .set({ description: 'Offline after deletion elsewhere' })
        .where(eq(sessions.id, remote.id))
        .run()
    )
  )
  deliver(a, b)
  vi.mocked(readCanonicalActivity).mockClear()
  const result = projectSharedSessions(b, workspaceId, { conversationKeys: [KEY] })
  expect(onlyScope(KEY)).toBe(true)
  expect(active(b).some((row) => row.id === remote.id)).toBe(false)
  expect(b.select().from(sessions).where(eq(sessions.id, remote.id)).get()).toBeDefined()
  expect(b.select().from(sessionBillingRefs).all()).toHaveLength(1)
  expect(result.issues.some((issue) => issue.code === 'edit-delete-conflict')).toBe(true)
  expect(result.billingBlockers.some((row) => row.code === 'edit-delete-conflict')).toBe(true)
  expect(
    [...result.held, ...result.issues, ...result.billingBlockers].every(
      (row) => row.conversation === KEY
    )
  ).toBe(true)
  expect(
    b
      .select()
      .from(sessionActivityMappings)
      .where(inArray(sessionActivityMappings.sessionId, unrelated))
      .all()
  ).toEqual([])
})
