import type { IpcResult } from './ipc'

/*
 * Visible conflict review for shared history (folder-sync-plan.md decisions E and H).
 *
 * Every item carries what its resolution must echo back unchanged: the exact current heads of a
 * causal record, or a review fingerprint over the exact records a session choice was shown with.
 * The main process rejects a resolution whose review is stale; nothing is ever resolved on the
 * user's behalf. Labels are human text only; raw paths and protocol names never appear.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/** Head change IDs per field (`$present` included), exactly as the record showed them. */
export type ConflictHeads = Record<string, string[]>

export interface ConflictChoice {
  value: JsonValue
  label: string
}

export interface ConflictField {
  field: string
  label: string
  /** The last value every computer agreed on, when there is one. */
  lastAgreed: ConflictChoice | null
  alternatives: ConflictChoice[]
}

/** A client, project or manual time entry changed differently on two computers. */
export interface RecordConflict {
  kind: 'record'
  key: string
  entityType: 'client' | 'project' | 'manual-entry'
  entityId: string
  title: string
  /** Edited on one computer and deleted on another: choose keep or delete. */
  lifecycleConflict: boolean
  fields: ConflictField[]
  expectedHeads: ConflictHeads
  /**
   * Manual entries with a lifecycle conflict: keep it, or exactly one removal recorded for it
   * (deleted, or a split into parts). Replaces the plain keep/delete choice.
   */
  lifecycleChoices?: LegacyLifecycleChoice[]
  /** Manual entries: parts split from it that wait for the choice. */
  waiting?: string[]
}

export interface PolicyChoice {
  value: JsonValue
  label: string
  reportingTimeZone: string
  idleTimeoutMinutes: number
}

export interface PolicyConflict {
  kind: 'policy'
  key: string
  title: string
  lastAgreed: PolicyChoice | null
  alternatives: PolicyChoice[]
  expectedHeads: ConflictHeads
}

export interface SessionAssignment {
  clientSyncId: string | null
  projectSyncId: string | null
}

export interface SessionTimeCorrection {
  startedAt?: string
  endedAt?: string
  durationMinutes?: number
}

/** Changes to the original session after this part was split off, shown for acceptance. */
export interface SessionCopyEdits {
  entityId: string
  source: string
  revisions: string[]
  summary: string
}

export interface SessionFragmentConflict {
  fragmentHash: string
  title: string
  reasons: string[]
  /** Held fields: 'assignment', 'description', 'billable' or 'time'. */
  fields: ConflictField[]
  lifecycleConflict: boolean
  copyEdits: SessionCopyEdits[]
  current: {
    assignment: string
    description: string | null
    billable: boolean
    startedAt: string
    endedAt: string
    durationMinutes: number
  }
}

export interface SessionDeletionConflict {
  operationId: string
  entityId: string
  summary: string
}

export interface SessionConflict {
  kind: 'session'
  key: string
  provider: string
  conversationId: string
  title: string
  reviewFingerprint: string
  fragments: SessionFragmentConflict[]
  mapping: { expectedHeads: ConflictHeads; alternatives: ConflictChoice[] } | null
  deletions: SessionDeletionConflict[]
  /** Explanations of edits that cannot be placed yet; no action is offered for them. */
  held: string[]
}

export interface LegacyCandidate {
  legacyId: string
  label: string
  /** Whether it counts in totals on this computer right now. */
  counting: boolean
}

/** A review another computer recorded for the same saved copies. */
export interface LegacyPreviousReview {
  label: string
  keep: string[]
  duplicates: string[]
}

export interface LegacyConflict {
  kind: 'legacy'
  key: string
  provider: string
  conversationId: string
  title: string
  explanation: string
  candidates: LegacyCandidate[]
  /** Disagreeing reviews, shown so the user can start from one; never applied on their own. */
  previousReviews: LegacyPreviousReview[]
  /** Only copies with recorded activity over the same time may all be marked duplicate. */
  activityOverlap: boolean
  reviewFingerprint: string
}

