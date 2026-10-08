import { randomUUID } from 'node:crypto'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { sessionActivityMappings } from '../db/schema/session-activity-mappings'
import { sessionMappingRevisions } from '../db/schema/session-mapping-revisions'
import { AppError } from '../../shared/types/ipc'
import { getWorkspacePolicy } from './workspace-policy'
import {
  previewWorkspaceHistory,
  recheckWorkspaceHistoryPreview
} from './workspace-history-preview'

function currentPolicy<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>
) {
  const current = getWorkspacePolicy(db)
  if (!current)
    throw new AppError('WORKSPACE_POLICY_REQUIRED', 'Initialize or join a workspace first')
  return current.policy
}

/**
 * Review current-policy evidence and saved history before explicitly choosing rows.
 * `conversationKeys` (JSON [provider, conversationId]) reads only those conversations' ledger;
 * its fingerprint is scoped and never matches a full review.
 */
export function previewSessionActivityAdoption<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  conversationKeys?: readonly string[]
) {
  return db.transaction((tx) => previewWorkspaceHistory(tx, currentPolicy(tx), conversationKeys))
}

/**
 * Local explicit adoption only; never applies a policy or rewrites session/invoice data.
 * Pass the same `conversationKeys` as the preview that produced `expectedFingerprint`; rows
 * outside that scope are rejected as needing review.
 */
export function adoptSessionActivityMappings<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  expectedFingerprint: unknown,
  sessionIds: unknown,
  conversationKeys?: readonly string[]
) {
  if (
    !Array.isArray(sessionIds) ||
    !sessionIds.length ||
    sessionIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(sessionIds).size !== sessionIds.length
  )
    throw new AppError('INVALID_ACTIVITY_SELECTION', 'Select distinct saved session IDs')

  return db.transaction(
    (tx) => {
      const preview = recheckWorkspaceHistoryPreview(
        tx,
        currentPolicy(tx),
        expectedFingerprint,
        conversationKeys
      )
      const eligible = (sessionId: number) => {
        const comparison = preview.comparisons.find((row) => row.sessionId === sessionId)
        const saved = preview.saved.sessions.find((row) => row.id === sessionId)
        if (
          !comparison ||
          comparison.status !== 'comparable' ||
          comparison.conversationIndex === null ||
          saved?.status !== 'completed'
        )
          throw new AppError(
            'ACTIVITY_MAPPING_REVIEW_REQUIRED',
            'Selected history needs review before adopting activity coverage'
          )
        const conversation = preview.conversations[comparison.conversationIndex]
        if (conversation.status !== 'resolved')
          throw new AppError('ACTIVITY_MAPPING_REVIEW_REQUIRED', 'Activity remains unresolved')
        return {
          sessionId,
          conversation,
          comparison,
          conversationIndex: comparison.conversationIndex
        }
      }
      // Validate the full selection before inserting. Any later failure rolls back all writes.
      const selected = (sessionIds as number[]).map(eligible)
      // Adoption covers whole conversations. A partly linked conversation is held on every
      // scan and no reviewed decision can release it, so already linked rows must cover the rest.
      const requested = new Set(sessionIds as number[])
      const linked = new Set(preview.saved.activityMappings.map((row) => row.sessionId))
      for (const index of new Set(selected.map(({ conversationIndex }) => conversationIndex))) {
        for (const sessionId of preview.conversations[index].savedSessionIds) {
          const comparison = preview.comparisons.find((row) => row.sessionId === sessionId)
          if (comparison?.disposition !== 'active') continue
          if (!requested.has(sessionId) && !linked.has(sessionId))
            throw new AppError(
              'PARTIAL_ACTIVITY_ADOPTION',
              'Link every saved session of a conversation together. Refresh the review and select the whole conversation.'
            )
          eligible(sessionId)
        }
      }
      return selected.map(({ sessionId, conversation, comparison }) => {
        const existing = preview.saved.activityMappings.find((row) => row.sessionId === sessionId)
        if (existing) return existing
        const id = randomUUID()
        const mapping = tx
          .insert(sessionActivityMappings)
          .values({
            id,
            sessionId,
            version: 1,
            workspaceId: preview.workspaceId,
            policyRevisionId: preview.baseRevisionId,
            policyJson: JSON.stringify(preview.currentPolicy),
            provider: conversation.provider,
            conversationId: conversation.conversationId,
            intervalJson: JSON.stringify(conversation.before[comparison.beforeIndex]),
            previewFingerprint: preview.fingerprint,
            createdAt: new Date().toISOString(),
            revisionId: id
          })
          .returning()
          .get()
        tx.insert(sessionMappingRevisions)
          .values({
            id,
            mappingId: id,
            sessionId,
            kind: 'adopt',
            snapshotJson: JSON.stringify(mapping),
            createdAt: mapping.createdAt
          })
          .run()
        return mapping
      })
    },
    { behavior: 'immediate' }
  )
}
