import { eq } from 'drizzle-orm'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { appSettings } from '../db/schema/app-settings'
import { AppError } from '../../shared/types/ipc'
import { getWorkspacePolicy } from './workspace-policy'

export const settingsService = {
  getSetting(key: string): string | null {
    log.debug(`settings-service: getSetting(${key})`)
    const db = getDb()
    if (key === 'idle_timeout_minutes') {
      const workspace = getWorkspacePolicy(db)
      if (workspace) return String(workspace.policy.idleTimeoutMinutes)
    }
    const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get()
    return row?.value ?? null
  },

  setSetting(key: string, value: string): void {
    log.debug(`settings-service: setSetting(${key})`)
    const db = getDb()
    if (key === 'idle_timeout_minutes' && getWorkspacePolicy(db))
      throw new AppError(
        'WORKSPACE_POLICY_REVIEW_REQUIRED',
        'Review the shared tracking policy before changing the idle timeout'
      )
    db.insert(appSettings)
      .values({ key, value, updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updatedAt: new Date().toISOString() }
      })
      .run()
  },

  getAllSettings(): Record<string, string> {
    log.debug('settings-service: getAllSettings()')
    const db = getDb()
    const rows = db.select().from(appSettings).all()
    const result: Record<string, string> = {}
    for (const row of rows) {
      result[row.key] = row.value
    }
    const workspace = getWorkspacePolicy(db)
    if (workspace) result.idle_timeout_minutes = String(workspace.policy.idleTimeoutMinutes)
    return result
  },

  deleteSetting(key: string): void {
    log.debug(`settings-service: deleteSetting(${key})`)
    const db = getDb()
    const deleted = db.delete(appSettings).where(eq(appSettings.key, key)).run()
    if (deleted.changes === 0) {
      throw new AppError('SETTING_NOT_FOUND', `Setting '${key}' not found`)
    }
  }
}
