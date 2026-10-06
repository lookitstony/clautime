// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { sessions } from '../db/schema/sessions'
import { sessionDerivations } from '../db/schema/session-derivations'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import {
  sessionReconciliationCases,
  sessionReconciliationResolutions
} from '../db/schema/session-reconciliation'
import type { DetectedSession } from '../../shared/types/session'
import {
  getReconciliationCases,
  keepSavedHistory,
  mapSavedHistory,
  recordReconciliationFailure,
  replaceSavedHistory,
  resolveReconciliationCase
} from './session-reconciliation'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle>
vi.mock('../db', () => ({ getDb: () => db }))
const source = 'C:/fixture/log.jsonl'
const copy = 'C:/copy/log.jsonl'
const at = (time: string) => `2026-09-26T${time}:00.000Z`
beforeEach(() => {
  sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite)
  migrate(db, { migrationsFolder: join(__dirname, '../db/migrations') })
})
afterEach(() => sqlite.close())

const detected = (sourceFile = source): DetectedSession => ({
  startedAt: at('03:00'),
  endedAt: at('03:05'),
  durationMinutes: 5,
  projectPath: 'C:/fixture',
  tool: 'claude',
  claudeSessionId: 'conversation',
  sourceFile,
  promptCount: 1,
  inputTokens: 0,
  outputTokens: 0,
  modelUsage: []
})
function saved() {
  const row = db
    .insert(sessions)
    .values({
      projectPath: 'C:/fixture',
      sourceFile: source,
      source: 'auto',
      tool: 'claude',
      claudeSessionId: 'conversation',
      startedAt: at('03:00'),
      endedAt: at('03:10'),
      durationMinutes: 10,
      promptCount: 1
    })
    .returning()
    .get()
  db.insert(sessionDerivations)
    .values({
      sessionId: row.id,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationMinutes: 10
    })
    .run()
  return row
}
function adopted(sessionId: number) {
  db.insert(sessionActivityMappings)
    .values({
      id: 'mapping',
      sessionId,
      version: 1,
      workspaceId: 'workspace',
      policyRevisionId: 'revision',
      policyJson: '{}',
      provider: 'claude',
      conversationId: 'conversation',
      intervalJson: '{}',
      previewFingerprint: 'fixture',
      createdAt: at('04:00')
    })
    .run()
}
function fail(message: string, mapping = false, sourceFile = source) {
  recordReconciliationFailure(
    db,
    sourceFile,
    message,
    [detected(sourceFile)],
    15,
    undefined,
    mapping
  )
  return db
    .select()
    .from(sessionReconciliationCases)
    .where(eq(sessionReconciliationCases.sourceFile, sourceFile))
    .get()!
}
function legacyActions(sourceFile: string, fingerprint: string, sessionId: number) {
  const intervals = [detected(sourceFile)]
  return [
    () => keepSavedHistory(db, sourceFile, fingerprint, intervals, 15),
    () =>
      mapSavedHistory(
        db,
        sourceFile,
        fingerprint,
        [{ sessionId, detectedIndex: 0 }],
        intervals,
        15
      ),
    () => replaceSavedHistory(db, sourceFile, fingerprint, intervals, 15)
  ]
}

it('keeps an unresolved legacy case protected and visible through transient mapping failures', () => {
  saved()
  expect(fail('Legacy totals differ.')).toMatchObject({ mappingReview: 0 })
  expect(fail('Mapping hold one.', true)).toMatchObject({
    mappingReview: 0,
    message: expect.stringMatching(/^Legacy totals differ\.\n\n.*Mapping hold one\.$/)
  })
  // Repeated scanner failures replace only the transient note.
  const repeated = fail('Mapping hold two.', true)
  expect(repeated.mappingReview).toBe(0)
  expect(repeated.message).toMatch(/^Legacy totals differ\.\n\n.*Mapping hold two\.$/)
  expect(repeated.message).not.toContain('Mapping hold one.')
  // A later ordinary failure is the current legacy discrepancy.
  expect(fail('Legacy totals still differ.')).toMatchObject({
    mappingReview: 0,
    message: 'Legacy totals still differ.'
  })
})

it('lets a resolved case become a new mapping case and a legacy failure raise protection', () => {
  saved()
  fail('Legacy totals differ.')
  resolveReconciliationCase(db, source)
  expect(fail('Mapping hold.', true)).toMatchObject({
    mappingReview: 1,
    message: 'Mapping hold.',
    resolvedAt: null
  })
  expect(fail('Mapping hold again.', true)).toMatchObject({
    mappingReview: 1,
    message: 'Mapping hold again.'
  })
  expect(fail('Legacy totals differ.')).toMatchObject({
    mappingReview: 0,
    message: 'Legacy totals differ.'
  })
})

it('rejects legacy keep, map and replace for a mapping-review case without writes', () => {
  const row = saved()
  const review = fail('Mapping hold.', true)
  const before = sqlite.serialize()
  for (const fingerprint of [review.fingerprint!, 'stale-direct-request'])
    for (const action of legacyActions(source, fingerprint, row.id))
      expect(action).toThrow(/managed by reviewed activity mappings/)
  expect(sqlite.serialize()).toEqual(before)
  expect(db.select().from(sessionReconciliationResolutions).all()).toEqual([])
})

it('rejects legacy actions for mapping-managed conversations and their source copies', () => {
  const row = saved()
  adopted(row.id)
  const review = fail('Legacy totals differ.')
  const copied = fail('Copied totals differ.', false, copy)
  expect(review.mappingReview).toBe(0)
  expect(copied.mappingReview).toBe(0)
  const before = sqlite.serialize()
  for (const [sourceFile, fingerprint] of [
    [source, review.fingerprint!],
    [copy, copied.fingerprint!]
  ])
    for (const action of legacyActions(sourceFile, fingerprint, row.id))
      expect(action).toThrow(/managed by reviewed activity mappings/)
  expect(sqlite.serialize()).toEqual(before)
  expect(
    getReconciliationCases()
      .map(({ sourceFile, mappingManaged }) => ({ sourceFile, mappingManaged }))
      .sort((a, b) => a.sourceFile.localeCompare(b.sourceFile))
  ).toEqual([
    { sourceFile: copy, mappingManaged: true },
    { sourceFile: source, mappingManaged: true }
  ])
})

it('keeps legacy resolution available once a transient mapping case is resolved', () => {
  saved()
  fail('Mapping hold.', true)
  expect(getReconciliationCases()).toMatchObject([{ mappingManaged: true }])
  resolveReconciliationCase(db, source)
  const review = fail('Legacy totals differ.')
  expect(getReconciliationCases()).toMatchObject([{ mappingManaged: false }])
  keepSavedHistory(db, source, review.fingerprint!, [detected()], 15)
  expect(db.select().from(sessionReconciliationResolutions).all()).toMatchObject([
    { sourceFile: source, action: 'keep_saved' }
  ])
})
