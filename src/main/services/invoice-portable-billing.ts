import { and, eq, inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sessions } from '../db/schema/sessions'
import { manualTimeEntries } from '../db/schema/manual-time-entries'
import { sessionLegacyRecords } from '../db/schema/session-legacy'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { AppError } from '../../shared/types/ipc'
import type { InvoiceBillingRange } from '../../shared/types/invoice'
import { isSyncUuid, SyncError } from './folder-sync-protocol'
import {
  findClientByPortableId,
  getPortableClientId,
  findProjectByPortableId,
  getPortableProjectId
} from './folder-sync-builtin-client'
import { portableCoverageHash } from './folder-sync-portable-coverage'
import { portableHistoryCoverage, readPortableHistoryCoverage } from './folder-sync-history-records'
import type { CanonicalIntervalCoverage } from './canonical-intervals'
import { readCanonicalIntervalSnapshot } from './canonical-intervals'

/*
 * Portable billed-work scope (folder-sync-plan.md decision H). A frozen invoice request and a
 * synced invoice name billed work by stable identities only: canonical activity coverage, a manual
 * entry UUID or a legacy record UUID, plus the client/project syncIds and the frozen UTC bounds.
 * Local session/client/project row numbers stay in a separate local receipt (LocalInvoiceBilling)
 * that is rebuilt on each computer, so remapped IDs never change a frozen request.
 *
 * A range without a portable identity ('bucket') still excludes its time: unbilledSessions
 * subtracts ranges of the same client/project bucket regardless of the session row.
 */

type Reader = Pick<BetterSQLite3Database<Record<string, unknown>>, 'select'>

export type PortableBilledAnchor =
  | {
      kind: 'activity'
      provider: string
      conversationId: string
      coverageHash: string
      coverage: CanonicalIntervalCoverage
    }
  | { kind: 'manual'; entryId: string }
  | { kind: 'legacy'; legacyId: string }
  | { kind: 'bucket' }

export interface PortableBilledRange {
  anchor: PortableBilledAnchor
  clientSyncId: string | null
  projectSyncId: string | null
  startedAt: string
  endedAt: string
}

export interface PortableInvoiceBilling {
  periodStart: string | null
  periodEnd: string | null
  lines: Array<{
    lineDate: string | null
    durationMinutes: number | null
    billed: PortableBilledRange[] | null
  }>
}

/** This computer's compatibility view: the shape invoiceService.saveInvoice expects. */
export interface LocalInvoiceBilling {
  periodStart: string | null
  periodEnd: string | null
  lines: Array<{
    lineDate: string | null
    durationMinutes: number | null
    sessionIds: number[] | null
    billedRanges: InvoiceBillingRange[] | null
  }>
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const VOCABULARY = /^[a-z][a-z0-9-]{0,31}$/
const COVERAGE_HASH = /^[0-9a-f]{64}$/
const MAX_LINES = 250
const MAX_RANGES = 5000
const MAX_CONVERSATION_ID = 400
const MAX_MINUTES = 1_000_000

function malformed(message: string): never {
  throw new SyncError('SYNC_MALFORMED', message)
}

function unavailable(message: string): never {
  throw new AppError('BILLING_REFERENCE_UNAVAILABLE', message)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key)))
    malformed(`${label} has missing or unsupported fields`)
}

function isDay(value: unknown): value is string {
  return typeof value === 'string' && DAY.test(value) && Number.isFinite(Date.parse(value))
}

export function isPortableInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}

function normalizedInstant(value: string, label: string): string {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) unavailable(`${label} has an invalid time`)
  return new Date(time).toISOString()
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

// ── Strict reading (imports and frozen requests) ──

function readAnchor(value: unknown, label: string): PortableBilledAnchor {
  if (!isObject(value) || typeof value.kind !== 'string') malformed(`${label} needs an anchor`)
  switch (value.kind) {
    case 'activity':
      exactKeys(value, ['kind', 'provider', 'conversationId', 'coverageHash', 'coverage'], label)
      if (
        typeof value.provider !== 'string' ||
        !VOCABULARY.test(value.provider) ||
        typeof value.conversationId !== 'string' ||
        !value.conversationId ||
        value.conversationId.length > MAX_CONVERSATION_ID ||
        !value.conversationId.isWellFormed() ||
        hasControlCharacter(value.conversationId) ||
        typeof value.coverageHash !== 'string' ||
        !COVERAGE_HASH.test(value.coverageHash)
      )
        malformed(`${label} has an invalid activity anchor`)
      if (
        portableCoverageHash(
          value.provider,
          value.conversationId,
          readPortableHistoryCoverage(value.coverage, value.provider)
        ) !== value.coverageHash
      )
        malformed(`${label} has inconsistent activity coverage`)
      break
    case 'manual':
      exactKeys(value, ['kind', 'entryId'], label)
      if (!isSyncUuid(value.entryId)) malformed(`${label} needs a manual entry UUID`)
      break
    case 'legacy':
      exactKeys(value, ['kind', 'legacyId'], label)
      if (!isSyncUuid(value.legacyId)) malformed(`${label} needs a legacy record UUID`)
      break
    case 'bucket':
      exactKeys(value, ['kind'], label)
      break
    default:
      malformed(`${label} has an unsupported anchor`)
  }
  return value as unknown as PortableBilledAnchor
}

