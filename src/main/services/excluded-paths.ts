import log from 'electron-log/main.js'
import { settingsService } from './settings-service'
import { setCustomExcludedPaths } from '../../shared/paths'

/** Setting key holding the user's excluded folders as a JSON string array. */
export const EXCLUDED_PATHS_KEY = 'excluded_paths'

/** Parse the persisted excluded-folder list (empty on missing/malformed). */
export function readExcludedPathsSetting(): string[] {
  const raw = settingsService.getSetting(EXCLUDED_PATHS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    log.warn(`Malformed ${EXCLUDED_PATHS_KEY} setting — ignoring`)
    return []
  }
}

/**
 * Apply the persisted excluded folders to the shared path predicates. Called at
 * startup and whenever the setting changes; existing sessions under a newly
 * excluded folder are purged by the next scan (purgeExcludedSessions).
 */
export function applyExcludedPaths(): void {
  setCustomExcludedPaths(readExcludedPathsSetting())
}
