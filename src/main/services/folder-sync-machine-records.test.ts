// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sourceMachines } from '../db/schema/activity-observers'
import { folderSyncSettings } from '../db/schema/folder-sync'
import { activitySyncAdapter, collectActivitySyncChanges } from './folder-sync-activity-records'
import {
  applyReadySyncBatches,
  assembleOutgoingBatch,
  recordLocalSyncChanges,
  retainIncomingBatch,
  type SyncDomainAdapter
} from './folder-sync-store'
import {
  journalMachineRename,
  machineFactChangeId,
  machineLabelSyncAdapter,
  machineLabelView,
  MACHINE_LABEL_SYNC_SCHEMA,
  planMachineRename,
  validateMachineLabelChange
} from './folder-sync-machine-records'
import { planRevision } from './folder-sync-revisions'
import { listSourceMachines } from './folder-sync-machine-view'

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

type Db = ReturnType<typeof drizzle>
const WORKSPACE = '2fd7cbd1-7f6b-4935-b18c-367ae5ff5fb9'
const DESK = '9b95ec41-b3b6-4cbb-b1b6-e7ce607ef222'
const LAPTOP = '7c8f7eab-af58-4cbb-9e74-d1e47f80d600'
const opened: Database.Database[] = []
let a: Db
let b: Db

// Test router: activity facts (machines) plus the label adapter under test.
const adapter: SyncDomainAdapter = {
  validate: (change) =>
    (change.entityType === 'machine-label'
      ? machineLabelSyncAdapter
      : activitySyncAdapter
    ).validate(change),
  apply: (tx, workspaceId, change) =>
    (change.entityType === 'machine-label' ? machineLabelSyncAdapter : activitySyncAdapter).apply(
      tx,
      workspaceId,
      change
    )
}

function database(): Db {
  const connection = new Database(':memory:')
  connection.pragma('foreign_keys = ON')
  opened.push(connection)
  const target = drizzle(connection)
  migrate(target, { migrationsFolder: join(__dirname, '../db/migrations') })
  target
    .insert(folderSyncSettings)
    .values({ slot: 1, workspaceId: WORKSPACE, folderPath: 'C:/disposable/offline', enabled: 0 })
    .run()
  return target
}

function transfer(from: Db, to: Db): void {
  const batch = assembleOutgoingBatch(from, WORKSPACE, {
    deviceId: randomUUID(),
    writerEpochId: randomUUID()
  })
  if (!batch) return
  retainIncomingBatch(to, WORKSPACE, batch, adapter)
  const result = applyReadySyncBatches(to, WORKSPACE, adapter)
  expect(result.errors).toEqual([])
  expect(result.waiting).toEqual([])
}

function label(db: Db, deviceId: string) {
  return listSourceMachines(db).find((machine) => machine.deviceId === deviceId)!
}

beforeEach(() => {
  a = database()
  b = database()
  // Two registrations that happen to share an original name.
  a.insert(sourceMachines)
    .values([
      { deviceId: DESK, initialName: 'PC' },
      { deviceId: LAPTOP, initialName: 'PC' }
    ])
    .run()
  recordLocalSyncChanges(a, WORKSPACE, collectActivitySyncChanges(a, WORKSPACE), adapter)
  transfer(a, b)
})
afterEach(() => {
  for (const connection of opened.splice(0)) connection.close()
})

it('falls back to original names and marks duplicate originals so each UUID stays editable', () => {
  expect(listSourceMachines(b, DESK)).toEqual([
    {
      deviceId: LAPTOP,
      label: 'PC',
      originalName: 'PC',
      labelBasis: 'original',
      alternatives: [],
      labelHeads: {},
      duplicateLabel: true,
      isThisComputer: false
    },
    {
      deviceId: DESK,
      label: 'PC',
      originalName: 'PC',
      labelBasis: 'original',
      alternatives: [],
      labelHeads: {},
      duplicateLabel: true,
      isThisComputer: true
    }
  ])
})

it('shares a rename by device UUID without touching the immutable original name', () => {
  journalMachineRename(a, { deviceId: LAPTOP, name: '  Laptop  ', observedHeads: {} })
  transfer(a, b)
  for (const db of [a, b]) {
    expect(label(db, LAPTOP)).toMatchObject({
      label: 'Laptop',
      originalName: 'PC',
      labelBasis: 'shared',
      duplicateLabel: false
    })
    expect(label(db, DESK)).toMatchObject({ label: 'PC', labelBasis: 'original' })
    expect(db.select().from(sourceMachines).all()).toEqual(
      expect.arrayContaining([
        { deviceId: DESK, initialName: 'PC' },
        { deviceId: LAPTOP, initialName: 'PC' }
      ])
    )
  }
  expect(machineLabelView(a, WORKSPACE, LAPTOP)).toEqual(machineLabelView(b, WORKSPACE, LAPTOP))
})

