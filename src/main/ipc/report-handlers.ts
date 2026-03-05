import { ipcMain } from 'electron'
import log from 'electron-log/main.js'
import { reportService } from '../services/report-service'
import { ipcSuccess, ipcError } from '../../shared/types/ipc'
import type { ReportFilters, ReportFormat, ReportResult } from '../../shared/types/report'
import type { IpcResult } from '../../shared/types/ipc'

export function registerReportHandlers(): void {
  ipcMain.handle(
    'report:generate',
    async (
      _event,
      filters: ReportFilters,
      format: ReportFormat
    ): Promise<IpcResult<ReportResult>> => {
      try {
        const result = reportService.generateReport(filters, format)
        return ipcSuccess(result)
      } catch (error) {
        log.error('IPC report:generate failed:', error)
        return ipcError('REPORT_GENERATE_ERROR', String(error))
      }
    }
  )
}
