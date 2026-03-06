import { ipcMain, BrowserWindow, dialog } from 'electron'
import { writeFile } from 'fs/promises'
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

  ipcMain.handle(
    'report:exportPdf',
    async (_event, html: string, filename?: string): Promise<IpcResult<boolean>> => {
      let win: BrowserWindow | null = null
      try {
        const defaultName = filename ?? `report-${new Date().toISOString().split('T')[0]}`
        const { filePath } = await dialog.showSaveDialog({
          title: 'Save Report as PDF',
          defaultPath: `${defaultName}.pdf`,
          filters: [{ name: 'PDF', extensions: ['pdf'] }]
        })
        if (!filePath) return ipcSuccess(false)

        win = new BrowserWindow({ show: false, width: 800, height: 600 })
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
        const pdfBuffer = await win.webContents.printToPDF({
          printBackground: true,
          margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }
        })
        await writeFile(filePath, pdfBuffer)
        log.info(`Report exported as PDF to: ${filePath}`)
        return ipcSuccess(true)
      } catch (error) {
        log.error('IPC report:exportPdf failed:', error)
        return ipcError('REPORT_EXPORT_PDF_ERROR', String(error))
      } finally {
        if (win && !win.isDestroyed()) win.close()
      }
    }
  )
}
