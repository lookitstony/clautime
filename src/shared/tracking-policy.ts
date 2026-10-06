import { TZDateMini } from '@date-fns/tz'
import { AppError } from './types/ipc'

/**
 * How captured facts are normalized before detection. 1: the parsers' historical projection
 * (every mapping, coverage and portable fact recorded before version 2 used it). 2: Codex usage
 * checkpointed after a new prompt belongs to that prompt's reply. Event IDs are identical under
 * both; a workspace changes version only through a reviewed policy change.
 */
export type NormalizationVersion = 1 | 2
export const NORMALIZATION_VERSIONS: readonly NormalizationVersion[] = [1, 2]
/** New workspaces only. Existing workspaces keep their recorded version. */
export const INITIAL_NORMALIZATION_VERSION: NormalizationVersion = 2

export interface TrackingPolicy {
  readonly version: 1
  readonly normalizationVersion: NormalizationVersion
  readonly detectorVersion: 1
  readonly idleTimeoutMinutes: number
  readonly reportingTimeZone: string
}

/** Explicit shared inputs only: never infer a receiving computer's timezone or defaults. */
export function readTrackingPolicy(value: unknown): Readonly<TrackingPolicy> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_TRACKING_POLICY', 'A tracking policy is required')
  }
  const policy = value as Record<string, unknown>
  const keys = [
    'version',
    'normalizationVersion',
    'detectorVersion',
    'idleTimeoutMinutes',
    'reportingTimeZone'
  ]
  if (
    policy.version !== 1 ||
    !NORMALIZATION_VERSIONS.includes(policy.normalizationVersion as NormalizationVersion) ||
    policy.detectorVersion !== 1 ||
    Object.keys(policy).some((key) => !keys.includes(key))
  ) {
    throw new AppError(
      'UNSUPPORTED_TRACKING_POLICY',
      'Tracking policy requires compatible software'
    )
  }
  if (
    typeof policy.idleTimeoutMinutes !== 'number' ||
    !Number.isFinite(policy.idleTimeoutMinutes) ||
    policy.idleTimeoutMinutes <= 0 ||
    typeof policy.reportingTimeZone !== 'string' ||
    !policy.reportingTimeZone.trim() ||
    policy.reportingTimeZone !== policy.reportingTimeZone.trim()
  ) {
    throw new AppError(
      'INVALID_TRACKING_POLICY',
      'An idle timeout and explicit reporting timezone are required'
    )
  }
  try {
    // An explicit zone is mandatory; Intl otherwise silently selects the host default.
    new Intl.DateTimeFormat('en-US', { timeZone: policy.reportingTimeZone }).format(0)
  } catch {
    throw new AppError('INVALID_TRACKING_POLICY', 'Reporting timezone is not supported')
  }
  return Object.freeze({
    version: 1,
    normalizationVersion: policy.normalizationVersion as NormalizationVersion,
    detectorVersion: 1,
    idleTimeoutMinutes: policy.idleTimeoutMinutes,
    reportingTimeZone: policy.reportingTimeZone
  })
}

/** Zone-less timestamps would reintroduce host-local interpretation even with a shared policy. */
export function requireExplicitTimestamp(timestamp: string): void {
  if (
    typeof timestamp !== 'string' ||
    !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    throw new AppError(
      'INVALID_ACTIVITY_TIMESTAMP',
      'Activity timestamps must include an explicit UTC offset'
    )
  }
}

/** Calendar key for future shared-history grouping; independent of the computer timezone. */
export function reportingDateKey(timestamp: string, value: unknown): string {
  const policy = readTrackingPolicy(value)
  requireExplicitTimestamp(timestamp)
  const date = new TZDateMini(timestamp, policy.reportingTimeZone)
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
