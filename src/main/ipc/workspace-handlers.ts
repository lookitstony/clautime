import { ipcMain } from 'electron'
import { getDb } from '../db'
import { AppError, ipcError, ipcSuccess } from '../../shared/types/ipc'
import { getWorkspacePolicy } from '../services/workspace-policy'
import {
  reviewWorkspacePolicy,
  reviewWorkspaceActivityAdoption
} from '../services/workspace-review'
import { adoptSessionActivityMappings } from '../services/session-activity-mappings'
import { applySessionMappingApplication } from '../services/session-mapping-application'
import type {
  WorkspacePolicyReviewRequest,
  WorkspacePolicyApplyRequest
} from '../../shared/types/workspace-policy'

export function registerWorkspaceHandlers(): void {
  const handle = <TArgs extends unknown[], TResult>(
    name: string,
    action: (...args: TArgs) => TResult
  ) => {
    ipcMain.handle(`workspace:${name}`, (_event, ...args: TArgs) => {
      try {
        return ipcSuccess(action(...args))
      } catch (error) {
        return ipcError(
          error instanceof AppError ? error.code : 'WORKSPACE_ERROR',
          error instanceof Error ? error.message : String(error)
        )
      }
    })
  }
  handle('getPolicy', () => getWorkspacePolicy(getDb()))
  handle('reviewPolicy', (request: WorkspacePolicyReviewRequest) =>
    reviewWorkspacePolicy(getDb(), request)
  )
  handle('applyPolicy', (request: WorkspacePolicyApplyRequest) => {
    const {
      decisionId,
      candidate,
      expectedFingerprint,
      choices,
      acknowledgedHeld,
      acknowledgedReductions
    } = request
    applySessionMappingApplication(getDb(), {
      decisionId,
      candidate,
      expectedFingerprint,
      choices,
      acknowledgedHeld,
      acknowledgedReductions
    })
  })
  handle('reviewActivity', () => reviewWorkspaceActivityAdoption(getDb()))
  handle('adoptActivity', (fingerprint: string, sessionIds: number[]) => {
    adoptSessionActivityMappings(getDb(), fingerprint, sessionIds)
  })
}