it('keeps concurrent renames as a visible conflict until a resolution names both heads', () => {
  journalMachineRename(a, { deviceId: DESK, name: 'Desk', observedHeads: {} })
  transfer(a, b)
  const seen = label(a, DESK).labelHeads
  journalMachineRename(a, { deviceId: DESK, name: 'Office', observedHeads: seen })
  journalMachineRename(b, { deviceId: DESK, name: 'Study', observedHeads: seen })
  transfer(a, b)
  transfer(b, a)
  for (const db of [a, b]) {
    const summary = label(db, DESK)
    expect(summary.labelBasis).toBe('conflict')
    // The last agreed label stays shown; both alternatives stay listed.
    expect(summary.label).toBe('Desk')
    expect([...summary.alternatives].sort()).toEqual(['Office', 'Study'])
  }
  // A rename based on the pre-conflict heads cannot pick a winner.
  expect(() =>
    journalMachineRename(a, { deviceId: DESK, name: 'Office', observedHeads: seen })
  ).toThrow(expect.objectContaining({ code: 'MACHINE_LABEL_STALE' }))
  journalMachineRename(a, {
    deviceId: DESK,
    name: 'Office',
    observedHeads: label(a, DESK).labelHeads
  })
  transfer(a, b)
  for (const db of [a, b])
    expect(label(db, DESK)).toMatchObject({ label: 'Office', labelBasis: 'shared' })
})

it('requires the machine fact and never removes a label', () => {
  const unknown = randomUUID()
  expect(() =>
    journalMachineRename(a, { deviceId: unknown, name: 'Ghost', observedHeads: {} })
  ).toThrow(expect.objectContaining({ code: 'SOURCE_MACHINE_NOT_FOUND' }))

  // A label revision without its machine dependency is rejected at apply.
  const orphan = {
    ...planRevision({
      id: randomUUID(),
      schema: MACHINE_LABEL_SYNC_SCHEMA,
      entityId: DESK,
      history: [],
      action: { type: 'create', values: { name: 'Desk' } }
    }),
    entityType: 'machine-label' as const
  }
  expect(() => validateMachineLabelChange(orphan)).not.toThrow()
  expect(() => recordLocalSyncChanges(a, WORKSPACE, [orphan], machineLabelSyncAdapter)).toThrow(
    /depends on exactly its machine/
  )

  journalMachineRename(a, { deviceId: DESK, name: 'Desk', observedHeads: {} })
  const view = machineLabelView(a, WORKSPACE, DESK)
  const removal = planRevision({
    id: randomUUID(),
    schema: MACHINE_LABEL_SYNC_SCHEMA,
    entityId: DESK,
    history: [],
    action: { type: 'create', values: { name: 'x' } },
    dependencies: [machineFactChangeId(WORKSPACE, DESK)]
  })
  removal.payload.fields.$present = { value: false, parents: view.heads.$present }
  removal.dependencies = [...new Set([...removal.dependencies, ...view.heads.$present])].sort()
  expect(() => validateMachineLabelChange({ ...removal, entityType: 'machine-label' })).toThrow(
    /cannot be removed/
  )
})

it('does nothing when the agreed label already matches and needs a shared history to rename', () => {
  journalMachineRename(a, { deviceId: DESK, name: 'Desk', observedHeads: {} })
  const heads = label(a, DESK).labelHeads
  expect(
    planMachineRename(a, WORKSPACE, { deviceId: DESK, name: 'Desk', observedHeads: heads })
  ).toBeNull()
  const local = database()
  local.delete(folderSyncSettings).run()
  local.insert(sourceMachines).values({ deviceId: DESK, initialName: 'PC' }).run()
  expect(() =>
    journalMachineRename(local, { deviceId: DESK, name: 'Desk', observedHeads: {} })
  ).toThrow(expect.objectContaining({ code: 'SYNC_WORKSPACE_REQUIRED' }))
  expect(label(local, DESK)).toMatchObject({ label: 'PC', labelBasis: 'original' })
})
