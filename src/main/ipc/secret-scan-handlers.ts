import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import { secretScanService } from '../services/secret-scan-service'
import { ipcSuccess, ipcError, type IpcResult } from '../../shared/types/ipc'
import type {
  SecretScanResult,
  SecretFinding,
  SecretScanSummary,
  CustomSecretPattern,
  PatternTestResult
} from '../../shared/types/secret-scan'

export function registerSecretScanHandlers(): void {
  ipcMain.handle('secretScan:run', async (): Promise<IpcResult<SecretScanResult>> => {
    try {
      const result = await secretScanService.runScan()
      return ipcSuccess(result)
    } catch (error) {
      log.error('IPC secretScan:run failed:', error)
      return ipcError('SECRET_SCAN_RUN_ERROR', String(error))
    }
  })

  ipcMain.handle('secretScan:cancel', async (): Promise<IpcResult<void>> => {
    try {
      secretScanService.cancel()
      return ipcSuccess(undefined)
    } catch (error) {
      log.error('IPC secretScan:cancel failed:', error)
      return ipcError('SECRET_SCAN_CANCEL_ERROR', String(error))
    }
  })

  ipcMain.handle(
    'secretScan:getFindings',
    async (_event, limit?: number, offset?: number): Promise<IpcResult<SecretFinding[]>> => {
      try {
        const safeLimit = typeof limit === 'number' ? limit : undefined
        const safeOffset = typeof offset === 'number' ? offset : undefined
        const result = secretScanService.getFindings(safeLimit, safeOffset)
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC secretScan:getFindings failed:', error)
        return ipcError('SECRET_SCAN_GET_FINDINGS_ERROR', String(error))
      }
    }
  )

  ipcMain.handle('secretScan:getSummary', async (): Promise<IpcResult<SecretScanSummary>> => {
    try {
      const result = secretScanService.getFindingsSummary()
      return ipcSuccess(result)
    } catch (error) {
      log.error('IPC secretScan:getSummary failed:', error)
      return ipcError('SECRET_SCAN_GET_SUMMARY_ERROR', String(error))
    }
  })

  ipcMain.handle(
    'secretScan:ignoreFinding',
    async (_event, id: unknown): Promise<IpcResult<void>> => {
      try {
        if (typeof id !== 'number' || !Number.isFinite(id) || id < 1) {
          return ipcError('INVALID_INPUT', 'Finding ID must be a positive number')
        }
        secretScanService.ignoreFinding(id)
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC secretScan:ignoreFinding failed:', error)
        return ipcError('SECRET_SCAN_IGNORE_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'secretScan:redactFinding',
    async (_event, id: unknown): Promise<IpcResult<void>> => {
      try {
        if (typeof id !== 'number' || !Number.isFinite(id) || id < 1) {
          return ipcError('INVALID_INPUT', 'Finding ID must be a positive number')
        }
        await secretScanService.redactFinding(id)
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC secretScan:redactFinding failed:', error)
        return ipcError('SECRET_SCAN_REDACT_ERROR', String(error))
      }
    }
  )

  ipcMain.handle('secretScan:redactAll', async (): Promise<IpcResult<number>> => {
    try {
      const count = await secretScanService.redactFindings()
      return ipcSuccess(count)
    } catch (error) {
      log.error('IPC secretScan:redactAll failed:', error)
      return ipcError('SECRET_SCAN_REDACT_ALL_ERROR', String(error))
    }
  })

  // ============= Custom Pattern Handlers =============

  ipcMain.handle(
    'secretScan:getCustomPatterns',
    async (): Promise<IpcResult<CustomSecretPattern[]>> => {
      try {
        return ipcSuccess(secretScanService.getCustomPatterns())
      } catch (error) {
        log.error('IPC secretScan:getCustomPatterns failed:', error)
        return ipcError('CUSTOM_PATTERNS_GET_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'secretScan:upsertCustomPattern',
    async (
      _event,
      pattern: unknown
    ): Promise<IpcResult<{ success: boolean; warnings: string[] }>> => {
      try {
        const p = pattern as CustomSecretPattern
        if (
          !p ||
          typeof p.id !== 'string' ||
          typeof p.source !== 'string' ||
          typeof p.label !== 'string'
        ) {
          return ipcError('INVALID_INPUT', 'Pattern must have id, label, and source')
        }
        const result = await secretScanService.upsertCustomPattern(p)
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC secretScan:upsertCustomPattern failed:', error)
        return ipcError('CUSTOM_PATTERNS_UPSERT_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'secretScan:deleteCustomPattern',
    async (_event, id: unknown): Promise<IpcResult<void>> => {
      try {
        if (typeof id !== 'string') {
          return ipcError('INVALID_INPUT', 'Pattern ID must be a string')
        }
        await secretScanService.deleteCustomPattern(id)
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC secretScan:deleteCustomPattern failed:', error)
        return ipcError('CUSTOM_PATTERNS_DELETE_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'secretScan:testPattern',
    async (
      _event,
      source: unknown,
      flags: unknown,
      testString: unknown
    ): Promise<IpcResult<PatternTestResult>> => {
      try {
        if (typeof source !== 'string' || typeof testString !== 'string') {
          return ipcError('INVALID_INPUT', 'Source and testString must be strings')
        }
        const safeFlags = typeof flags === 'string' ? flags : ''
        const result = secretScanService.testPattern(source, safeFlags, testString)
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC secretScan:testPattern failed:', error)
        return ipcError('CUSTOM_PATTERNS_TEST_ERROR', String(error))
      }
    }
  )
}