/** Keep the saved session counting (present) or one of the removals another computer made. */
export interface LegacyLifecycleChoice {
  present: boolean
  /** null to keep it; otherwise the exact removal shown (deleted, split, attached, replaced). */
  disposition: JsonValue
  label: string
}

/** A saved (legacy) session edited, removed or split differently on two computers. */
export interface LegacyEditConflict {
  kind: 'legacy-edit'
  key: string
  legacyId: string
  title: string
  /** What applies until a choice is made. */
  current: string
  lifecycle: LegacyLifecycleChoice[] | null
  /** Held fields: 'assignment', 'startedAt', 'endedAt', 'durationMinutes', 'description', 'billable'. */
  fields: ConflictField[]
  /** Parts split from this session that wait for the choice. */
  waiting: string[]
  expectedHeads: ConflictHeads
}

/** Visible but not resolvable here (invoices, orphaned edits, newer record types). */
export interface HeldConflict {
  kind: 'held'
  key: string
  title: string
  explanation: string
}

export type SyncConflictItem =
  | RecordConflict
  | PolicyConflict
  | SessionConflict
  | LegacyConflict
  | LegacyEditConflict
  | HeldConflict

export interface SyncConflictReview {
  items: SyncConflictItem[]
}

export interface SessionConflictValues {
  assignment?: SessionAssignment
  description?: string | null
  billable?: boolean
  time?: SessionTimeCorrection | null
}

export type SyncConflictResolution =
  | {
      kind: 'record'
      entityType: 'client' | 'project' | 'manual-entry'
      entityId: string
      expectedHeads: ConflictHeads
      /** false deletes: a client/project is deactivated, a manual entry is kept for audit. */
      present: boolean
      values: Record<string, JsonValue>
      /** Required when the item showed lifecycleChoices: the chosen one's disposition exactly. */
      disposition?: JsonValue
    }
  | { kind: 'policy'; expectedHeads: ConflictHeads; policy: JsonValue }
  | {
      kind: 'session-fragment'
      provider: string
      conversationId: string
      fragmentHash: string
      reviewFingerprint: string
      /** 'remove-edit' only for an edit that was changed and removed concurrently. */
      action: 'set' | 'remove-edit'
      values: SessionConflictValues
      /** Only the copy edits the user explicitly accepted, exactly as shown. */
      acknowledgedCopyEdits: Array<Pick<SessionCopyEdits, 'entityId' | 'source' | 'revisions'>>
    }
  | {
      kind: 'session-mapping'
      provider: string
      conversationId: string
      reviewFingerprint: string
      expectedHeads: ConflictHeads
      value: SessionAssignment
    }
  | {
      kind: 'session-deletion'
      provider: string
      conversationId: string
      reviewFingerprint: string
      operationId: string
      entityId: string
    }
  | {
      kind: 'legacy'
      provider: string
      conversationId: string
      /** The group's review fingerprint as shown; earlier reviews are superseded only if seen. */
      reviewFingerprint: string
      candidates: string[]
      keep: string[]
      duplicates: string[]
    }
  | {
      kind: 'legacy-edit'
      legacyId: string
      expectedHeads: ConflictHeads
      /** Required when the item showed lifecycle choices; one of them exactly. */
      lifecycle?: Pick<LegacyLifecycleChoice, 'present' | 'disposition'>
      /** Field choices; each must be one of the shown alternatives or the last agreed value. */
      values: Record<string, JsonValue>
    }

export interface SyncConflictOutcome {
  /** Plain-language follow-ups, e.g. a policy change that now needs review. */
  followUp: string[]
}

export interface SyncConflictApi {
  list(options?: { presentation?: boolean }): Promise<IpcResult<SyncConflictReview>>
  resolve(resolution: SyncConflictResolution): Promise<IpcResult<SyncConflictOutcome>>
}