export function readPortableBilledRange(
  value: unknown,
  label = 'Billed range'
): PortableBilledRange {
  if (!isObject(value)) malformed(`${label} must be an object`)
  exactKeys(value, ['anchor', 'clientSyncId', 'projectSyncId', 'startedAt', 'endedAt'], label)
  readAnchor(value.anchor, label)
  for (const key of ['clientSyncId', 'projectSyncId'] as const)
    if (value[key] !== null && !isSyncUuid(value[key])) malformed(`${label} has an invalid ${key}`)
  if (!isPortableInstant(value.startedAt) || !isPortableInstant(value.endedAt))
    malformed(`${label} needs normalized UTC bounds`)
  if ((value.endedAt as string) < (value.startedAt as string))
    malformed(`${label} ends before it starts`)
  return value as unknown as PortableBilledRange
}

export function readPortableBilledRanges(value: unknown, label: string): PortableBilledRange[] {
  if (!Array.isArray(value) || value.length > MAX_RANGES)
    malformed(`${label} must list at most ${MAX_RANGES} ranges`)
  return value.map((range, index) => readPortableBilledRange(range, `${label}[${index}]`))
}

export function readPortableInvoiceBilling(value: unknown): PortableInvoiceBilling {
  if (!isObject(value)) malformed('Invoice billing must be an object')
  exactKeys(value, ['periodStart', 'periodEnd', 'lines'], 'Invoice billing')
  for (const key of ['periodStart', 'periodEnd'] as const)
    if (value[key] !== null && !isDay(value[key])) malformed(`Invoice billing ${key} must be a day`)
  if (!Array.isArray(value.lines) || value.lines.length > MAX_LINES)
    malformed('Invoice billing lines are invalid')
  value.lines.forEach((line, index) => {
    const label = `Invoice billing line ${index + 1}`
    if (!isObject(line)) malformed(`${label} must be an object`)
    exactKeys(line, ['lineDate', 'durationMinutes', 'billed'], label)
    if (line.lineDate !== null && !isDay(line.lineDate)) malformed(`${label} has an invalid date`)
    if (
      line.durationMinutes !== null &&
      (typeof line.durationMinutes !== 'number' ||
        !Number.isFinite(line.durationMinutes) ||
        line.durationMinutes < 0 ||
        line.durationMinutes > MAX_MINUTES)
    )
      malformed(`${label} has an invalid duration`)
    if (line.billed !== null) readPortableBilledRanges(line.billed, label)
  })
  return value as unknown as PortableInvoiceBilling
}

// ── Anchors ──

/** The portable identity of a local session row, or 'bucket' when it has none. */
export function portableAnchorOfSession(db: Reader, sessionId: number): PortableBilledAnchor {
  const manual = db
    .select({ id: manualTimeEntries.id })
    .from(manualTimeEntries)
    .where(eq(manualTimeEntries.sessionId, sessionId))
    .get()
  if (manual) return { kind: 'manual', entryId: manual.id }
  const legacy = db
    .select({ id: sessionLegacyRecords.id })
    .from(sessionLegacyRecords)
    .where(eq(sessionLegacyRecords.sessionId, sessionId))
    .get()
  if (legacy) return { kind: 'legacy', legacyId: legacy.id }
  const mapping = db
    .select()
    .from(sessionActivityMappings)
    .where(eq(sessionActivityMappings.sessionId, sessionId))
    .get()
  const interval = mapping && readCanonicalIntervalSnapshot(mapping.intervalJson, mapping.provider)
  if (mapping && interval)
    return {
      kind: 'activity',
      provider: mapping.provider,
      conversationId: mapping.conversationId,
      coverageHash: portableCoverageHash(
        mapping.provider,
        mapping.conversationId,
        interval.coverage
      ),
      coverage: portableHistoryCoverage(interval.coverage, mapping.provider)
    }
  return { kind: 'bucket' }
}

