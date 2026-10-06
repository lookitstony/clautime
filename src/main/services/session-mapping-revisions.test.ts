// @vitest-environment node
import { beforeEach, afterEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { removeSessionMappingRevisions } from '../db/migration-test-helpers'
import {
  workspacePolicyRevisions,
  sessionMappingRevisions
} from '../db/schema/session-mapping-revisions'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { adoptInitialWorkspacePolicy } from './workspace-policy'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
const migrationsFolder = join(__dirname, '../db/migrations')
const snapshot = {
  workspaceId: 'fb751832-c62e-4f27-bc3f-b6a7a8e31214',
  revisionId: 'fbd24e8f-4aa9-4420-889a-574e83cdd267',
  policy: {
    version: 1,
    normalizationVersion: 1,
    detectorVersion: 1,
    idleTimeoutMinutes: 15,
    reportingTimeZone: 'UTC'
  }
}
beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder })
})
afterEach(() => sqlite.close())

function upgradedFixture() {
  removeSessionMappingRevisions(sqlite)
  sqlite
    .prepare('INSERT INTO workspace_policy VALUES (1, ?, ?, ?)')
    .run(snapshot.workspaceId, snapshot.revisionId, JSON.stringify(snapshot.policy))
  sqlite.exec(
    "INSERT INTO sessions (id,project_path,started_at,ended_at,duration_minutes,created_at,updated_at) VALUES (1,'fixture','2026-09-27T00:00:00.000Z','2026-09-27T00:10:00.000Z',10,'2026-09-27T00:00:00.000Z','2026-09-27T00:00:00.000Z')"
  )
  sqlite
    .prepare(
      'INSERT INTO session_activity_mappings (id,session_id,version,workspace_id,policy_revision_id,policy_json,provider,conversation_id,interval_json,preview_fingerprint,created_at) VALUES (?,1,1,?,?,?, ?,?, ?,?,?)'
    )
    .run(
      'bccccccc-cccc-4ccc-accc-cccccccccccc',
      snapshot.workspaceId,
      snapshot.revisionId,
      JSON.stringify(snapshot.policy),
      'claude',
      'conversation',
      '{}',
      'receipt',
      '2026-09-27T00:00:00.000Z'
    )
  const saved = sqlite.prepare('SELECT * FROM sessions').all()
  migrate(db, { migrationsFolder })
  return saved
}

it('backfills immutable origins without changing saved rows or adoption identities', () => {
  const saved = upgradedFixture()
  const mapping = db.select().from(sessionActivityMappings).get()!
  const revision = db.select().from(sessionMappingRevisions).get()!
  expect(revision.id).toBe(mapping.id)
  expect(mapping.revisionId).toBe(mapping.id)
  expect(JSON.parse(revision.snapshotJson)).toEqual(mapping)
  expect(sqlite.prepare('SELECT * FROM sessions').all()).toEqual(saved)
  expect(db.select().from(workspacePolicyRevisions).get()).toMatchObject({
    id: snapshot.revisionId,
    workspaceId: snapshot.workspaceId,
    policyJson: JSON.stringify(snapshot.policy),
    parentRevisionId: null
  })
  const before = sqlite.serialize()
  migrate(db, { migrationsFolder })
  expect(sqlite.serialize()).toEqual(before)
  expect(sqlite.pragma('foreign_key_check')).toEqual([])
})

it('records a new workspace origin atomically and leaves it unchanged on retry', () => {
  adoptInitialWorkspacePolicy(db, snapshot)
  const before = sqlite.serialize()
  expect(adoptInitialWorkspacePolicy(db, snapshot)).toEqual(snapshot)
  expect(sqlite.serialize()).toEqual(before)
  expect(db.select().from(workspacePolicyRevisions).all()).toHaveLength(1)
})

it.each([
  'workspace_policy_revisions',
  'session_mapping_revisions',
  'session_mapping_decisions',
  'session_mapping_edges',
  'session_mapping_outcomes'
])('rejects updates and deletes of immutable %s records', (table) => {
  upgradedFixture()
  sqlite.exec(
    "INSERT INTO session_mapping_decisions VALUES ('decision','{}','receipt','base','target','[]','[]','[]','[]','now')"
  )
  sqlite.exec(
    "INSERT INTO session_mapping_revisions VALUES ('next','bccccccc-cccc-4ccc-accc-cccccccccccc',1,'continue','{}','decision','now')"
  )
  sqlite.exec(
    "INSERT INTO session_mapping_edges VALUES ('next','bccccccc-cccc-4ccc-accc-cccccccccccc')"
  )
  sqlite.exec("INSERT INTO session_mapping_outcomes VALUES ('decision','{}','now')")
  const column =
    table === 'session_mapping_edges'
      ? 'child_revision_id'
      : table === 'session_mapping_outcomes'
        ? 'decision_id'
        : 'id'
  const before = sqlite.serialize()
  expect(() => sqlite.exec(`UPDATE ${table} SET ${column} = ${column}`)).toThrow(/immutable/)
  expect(() => sqlite.exec(`DELETE FROM ${table}`)).toThrow(/immutable/)
  expect(sqlite.serialize()).toEqual(before)
})

it('rolls back a workspace origin if installing its current head fails', () => {
  sqlite.exec(
    "CREATE TRIGGER fail_head BEFORE INSERT ON workspace_policy BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"
  )
  const before = sqlite.serialize()
  expect(() => adoptInitialWorkspacePolicy(db, snapshot)).toThrow(/fixture failure/)
  expect(sqlite.serialize()).toEqual(before)
})
