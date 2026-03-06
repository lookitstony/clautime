import { readdirSync } from 'node:fs'
import { join, parse as pathParse } from 'node:path'
import { ipcMain, dialog, Notification } from 'electron'
import { statSync } from 'node:fs'
import log from 'electron-log/main.js'
import { liveMonitorService } from '../services/live-monitor-service'
import { trayService } from '../services/tray-service'
import { widgetService } from '../services/widget-service'

import { ipcSuccess, ipcError, type IpcResult } from '../../shared/types/ipc'
import type { TodayStats, ProjectLiveStatus, ProjectAlertConfig } from '../../shared/types/live'

export function registerLiveHandlers(): void {
  ipcMain.handle(
    'live:getTodayStats',
    async (): Promise<IpcResult<TodayStats>> => {
      try {
        const stats = liveMonitorService.getTodayStats()
        return ipcSuccess(stats)
      } catch (error) {
        log.error('IPC live:getTodayStats failed:', error)
        return ipcError('LIVE_STATS_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'live:getProjectStatuses',
    async (): Promise<IpcResult<ProjectLiveStatus[]>> => {
      try {
        const statuses = await liveMonitorService.getProjectLiveStatuses()
        return ipcSuccess(statuses)
      } catch (error) {
        log.error('IPC live:getProjectStatuses failed:', error)
        return ipcError('LIVE_STATUSES_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'live:setWatching',
    async (_event, projectId: number, enabled: boolean): Promise<IpcResult<void>> => {
      try {
        liveMonitorService.setWatching(projectId, enabled)
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC live:setWatching failed:', error)
        return ipcError('LIVE_SET_WATCHING_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'live:getAlertConfig',
    async (_event, projectId: number): Promise<IpcResult<ProjectAlertConfig>> => {
      try {
        const config = liveMonitorService.getAlertConfig(projectId)
        return ipcSuccess(config)
      } catch (error) {
        log.error('IPC live:getAlertConfig failed:', error)
        return ipcError('LIVE_ALERT_CONFIG_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'live:setAlertConfig',
    async (_event, projectId: number, alertSound: string): Promise<IpcResult<void>> => {
      try {
        liveMonitorService.setAlertConfig(projectId, alertSound)
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC live:setAlertConfig failed:', error)
        return ipcError('LIVE_SET_ALERT_CONFIG_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'live:getAvailableSounds',
    async (): Promise<IpcResult<{ name: string; filename: string }[]>> => {
      try {
        const soundsDir = join(__dirname, '../../resources/sounds')
        let files: string[]
        try {
          files = readdirSync(soundsDir)
        } catch {
          files = []
        }

        const sounds = files
          .filter((f) => /\.(wav|mp3)$/i.test(f))
          .map((f) => {
            const parsed = pathParse(f)
            return {
              name: parsed.name.charAt(0).toUpperCase() + parsed.name.slice(1),
              filename: f
            }
          })

        return ipcSuccess(sounds)
      } catch (error) {
        log.error('IPC live:getAvailableSounds failed:', error)
        return ipcError('LIVE_SOUNDS_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'live:playTestSound',
    async (): Promise<IpcResult<void>> => {
      try {
        liveMonitorService.playSound('chime')
        return ipcSuccess(undefined)
      } catch (error) {
        log.error('IPC live:playTestSound failed:', error)
        return ipcError('LIVE_TEST_SOUND_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'live:selectCustomSound',
    async (): Promise<IpcResult<string | null>> => {
      try {
        const result = await dialog.showOpenDialog({
          filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg'] }],
          properties: ['openFile']
        })

        if (result.canceled || result.filePaths.length === 0) {
          return ipcSuccess(null)
        }

        const filePath = result.filePaths[0]

        // Validate file size < 10MB
        const fileStat = statSync(filePath)
        if (fileStat.size > 10 * 1024 * 1024) {
          return ipcError('FILE_TOO_LARGE', 'Audio file must be smaller than 10MB')
        }

        return ipcSuccess(filePath)
      } catch (error) {
        log.error('IPC live:selectCustomSound failed:', error)
        return ipcError('LIVE_SELECT_SOUND_ERROR', String(error))
      }
    }
  )

  ipcMain.handle(
    'live:timerStarted',
    async (_event, projectName: string, startedAt: string): Promise<IpcResult<void>> => {
      trayService.setTimer(projectName, startedAt)
      return ipcSuccess(undefined)
    }
  )

  ipcMain.handle(
    'live:timerStopped',
    async (): Promise<IpcResult<void>> => {
      trayService.clearTimer()
      return ipcSuccess(undefined)
    }
  )

  ipcMain.handle(
    'live:testNotification',
    async (): Promise<IpcResult<void>> => {
      log.info('Test notification: isSupported =', Notification.isSupported())
      const n = new Notification({
        title: '🧪 ClawdTime Test',
        body: 'If you see this, notifications work!'
      })
      n.on('show', () => log.info('Test notification: show event'))
      n.on('failed', (_e, err) => log.warn('Test notification: failed', err))
      n.on('click', () => log.info('Test notification: clicked'))
      n.show()
      return ipcSuccess(undefined)
    }
  )

  ipcMain.handle(
    'live:toggleWidget',
    async (_event, projectId: number): Promise<IpcResult<void>> => {
      widgetService.toggle(projectId)
      return ipcSuccess(undefined)
    }
  )

  ipcMain.handle(
    'live:showStopDialog',
    async (_event, projectId: number): Promise<IpcResult<void>> => {
      try {
        const { BrowserWindow } = await import('electron')
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed() && win.getSize()[0] > 300) {
            win.show()
            win.focus()
            win.webContents.send('live:openStopDialog', projectId)
            break
          }
        }
      } catch {
        // Window may be closing
      }
      return ipcSuccess(undefined)
    }
  )
}
