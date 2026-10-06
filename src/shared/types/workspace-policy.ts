import type { TrackingPolicy } from '../tracking-policy'

export interface WorkspacePolicyState {
  workspaceId: string
  revisionId: string
  policy: Readonly<TrackingPolicy>
}

export interface WorkspaceMetadataChoice {
  provider: string
  conversationId: string
  afterIndex: number
  sourceSessionId: number
}

export interface WorkspacePolicyReviewRequest {
  candidate: TrackingPolicy
  decisionId?: string
  choices?: WorkspaceMetadataChoice[]
  acknowledgedReductions?: string[]
}

export interface WorkspacePolicyReview {
  decisionId: string
  fingerprint: string
  candidate: TrackingPolicy
  choices: WorkspaceMetadataChoice[]
  heldKeys: string[]
  acknowledgedReductions: string[]
  reductions: Array<{
    key: string
    conversationId: string
    beforeMinutes: number
    afterMinutes: number
    uncountedEvents: number
    uncountedUsage: number
    uncountedTokens: number
    gaps: Array<{ startedAt: string; endedAt: string }>
  }>
  conversations: Array<{
    key: string
    provider: string
    conversationId: string
    status: 'applicable' | 'held'
    reasons: string[]
    before: Array<{ id: number; startedAt: string; endedAt: string; durationMinutes: number }>
    after: Array<{ startedAt: string; endedAt: string; durationMinutes: number }>
    requiredChoices: Array<{
      afterIndex: number
      fields: string[]
      sources: Array<{ sessionId: number; label: string }>
    }>
  }>
  retainedWithoutActivity: number[]
}

export interface WorkspacePolicyApplyRequest {
  decisionId: string
  candidate: TrackingPolicy
  expectedFingerprint: string
  choices: WorkspaceMetadataChoice[]
  acknowledgedHeld: string[]
  acknowledgedReductions: string[]
}

export interface WorkspaceActivityAdoptionReview {
  fingerprint: string
  /** Adoption covers whole conversations; only `ready` groups can be selected. */
  conversations: Array<{
    key: string
    provider: string
    conversationId: string
    status: 'ready' | 'linked' | 'blocked'
    reasons: string[]
    /** Active saved sessions still to link; already linked sessions count toward coverage. */
    pendingSessionIds: number[]
    sessions: Array<{
      sessionId: number
      startedAt: string
      durationMinutes: number
      adopted: boolean
    }>
  }>
  rows: Array<{
    sessionId: number
    conversationId: string | null
    startedAt: string
    durationMinutes: number
    eligible: boolean
    adopted: boolean
    reason: string | null
  }>
}
