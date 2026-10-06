import { eq, inArray, sql } from 'drizzle-orm'
import type { getDb } from '../db'
import { activityObservations, activitySources } from '../db/schema/activity-evidence'
import { activityObservers, sourceMachines } from '../db/schema/activity-observers'
import { syncChanges } from '../db/schema/folder-sync'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { sessionDerivations } from '../db/schema/session-derivations'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import type { Session as SessionRow } from '../db/schema/sessions'
import type {
  SessionSourceMachine,
  SourceMachineBasis,
  SourceMachineSummary
} from '../../shared/types/source-machine'
import { isSyncUuid } from './folder-sync-protocol'
import { historySyncWorkspace } from './folder-sync-history-records'
import { readMachineLabelViews } from './folder-sync-machine-records'
import { canonicalCoverageReferences, readCanonicalIntervalSnapshot } from './canonical-intervals'

/*
 * Read-only Source Machine provenance for the Sessions view (plan decisions B and H).
 * Provenance names the devices that observed or imported a session's facts; it never decides
 * ownership, and a fact observed by two devices lists both while the session counts once.
 * Evidence, by session kind, never guessing an origin:
 * - mapped automatic: observers of the canonical coverage's message, progress and usage
 *   observations;
 * - unmapped local automatic: observers of this file's local observations inside the
 *   session's detector interval (never the whole file);
 * - manual: the entry's own device (created = observed), plus shared history-observer facts;
 * - legacy: shared history-observer facts only; otherwise its origin stays pending (empty).
 * Output carries device IDs and labels only: no paths, transcript text or local row IDs.
 */

type Reader = Pick<ReturnType<typeof getDb>, 'select'>
type ProvenanceRow = Pick<
  SessionRow,
  'id' | 'source' | 'sourceFile' | 'startedAt' | 'endedAt' | 'tool'
>
type Observer = { deviceId: string; basis: SourceMachineBasis }

const CHUNK = 500
const HISTORY_OBSERVER_KEYS = ['basis', 'deviceId', 'recordId', 'recordType']

