// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { sessions } from '../db/schema/sessions'
import {
  syncChanges,
  syncBatches,
  syncOutbox,
  syncReceipts,
  syncBatchChanges
} from '../db/schema/folder-sync'
import { removeFolderSyncJournal } from '../db/migration-test-helpers'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
const migrationsFolder = join(__dirname, '../db/migrations')
beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
})
afterEach(() => sqlite.close())
function change() {
  db.insert(syncChanges)
    .values({
      id: 'change',
      workspaceId: 'workspace',
      kind: 'fact',
      entityType: 'legacy-session',
      entityId: 'session',
      changeJson: '{}',
      origin: 'local',
      recordedAt: '2026-09-27T00:00:00Z'
    })
    .run()
}
function batch() {
  db.insert(syncBatches)
    .values({
      id: 'batch',
      workspaceId: 'workspace',
      writerEpochId: 'epoch',
      sequence: 1,
      deviceId: 'device',
      checksum: 'checksum',
      envelopeJson: '{}',
      direction: 'outgoing',
      recordedAt: '2026-09-27T00:00:00Z'
    })
    .run()
}
it('upgrades retained history with sync disconnected and no portable data inferred', () => {
  removeFolderSyncJournal(sqlite)
  db.insert(sessions)
    .values({
      source: 'manual',
      projectPath: 'C:/fixture',
      startedAt: '2026-09-27T00:00:00Z',
      endedAt: '2026-09-27T01:00:00Z',
      durationMinutes: 60
    })
    .run()
  const rows = db.select().from(sessions).all()
  migrate(db, { migrationsFolder })
  expect(db.select().from(sessions).all()).toEqual(rows)
  expect(sqlite.prepare('SELECT * FROM folder_sync_settings').all()).toEqual([])
  expect(db.select().from(syncChanges).all()).toEqual([])
})
it('rolls back a business edit and its outgoing change together', () => {
  const before = sqlite.serialize()
  expect(() =>
    db.transaction((tx) => {
      tx.insert(sessions)
        .values({
          source: 'manual',
          projectPath: 'C:/fixture',
          startedAt: '2026-09-27T00:00:00Z',
          endedAt: '2026-09-27T01:00:00Z',
          durationMinutes: 60
        })
        .run()
      change()
      throw new Error('simulated crash')
    })
  ).toThrow('simulated crash')
  expect(sqlite.serialize()).toEqual(before)
})
it('retains immutable changes, envelopes, membership and receipts while allowing local publication state', () => {
  change()
  batch()
  db.insert(syncBatchChanges).values({ batchId: 'batch', changeId: 'change' }).run()
  db.insert(syncOutbox).values({ batchId: 'batch' }).run()
  db.insert(syncReceipts).values({ batchId: 'batch', importedAt: '2026-09-27T00:00:00Z' }).run()
  for (const [table, field] of [
    ['sync_changes', 'change_json'],
    ['sync_batches', 'envelope_json'],
    ['sync_batch_changes', 'change_id'],
    ['sync_receipts', 'imported_at']
  ]) {
    expect(() => sqlite.exec(`UPDATE ${table} SET ${field} = 'changed'`)).toThrow(/immutable/)
    expect(() => sqlite.exec(`DELETE FROM ${table}`)).toThrow(/retained/)
  }
  db.update(syncOutbox).set({ publishedAt: '2026-09-27T01:00:00Z' }).run()
  expect(db.select().from(syncOutbox).get()?.publishedAt).toBe('2026-09-27T01:00:00Z')
})
