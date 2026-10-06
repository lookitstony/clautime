import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { workspacePolicy } from '../db/schema/workspace-policy'
import { getWorkspacePolicy } from './workspace-policy'
import { calendarDate, calendarDateKey } from '../../shared/reporting-calendar'

type Db = ReturnType<typeof getDb>

// Reports and breakdowns ask once per row. Reuse one prepared read per database and parse and
// validate the saved policy again only when its row changes.
const policyReads = new WeakMap<Db, ReturnType<typeof preparePolicyRead>>()
let lastPolicy: { key: string; zone: string | undefined } | undefined

function preparePolicyRead(db: Db) {
  return db
    .select({
      workspaceId: workspacePolicy.workspaceId,
      revisionId: workspacePolicy.revisionId,
      policyJson: workspacePolicy.policyJson
    })
    .from(workspacePolicy)
    .where(eq(workspacePolicy.slot, 1))
    .prepare()
}

export function currentReportingTimeZone(): string | undefined {
  const db = getDb()
  let read = policyReads.get(db)
  if (!read) {
    read = preparePolicyRead(db)
    policyReads.set(db, read)
  }
  const row = read.get()
  if (!row) return undefined
  const key = `${row.workspaceId}\n${row.revisionId}\n${row.policyJson}`
  if (lastPolicy?.key !== key) {
    lastPolicy = { key, zone: getWorkspacePolicy(db)?.policy.reportingTimeZone }
  }
  return lastPolicy.zone
}

export function currentReportingDate(value: string | number | Date): Date {
  return calendarDate(value, currentReportingTimeZone())
}

export function currentReportingDateKey(value: string | number | Date): string {
  return calendarDateKey(value, currentReportingTimeZone())
}