function chunked<T, R>(values: readonly T[], read: (part: T[]) => R[]): R[] {
  const result: R[] = []
  for (let index = 0; index < values.length; index += CHUNK)
    result.push(...read(values.slice(index, index + CHUNK)))
  return result
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Shared labels override the immutable registration name; conflicts stay visible. */
export function listSourceMachines(
  db: Reader,
  localDeviceId: string | null = null
): SourceMachineSummary[] {
  const machines = db.select().from(sourceMachines).all()
  const workspaceId = historySyncWorkspace(db)
  const views: ReturnType<typeof readMachineLabelViews> = workspaceId
    ? readMachineLabelViews(db, workspaceId)
    : new Map()
  const summaries = machines.map((machine): SourceMachineSummary => {
    const base = {
      deviceId: machine.deviceId,
      originalName: machine.initialName,
      duplicateLabel: false,
      isThisComputer: machine.deviceId === localDeviceId
    }
    const view = views.get(machine.deviceId)
    if (!view || ('lifecycle' in view && view.lifecycle === 'missing'))
      return {
        ...base,
        label: machine.initialName,
        labelBasis: 'original',
        alternatives: [],
        labelHeads: {}
      }
    if (!('lifecycle' in view))
      return {
        ...base,
        label: machine.initialName,
        labelBasis: 'conflict',
        alternatives: [],
        labelHeads: {}
      }
    const name = view.fields.name
    if (name.status === 'conflict')
      return {
        ...base,
        label: typeof name.value === 'string' ? name.value : machine.initialName,
        labelBasis: 'conflict',
        alternatives: [...new Set(name.heads.map((head) => String(head.value)))],
        labelHeads: view.heads
      }
    return {
      ...base,
      label: typeof name.value === 'string' ? name.value : machine.initialName,
      labelBasis: typeof name.value === 'string' ? 'shared' : 'original',
      alternatives: [],
      labelHeads: view.heads
    }
  })
  const counts = new Map<string, number>()
  for (const summary of summaries) {
    const key = summary.label.toLocaleLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const summary of summaries)
    summary.duplicateLabel = (counts.get(summary.label.toLocaleLowerCase()) ?? 0) > 1
  return summaries.sort((a, b) =>
    a.label !== b.label
      ? a.label.localeCompare(b.label)
      : a.deviceId < b.deviceId
        ? -1
        : a.deviceId > b.deviceId
          ? 1
          : 0
  )
}

/**
 * Applied legacy/manual provenance facts ({recordType, recordId, deviceId, basis}, exactly),
 * keyed by `${recordType}:${recordId}`. A malformed stored row is ignored here: it cannot
 * name a machine, and the journal's own validation reports it.
 */
function readHistoryObservers(db: Reader): Map<string, Observer[]> {
  const result = new Map<string, Observer[]>()
  const rows = db
    .select({ json: syncChanges.changeJson })
    .from(syncChanges)
    .where(eq(syncChanges.entityType, 'history-observer'))
    .all()
  for (const row of rows) {
    let change: unknown
    try {
      change = JSON.parse(row.json)
    } catch {
      continue
    }
    if (!isObject(change) || change.kind !== 'fact' || !isObject(change.payload)) continue
    const payload = change.payload
    if (Object.keys(payload).sort().join() !== HISTORY_OBSERVER_KEYS.join()) continue
    const { recordType, recordId, deviceId, basis } = payload
    if (
      (recordType !== 'legacy-session' && recordType !== 'manual-entry') ||
      !isSyncUuid(recordId) ||
      !isSyncUuid(deviceId) ||
      (basis !== 'observed' && basis !== 'imported')
    )
      continue
    const key = `${recordType}:${recordId}`
    const list = result.get(key)
    if (list) list.push({ deviceId, basis })
    else result.set(key, [{ deviceId, basis }])
  }
  return result
}

/** Every observation a canonical snapshot counts or measures with, usage included. */
function coverageObservationIds(json: string, provider: string): string[] | null {
  const interval = readCanonicalIntervalSnapshot(json, provider)
  if (!interval) return null
  const ids = new Set<string>()
  for (const ref of canonicalCoverageReferences(interval.coverage))
    for (const id of ref.observationIds ?? [ref.observationId]) ids.add(id)
  for (const usage of interval.coverage.usage ?? []) ids.add(usage.observationId)
  return [...ids]
}

/** Local observations of one source file with their fact time; paths never leave this module. */
function fileObservations(db: Reader, sourceFile: string) {
  const payload = activityObservations.payloadJson
  return db
    .select({
      observationId: activitySources.observationId,
      timestamp: sql<string | null>`coalesce(
        nullif(json_extract(${payload}, '$.timestamp'), ''),
        json_extract(${payload}, '$.timing.completedAt'),
        json_extract(${payload}, '$.timing.startedAt'),
        json_extract(${payload}, '$.timing.endedAt'))`
    })
    .from(activitySources)
    .innerJoin(activityObservations, eq(activityObservations.id, activitySources.observationId))
    .where(eq(activitySources.sourceFile, sourceFile))
    .all()
    .flatMap((row) => {
      const at = row.timestamp ? Date.parse(row.timestamp) : NaN
      return Number.isFinite(at) ? [{ observationId: row.observationId, at }] : []
    })
}

function addObserver(target: Map<number, Observer[]>, sessionId: number, observer: Observer) {
  const list = target.get(sessionId)
  if (!list) target.set(sessionId, [observer])
  else if (!list.some((o) => o.deviceId === observer.deviceId && o.basis === observer.basis))
    list.push(observer)
}

/** Device/basis evidence per session ID; sessions without evidence are absent (pending). */
export function readSessionObservers(
  db: Reader,
  rows: readonly ProvenanceRow[]
): Map<number, Observer[]> {
  const result = new Map<number, Observer[]>()
  if (!rows.length) return result
  const ids = rows.map((row) => row.id)
  const mappings = new Map(
    chunked(ids, (part) =>
      db
        .select({
          sessionId: sessionActivityMappings.sessionId,
          provider: sessionActivityMappings.provider,
          intervalJson: sessionActivityMappings.intervalJson
        })
        .from(sessionActivityMappings)
        .where(inArray(sessionActivityMappings.sessionId, part))
        .all()
    ).map((row) => [row.sessionId, row])
  )
  const manual = new Map(
    chunked(ids, (part) =>
      db
        .select({
          sessionId: manualTimeEntries.sessionId,
          id: manualTimeEntries.id,
          deviceId: manualTimeEntries.deviceId,
          basis: manualTimeEntries.basis
        })
        .from(manualTimeEntries)
        .where(inArray(manualTimeEntries.sessionId, part))
        .all()
    ).map((row) => [row.sessionId, row])
  )
  const legacy = new Map(
    chunked(ids, (part) =>
      db
        .select({ sessionId: sessionLegacyRecords.sessionId, id: sessionLegacyRecords.id })
        .from(sessionLegacyRecords)
        .where(inArray(sessionLegacyRecords.sessionId, part))
        .all()
    ).map((row) => [row.sessionId, row.id])
  )
  const baselines = new Map(
    chunked(ids, (part) =>
      db
        .select({
          sessionId: sessionDerivations.sessionId,
          startedAt: sessionDerivations.startedAt,
          endedAt: sessionDerivations.endedAt
        })
        .from(sessionDerivations)
        .where(inArray(sessionDerivations.sessionId, part))
        .all()
    ).map((row) => [row.sessionId, row])
  )
  const facts =
    manual.size || legacy.size ? readHistoryObservers(db) : new Map<string, Observer[]>()

  // Session -> observation IDs whose observers are its provenance.
  const observations = new Map<number, Set<string>>()
  const byFile = new Map<string, ProvenanceRow[]>()
  for (const row of rows) {
    const entry = manual.get(row.id)
    if (entry) {
      if (entry.deviceId)
        addObserver(result, row.id, {
          deviceId: entry.deviceId,
          basis: entry.basis === 'created' ? 'observed' : 'imported'
        })
      for (const fact of facts.get(`manual-entry:${entry.id}`) ?? [])
        addObserver(result, row.id, fact)
      continue
    }
    const legacyId = legacy.get(row.id)
    if (legacyId) {
      for (const fact of facts.get(`legacy-session:${legacyId}`) ?? [])
        addObserver(result, row.id, fact)
      continue
    }
    const mapping = mappings.get(row.id)
    if (mapping) {
      const found = coverageObservationIds(mapping.intervalJson, mapping.provider)
      if (found) observations.set(row.id, new Set(found))
      continue
    }
    if (row.source === 'auto' && row.sourceFile) {
      const list = byFile.get(row.sourceFile)
      if (list) list.push(row)
      else byFile.set(row.sourceFile, [row])
    }
  }
  for (const [sourceFile, fileRows] of byFile) {
    const local = fileObservations(db, sourceFile)
    for (const row of fileRows) {
      const baseline = baselines.get(row.id) ?? row
      const start = Date.parse(baseline.startedAt)
      const end = Date.parse(baseline.endedAt)
      const inside = local.filter((item) => item.at >= start && item.at <= end)
      if (inside.length) observations.set(row.id, new Set(inside.map((item) => item.observationId)))
    }
  }

  const wanted = [...new Set([...observations.values()].flatMap((set) => [...set]))]
  const observers = new Map<string, Observer[]>()
  for (const row of chunked(wanted, (part) =>
    db.select().from(activityObservers).where(inArray(activityObservers.observationId, part)).all()
  )) {
    const list = observers.get(row.observationId)
    const observer = { deviceId: row.deviceId, basis: row.basis }
    if (list) list.push(observer)
    else observers.set(row.observationId, [observer])
  }
  for (const [sessionId, set] of observations)
    for (const id of set)
      for (const observer of observers.get(id) ?? []) addObserver(result, sessionId, observer)
  return result
}

function labelFor(labels: ReadonlyMap<string, string>, deviceId: string): string {
  return labels.get(deviceId) ?? `Unknown machine ${deviceId.slice(0, 8)}`
}

/** Labelled provenance per session ID; every requested session gets a list (empty = pending). */
export function readSessionSourceMachines(
  db: Reader,
  rows: readonly ProvenanceRow[],
  machines: readonly SourceMachineSummary[] = listSourceMachines(db)
): Map<number, SessionSourceMachine[]> {
  const labels = new Map(machines.map((machine) => [machine.deviceId, machine.label]))
  const observers = readSessionObservers(db, rows)
  const result = new Map<number, SessionSourceMachine[]>()
  for (const row of rows) {
    const list = (observers.get(row.id) ?? [])
      .map((observer) => ({ ...observer, label: labelFor(labels, observer.deviceId) }))
      .sort((a, b) =>
        a.basis !== b.basis
          ? a.basis === 'observed'
            ? -1
            : 1
          : a.label !== b.label
            ? a.label.localeCompare(b.label)
            : a.deviceId < b.deviceId
              ? -1
              : 1
      )
    result.set(row.id, list)
  }
  return result
}

/** Session DTO read path: attach provenance without changing any other field. */
export function withSourceMachines<T extends ProvenanceRow>(
  db: Reader,
  rows: readonly T[]
): Array<T & { sourceMachines: SessionSourceMachine[] }> {
  const provenance = readSessionSourceMachines(db, rows)
  return rows.map((row) => ({ ...row, sourceMachines: provenance.get(row.id) ?? [] }))
}

/**
 * Sessions-view machine filter, applied server-side before any total is computed. A session
 * matches when the device observed or imported any of its facts, so a copied session matches
 * each of its machines while still being one session. Never used by invoice selection.
 */
export function filterSessionsBySourceMachine<T extends ProvenanceRow>(
  db: Reader,
  rows: readonly T[],
  deviceId: string
): T[] {
  const observers = readSessionObservers(db, rows)
  return rows.filter((row) =>
    (observers.get(row.id) ?? []).some((observer) => observer.deviceId === deviceId)
  )
}