/** The local session row a portable anchor names on this computer, if it exists yet. */
export function localSessionOfAnchor(db: Reader, anchor: PortableBilledAnchor): number | null {
  switch (anchor.kind) {
    case 'manual':
      return (
        db
          .select({ sessionId: manualTimeEntries.sessionId })
          .from(manualTimeEntries)
          .where(eq(manualTimeEntries.id, anchor.entryId))
          .get()?.sessionId ?? null
      )
    case 'legacy':
      return (
        db
          .select({ sessionId: sessionLegacyRecords.sessionId })
          .from(sessionLegacyRecords)
          .where(eq(sessionLegacyRecords.id, anchor.legacyId))
          .get()?.sessionId ?? null
      )
    case 'activity': {
      const rows = db
        .select()
        .from(sessionActivityMappings)
        .where(
          and(
            eq(sessionActivityMappings.provider, anchor.provider),
            eq(sessionActivityMappings.conversationId, anchor.conversationId)
          )
        )
        .all()
      for (const row of rows) {
        const interval = readCanonicalIntervalSnapshot(row.intervalJson, row.provider)
        if (
          interval &&
          portableCoverageHash(row.provider, row.conversationId, interval.coverage) ===
            anchor.coverageHash
        )
          return row.sessionId
      }
      return null
    }
    default:
      return null
  }
}

function portableProjectId(db: Reader, projectId: number): string | null {
  return getPortableProjectId(db, projectId)
}

export function localClientOfPortable(db: Reader, clientSyncId: string | null): number | null {
  return clientSyncId === null ? null : (findClientByPortableId(db, clientSyncId)?.id ?? null)
}

export function localProjectOfPortable(db: Reader, projectSyncId: string | null): number | null {
  return projectSyncId === null ? null : (findProjectByPortableId(db, projectSyncId)?.id ?? null)
}

/** A frozen local range as a portable range. Unknown rows fail loudly; the preview is stale. */
export function portableBilledRange(db: Reader, range: InvoiceBillingRange): PortableBilledRange {
  if (!Number.isSafeInteger(range.sessionId) || range.sessionId <= 0)
    unavailable('A billed range names an invalid session.')
  const session = db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, range.sessionId))
    .get()
  if (!session) unavailable('A billed session is no longer available. Refresh the invoice preview.')
  const clientSyncId = range.clientId === null ? null : getPortableClientId(db, range.clientId)
  if (range.clientId !== null && !clientSyncId)
    unavailable('A billed client is no longer available. Refresh the invoice preview.')
  const projectSyncId = range.projectId === null ? null : portableProjectId(db, range.projectId)
  if (range.projectId !== null && !projectSyncId)
    unavailable('A billed project is no longer available. Refresh the invoice preview.')
  const startedAt = normalizedInstant(range.startedAt, 'A billed range')
  const endedAt = normalizedInstant(range.endedAt, 'A billed range')
  if (endedAt < startedAt) unavailable('A billed range ends before it starts.')
  return {
    anchor: portableAnchorOfSession(db, range.sessionId),
    clientSyncId,
    projectSyncId,
    startedAt,
    endedAt
  }
}

/** Freeze this computer's receipt as portable billing. Sessions without ranges bill whole rows. */
export function portableBillingFromLocal(
  db: Reader,
  local: LocalInvoiceBilling
): PortableInvoiceBilling {
  const ids = [...new Set(local.lines.flatMap((line) => line.sessionIds ?? []))]
  const rows = new Map(
    (ids.length ? db.select().from(sessions).where(inArray(sessions.id, ids)).all() : []).map(
      (row) => [row.id, row]
    )
  )
  const billing: PortableInvoiceBilling = {
    periodStart: local.periodStart,
    periodEnd: local.periodEnd,
    lines: local.lines.map((line) => {
      let ranges = line.billedRanges
      if (!ranges && line.sessionIds?.length)
        ranges = line.sessionIds.map((id) => {
          const row = rows.get(id)
          if (!row)
            unavailable('A billed session is no longer available. Refresh the invoice preview.')
          return {
            sessionId: row.id,
            projectId: row.projectId,
            clientId: row.clientId,
            startedAt: row.startedAt,
            endedAt: row.endedAt
          }
        })
      return {
        lineDate: line.lineDate,
        durationMinutes: line.durationMinutes,
        billed: ranges ? ranges.map((range) => portableBilledRange(db, range)) : null
      }
    })
  }
  try {
    return readPortableInvoiceBilling(billing)
  } catch (error) {
    if (error instanceof SyncError)
      throw new AppError(
        'INVALID_INVOICE_BILLING',
        error.message.replace(/^Invoice billing/, 'Billing')
      )
    throw error
  }
}

/** One portable range on this computer; unresolved rows keep 0/null and exclude by bucket. */
export function localBilledRange(db: Reader, range: PortableBilledRange): InvoiceBillingRange {
  return {
    sessionId: localSessionOfAnchor(db, range.anchor) ?? 0,
    clientId: localClientOfPortable(db, range.clientSyncId),
    projectId: localProjectOfPortable(db, range.projectSyncId),
    startedAt: range.startedAt,
    endedAt: range.endedAt
  }
}

