import { sourceMachineCoverage } from '../services/folder-sync-machine-coverage'
import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import { getDb } from '../db'
import { AppError, ipcError, ipcSuccess, type IpcResult } from '../../shared/types/ipc'
import {
  SOURCE_MACHINE_CHANNELS,
  type RenameSourceMachineInput,
  type SourceMachineSummary
} from '../../shared/types/source-machine'
import { getLocalDeviceSession } from '../services/device-context'
import { listSourceMachines } from '../services/folder-sync-machine-view'
import { journalMachineRename } from '../services/folder-sync-machine-records'

function localDeviceId(): string | null {
  try {
    return getLocalDeviceSession().deviceId
  } catch {
    return null
  }
}

function failure(channel: string, fallback: string, error: unknown): IpcResult<never> {
  log.error(`IPC ${channel} failed:`, error)
  return error instanceof AppError
    ? ipcError(error.code, error.message)
    : ipcError(fallback, String(error))
}

/** Source Machine list and shared-label rename. Register from the main IPC root. */
export function registerMachineHandlers(): void {
  ipcMain.handle('machine:coverage', () => {
    try {
      return ipcSuccess(sourceMachineCoverage(getDb(), localDeviceId()))
    } catch (error) {
      return failure('machine:coverage', 'MACHINE_COVERAGE_ERROR', error)
    }
  })
  ipcMain.handle(
    SOURCE_MACHINE_CHANNELS.list,
    async (): Promise<IpcResult<SourceMachineSummary[]>> => {
      try {
        return ipcSuccess(listSourceMachines(getDb(), localDeviceId()))
      } catch (error) {
        return failure(SOURCE_MACHINE_CHANNELS.list, 'MACHINE_LIST_ERROR', error)
      }
    }
  )

  ipcMain.handle(
    SOURCE_MACHINE_CHANNELS.rename,
    async (_event, input: RenameSourceMachineInput): Promise<IpcResult<SourceMachineSummary>> => {
      try {
        const db = getDb()
        journalMachineRename(db, input)
        const summary = listSourceMachines(db, localDeviceId()).find(
          (machine) => machine.deviceId === input.deviceId
        )
        if (!summary) throw new AppError('SOURCE_MACHINE_NOT_FOUND', 'Machine not found')
        return ipcSuccess(summary)
      } catch (error) {
        return failure(SOURCE_MACHINE_CHANNELS.rename, 'MACHINE_RENAME_ERROR', error)
      }
    }
  )
}
