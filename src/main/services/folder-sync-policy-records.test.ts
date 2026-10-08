// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { folderSyncSettings } from '../db/schema/folder-sync'
import { workspacePolicy } from '../db/schema/workspace-policy'
import { initializeWorkspacePolicy } from './workspace-policy'
import {
  recordLocalSyncChanges,
  assembleOutgoingBatch,
  retainIncomingBatch,
  applyReadySyncBatches
} from './folder-sync-store'
import {
  initialWorkspacePolicyChange,
  journalWorkspacePolicyChange,
  planWorkspacePolicyRevision,
  sharedWorkspacePolicyView,
  validateWorkspacePolicyChange,
  workspacePolicySyncAdapter
} from './folder-sync-policy-records'

const opened: Database.Database[] = []
type Db = ReturnType<typeof drizzle>
let a: Db
let b: Db
let workspaceId: string
const writer = () => ({ deviceId: randomUUID(), writerEpochId: randomUUID() })
function database() {
  const sqlite = new Database(':memory:')
  opened.push(sqlite)
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
  return db
}
function transfer(from: Db, to: Db) {
  const batch = assembleOutgoingBatch(from, workspaceId, writer())!
  retainIncomingBatch(to, workspaceId, batch, workspacePolicySyncAdapter)
  const result = applyReadySyncBatches(to, workspaceId, workspacePolicySyncAdapter)
  expect(result.errors).toEqual([])
  expect(result.waiting).toEqual([])
}
beforeEach(() => {
  a = database()
  b = database()
  workspaceId = randomUUID()
  const local = initializeWorkspacePolicy(a, 'America/New_York')
  a.insert(folderSyncSettings)
    .values({
      slot: 1,
      workspaceId,
      policyWorkspaceId: local.workspaceId,
      folderPath: 'C:/disposable/offline',
      enabled: 0
    })
    .run()
})
afterEach(() => {
  for (const sqlite of opened.splice(0)) sqlite.close()
})

it('transfers explicit creator policy without adopting a receiver timezone or creating local session decisions', () => {
  const change = initialWorkspacePolicyChange(a, workspaceId)!
  expect(change).toEqual(initialWorkspacePolicyChange(a, workspaceId))
  recordLocalSyncChanges(a, workspaceId, [change], workspacePolicySyncAdapter)
  transfer(a, b)
  expect(sharedWorkspacePolicyView(a, workspaceId)).toEqual(
    sharedWorkspacePolicyView(b, workspaceId)
  )
  expect(sharedWorkspacePolicyView(b, workspaceId).fields.policy.value).toMatchObject({
    reportingTimeZone: 'America/New_York',
    idleTimeoutMinutes: 15
  })
  expect(b.select().from(workspacePolicy).all()).toEqual([])
  expect(initialWorkspacePolicyChange(a, workspaceId)).toBeNull()
})

it('keeps concurrent entire policies and last agreed policy until an explicit resolution', () => {
  recordLocalSyncChanges(
    a,
    workspaceId,
    [initialWorkspacePolicyChange(a, workspaceId)!],
    workspacePolicySyncAdapter
  )
  transfer(a, b)
  const base = sharedWorkspacePolicyView(a, workspaceId)
  const value = base.fields.policy.value as Record<string, never>
  for (const [db, timeout] of [
    [a, 10],
    [b, 20]
  ] as const) {
    const change = planWorkspacePolicyRevision(db, workspaceId, randomUUID(), {
      type: 'edit',
      observedHeads: base.heads,
      values: { policy: { ...value, idleTimeoutMinutes: timeout } }
    })
    recordLocalSyncChanges(db, workspaceId, [change], workspacePolicySyncAdapter)
  }
  transfer(a, b)
  transfer(b, a)
  const conflicted = sharedWorkspacePolicyView(a, workspaceId)
  expect(conflicted.conflicts).toEqual(['policy'])
  expect(conflicted.fields.policy.value).toEqual(base.fields.policy.value)
  expect(sharedWorkspacePolicyView(b, workspaceId)).toEqual(conflicted)
  expect(() => journalWorkspacePolicyChange(a, { ...value, idleTimeoutMinutes: 25 })).toThrow(
    /Resolve/
  )
  const resolved = planWorkspacePolicyRevision(a, workspaceId, randomUUID(), {
    type: 'resolve',
    expectedHeads: conflicted.heads,
    values: { policy: { ...value, idleTimeoutMinutes: 20 } }
  })
  recordLocalSyncChanges(a, workspaceId, [resolved], workspacePolicySyncAdapter)
  transfer(a, b)
  expect(sharedWorkspacePolicyView(b, workspaceId).conflicts).toEqual([])
  expect(sharedWorkspacePolicyView(b, workspaceId).fields.policy.value).toMatchObject({
    idleTimeoutMinutes: 20
  })
})

it('journals reviewed changes while transfer is disabled and rolls back with the enclosing operation', () => {
  recordLocalSyncChanges(
    a,
    workspaceId,
    [initialWorkspacePolicyChange(a, workspaceId)!],
    workspacePolicySyncAdapter
  )
  const base = sharedWorkspacePolicyView(a, workspaceId)
  const value = base.fields.policy.value as Record<string, never>
  expect(() =>
    a.transaction((tx) => {
      journalWorkspacePolicyChange(tx, { ...value, idleTimeoutMinutes: 30 })
      throw Error('failed local mapping application')
    })
  ).toThrow('failed local mapping')
  expect(sharedWorkspacePolicyView(a, workspaceId)).toEqual(base)
  a.transaction((tx) => journalWorkspacePolicyChange(tx, { ...value, idleTimeoutMinutes: 30 }))
  expect(sharedWorkspacePolicyView(a, workspaceId).fields.policy.value).toMatchObject({
    idleTimeoutMinutes: 30
  })
})

it('pauses on newer versions and rejects removal, foreign-workspace policy and extra fields', () => {
  const base = initialWorkspacePolicyChange(a, workspaceId)!
  const newer = structuredClone(base)
  ;(newer.payload.fields.policy.value as Record<string, unknown>).normalizationVersion = 3
  expect(() => validateWorkspacePolicyChange(newer)).toThrowError(
    expect.objectContaining({ code: 'SYNC_UPDATE_REQUIRED' })
  )
  const removed = structuredClone(base)
  removed.payload.fields.$present.value = false
  expect(() => validateWorkspacePolicyChange(removed)).toThrow(/cannot be removed/)
  const wrong = structuredClone(base)
  wrong.entityId = randomUUID()
  expect(() =>
    recordLocalSyncChanges(a, workspaceId, [wrong], workspacePolicySyncAdapter)
  ).toThrowError(expect.objectContaining({ code: 'SYNC_WRONG_WORKSPACE' }))
  const extra = structuredClone(base)
  extra.payload.fields.credential = { value: 'not-allowed', parents: [] }
  expect(() => validateWorkspacePolicyChange(extra)).toThrow()
})