/**
 * Portable billing back to a compatible local receipt for invoiceService.saveInvoice. Only rows
 * that exist here are listed as sessionIds; the frozen request itself is never rewritten.
 */
export function resolvePortableBilling(
  db: Reader,
  billing: PortableInvoiceBilling
): LocalInvoiceBilling {
  return {
    periodStart: billing.periodStart,
    periodEnd: billing.periodEnd,
    lines: billing.lines.map((line) => {
      if (!line.billed)
        return {
          lineDate: line.lineDate,
          durationMinutes: line.durationMinutes,
          sessionIds: null,
          billedRanges: null
        }
      const billedRanges = line.billed.flatMap((range) => localBilledRanges(db, range))
      const sessionIds = [...new Set(billedRanges.map((range) => range.sessionId))].filter(
        (id) => id > 0
      )
      return {
        lineDate: line.lineDate,
        durationMinutes: line.durationMinutes,
        sessionIds: sessionIds.length ? sessionIds : null,
        billedRanges: billedRanges.filter((range) => range.sessionId > 0)
      }
    })
  }
}

/**
 * The receipt to save, computed inside the saving transaction: the frozen portable billing
 * resolved on this computer now (rows may have been split or remapped while Stripe ran), united
 * with this computer's original receipt for rows that still exist. The receipt keeps anchor-less
 * ('bucket') ranges, which resolvePortableBilling cannot attach to a row.
 */
export function localBillingForSave(
  db: Reader,
  billing: PortableInvoiceBilling,
  receipt: LocalInvoiceBilling | null
): LocalInvoiceBilling {
  const resolved = resolvePortableBilling(db, billing)
  if (!receipt) return resolved
  const ids = [...new Set(receipt.lines.flatMap((line) => line.sessionIds ?? []))]
  const rows = new Map(
    (ids.length ? db.select().from(sessions).where(inArray(sessions.id, ids)).all() : []).map(
      (row) => [row.id, row]
    )
  )
  return {
    ...resolved,
    lines: resolved.lines.map((line, index) => {
      const local = receipt.lines[index]
      if (!local?.sessionIds?.length) return line
      const present = local.sessionIds.filter((id) => rows.has(id))
      const localRanges = present.flatMap((id): InvoiceBillingRange[] => {
        const row = rows.get(id)!
        return local.billedRanges
          ? local.billedRanges.filter((range) => range.sessionId === id)
          : [
              {
                sessionId: id,
                projectId: row.projectId,
                clientId: row.clientId,
                startedAt: row.startedAt,
                endedAt: row.endedAt
              }
            ]
      })
      const ranges = new Map<string, InvoiceBillingRange>()
      for (const range of [...localRanges, ...(line.billedRanges ?? [])])
        ranges.set(JSON.stringify([range.sessionId, range.startedAt, range.endedAt]), range)
      const sessionIds = [...new Set([...present, ...(line.sessionIds ?? [])])]
      return {
        ...line,
        sessionIds: sessionIds.length ? sessionIds : null,
        billedRanges: ranges.size ? [...ranges.values()] : line.billedRanges
      }
    })
  }
}

/** An old billed fragment can overlap several new local fragments after a split or recalculation. */
export function localBilledRanges(db: Reader, range: PortableBilledRange): InvoiceBillingRange[] {
  const base = localBilledRange(db, range)
  if (range.anchor.kind !== 'activity') return [base]
  const anchor = range.anchor
  const eventIds = new Set([
    ...anchor.coverage.messages.map((event) => event.eventId),
    ...anchor.coverage.continuity.flatMap((edge) => edge.progress.map((event) => event.eventId))
  ])
  const related = db
    .select()
    .from(sessionActivityMappings)
    .where(
      and(
        eq(sessionActivityMappings.provider, anchor.provider),
        eq(sessionActivityMappings.conversationId, anchor.conversationId)
      )
    )
    .all()
    .filter((mapping) => {
      const current = readCanonicalIntervalSnapshot(mapping.intervalJson, mapping.provider)
      if (!current) return false
      return (
        current.coverage.messages.some((event) => eventIds.has(event.eventId)) ||
        current.coverage.continuity.some(
          (edge) =>
            edge.progress.some((event) => eventIds.has(event.eventId)) ||
            anchor.coverage.continuity.some(
              (old) =>
                old.from.eventId === edge.from.eventId &&
                old.to.eventId === edge.to.eventId &&
                Date.parse(old.startedAt) < Date.parse(edge.endedAt) &&
                Date.parse(edge.startedAt) < Date.parse(old.endedAt)
            )
        )
      )
    })
  return related.length
    ? related.map((mapping) => ({ ...base, sessionId: mapping.sessionId }))
    : [base]
}
