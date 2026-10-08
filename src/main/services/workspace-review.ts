import { randomUUID } from 'node:crypto'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type {
  WorkspacePolicyReviewRequest,
  WorkspacePolicyReview,
  WorkspaceActivityAdoptionReview
} from '../../shared/types/workspace-policy'
import { previewSessionMappingTransitions } from './session-mapping-transitions'
import { planSessionMappingApplication } from './session-mapping-plan'
import { mappingHeldKeys } from './session-mapping-application'
import { previewSessionActivityAdoption } from './session-activity-mappings'

type AdoptionConversation = WorkspaceActivityAdoptionReview['conversations'][number]

/** Renderer projection excludes retained raw observations and invoice audit payloads. */
export function reviewWorkspacePolicy<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  request: WorkspacePolicyReviewRequest
): WorkspacePolicyReview {
  const preview = previewSessionMappingTransitions(db, request.candidate)
  const plan = planSessionMappingApplication(
    preview,
    request.decisionId ?? randomUUID(),
    request.choices,
    request.acknowledgedReductions
  )
  return {
    decisionId: plan.decisionId,
    fingerprint: preview.fingerprint,
    candidate: plan.candidatePolicy,
    choices: plan.choices,
    heldKeys: mappingHeldKeys(plan),
    acknowledgedReductions: plan.acknowledgedReductions,
    reductions: plan.coverageReductions.map((row) => ({
      key: row.key,
      conversationId: row.conversationId,
      beforeMinutes: row.beforeMinutes,
      afterMinutes: row.afterMinutes,
      uncountedEvents: row.uncountedEvents.length,
      uncountedUsage: row.uncountedUsage.length,
      uncountedTokens: row.uncountedUsage.reduce(
        (sum, entry) =>
          sum +
          entry.usage.inputTokens +
          entry.usage.outputTokens +
          entry.usage.cacheCreationInputTokens +
          entry.usage.cacheReadInputTokens,
        0
      ),
      gaps: row.removedContinuity.map(({ startedAt, endedAt }) => ({ startedAt, endedAt }))
    })),
    retainedWithoutActivity: plan.retainedWithoutActivity,
    conversations: plan.conversations.map((row) => ({
      key: JSON.stringify([row.provider, row.conversationId]),
      provider: row.provider,
      conversationId: row.conversationId,
      status: row.status,
      reasons: row.heldReasons,
      before: preview.history.saved.sessions
        .filter((saved) => row.activeSessionIds.includes(saved.id))
        .map(({ id, startedAt, endedAt, durationMinutes }) => ({
          id,
          startedAt,
          endedAt,
          durationMinutes
        })),
      after: row.successors.map(({ effective }) => effective),
      requiredChoices: row.requiredChoices.map((choice) => ({
        afterIndex: choice.afterIndex,
        fields: choice.conflictingFields,
        sources: choice.candidateSessionIds.map((id) => {
          const saved = preview.history.saved.sessions.find((entry) => entry.id === id)!
          return {
            sessionId: id,
            label: `${saved.startedAt} · ${saved.projectPath} · ${saved.description ?? 'No description'} · ${saved.billable ? 'Billable' : 'Non-billable'}`
          }
        })
      }))
    }))
  }
}

export function reviewWorkspaceActivityAdoption<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>
): WorkspaceActivityAdoptionReview {
  const preview = previewSessionActivityAdoption(db)
  const linked = new Set(preview.saved.activityMappings.map((row) => row.sessionId))
  return {
    fingerprint: preview.fingerprint,
    // Mirrors adoptSessionActivityMappings: every active row of a conversation is linked together.
    conversations: preview.conversations.flatMap((conversation): AdoptionConversation[] => {
      const active = preview.saved.sessions.filter(
        (row) =>
          conversation.savedSessionIds.includes(row.id) &&
          preview.comparisons.find((entry) => entry.sessionId === row.id)?.disposition === 'active'
      )
      if (!active.length) return []
      const reasons = [
        ...new Set(
          active.flatMap((row): string[] => {
            const comparison = preview.comparisons.find((entry) => entry.sessionId === row.id)!
            if (comparison.status !== 'comparable') return [comparison.reason]
            return row.status === 'completed' ? [] : ['running-session']
          })
        )
      ]
      const pendingSessionIds = active.filter((row) => !linked.has(row.id)).map((row) => row.id)
      return [
        {
          key: JSON.stringify([conversation.provider, conversation.conversationId]),
          provider: conversation.provider,
          conversationId: conversation.conversationId,
          status: reasons.length ? 'blocked' : pendingSessionIds.length ? 'ready' : 'linked',
          reasons,
          pendingSessionIds,
          sessions: active.map((row) => ({
            sessionId: row.id,
            startedAt: row.startedAt,
            durationMinutes: row.durationMinutes,
            adopted: linked.has(row.id)
          }))
        }
      ]
    }),
    rows: preview.saved.sessions.map((row) => {
      const comparison = preview.comparisons.find((entry) => entry.sessionId === row.id)!
      return {
        sessionId: row.id,
        conversationId: row.claudeSessionId,
        startedAt: row.startedAt,
        durationMinutes: row.durationMinutes,
        eligible: row.status === 'completed' && comparison.status === 'comparable',
        adopted: preview.saved.activityMappings.some((entry) => entry.sessionId === row.id),
        reason: comparison.status === 'comparable' ? null : comparison.reason
      }
    })
  }
}
