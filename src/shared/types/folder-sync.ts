import type { IpcResult } from './ipc'

export interface FolderSyncIssue {
  source: string
  code: string
  message: string
}
export interface SharedHistoryChoice {
  workspaceId: string
  name: string
  createdAt: string
}
export interface FolderSyncState {
  connected: boolean
  enabled: boolean
  workspaceId: string | null
  name: string | null
  folder: string | null
  status: 'disabled' | 'idle' | 'incomplete' | 'update-required' | 'unavailable'
  lastPublishedAt: string | null
  lastImportedAt: string | null
  pending: number
  issues: FolderSyncIssue[]
  /** Joined with local clients/projects: they and everything referencing them wait for review. */
  joinReviewRequired: boolean
  /** Available transfer files have been imported before identity matching. */
  joinReviewReady?: boolean
  /** Active background preparation; counts are local work, not cloud delivery acknowledgments. */
  progress?: { stage: string; completed: number }
}
export type JoinReviewValue = string | number | boolean | null
/** A client/project on this computer that was never shared. Unique names can be matched during setup. */
export interface JoinReviewLocalRecord {
  entityType: 'client' | 'project'
  localSyncId: string
  name: string
  values: Record<string, JoinReviewValue>
  /** Projects: this computer's client. */
  clientLocalSyncId?: string
  clientName?: string
  /** Projects: the client's shared ID when already decided (built-in or shared); null while it awaits this review. */
  clientSharedId?: string | null
  /** Shared records of the same type with the same name. Unique matches are applied automatically within the same client. */
  suggestions: string[]
  /** Existing project folder on this computer, never exported. */
  directoryPath?: string | null
}
export interface JoinReviewSharedRecord {
  entityType: 'client' | 'project'
  entityId: string
  /** Agreed name, or null while the name is conflicted. */
  name: string | null
  /** Projects: agreed shared client, or null while conflicted. */
  clientSyncId: string | null
  clientName: string | null
  values: Record<string, JoinReviewValue>
  conflicts: string[]
  localSyncId?: string
  directoryPath?: string | null
}
export interface FolderSyncJoinReview {
  workspaceId: string
  required: boolean
  /** Covers every shown local and shared record; a changed record makes applying fail. */
  fingerprint: string
  local: JoinReviewLocalRecord[]
  shared: JoinReviewSharedRecord[]
  /** Every name a shared client has or might keep; a separate local client needs another name. */
  sharedClientNames: string[]
}
export type FolderSyncJoinDecision =
  | { entityType: 'client' | 'project'; localSyncId: string; action: 'link'; sharedId: string }
  | { entityType: 'client' | 'project'; localSyncId: string; action: 'separate'; name?: string }
export interface ApplyFolderSyncJoinReview {
  fingerprint: string
  /** Exactly one decision per local record in the review. */
  decisions: FolderSyncJoinDecision[]
  folders?: { sharedId: string; directoryPath: string }[]
}
export interface ConnectFolderSync {
  mode: 'create' | 'join'
  folder: string
  name?: string
  workspaceId?: string
  reportingTimeZone?: string
}
export interface FolderSyncApi {
  status(): Promise<IpcResult<FolderSyncState>>
  discover(
    folder: string
  ): Promise<IpcResult<{ workspaces: SharedHistoryChoice[]; issues: FolderSyncIssue[] }>>
  connect(input: ConnectFolderSync): Promise<IpcResult<FolderSyncState>>
  setEnabled(enabled: boolean): Promise<IpcResult<FolderSyncState>>
  syncNow(): Promise<IpcResult<FolderSyncState>>
  joinReview(): Promise<IpcResult<FolderSyncJoinReview>>
  applyJoinReview(input: ApplyFolderSyncJoinReview): Promise<IpcResult<FolderSyncState>>
}
