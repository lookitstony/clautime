import { getDb } from '../db'
import { getWorkspacePolicy } from './workspace-policy'
import { calendarDate, calendarDateKey } from '../../shared/reporting-calendar'

export function currentReportingTimeZone(): string | undefined {
  return getWorkspacePolicy(getDb())?.policy.reportingTimeZone
}

export function currentReportingDate(value: string | number | Date): Date {
  return calendarDate(value, currentReportingTimeZone())
}

export function currentReportingDateKey(value: string | number | Date): string {
  return calendarDateKey(value, currentReportingTimeZone())
}
