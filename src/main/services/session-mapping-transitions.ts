import { createHash } from 'node:crypto'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { AppError } from '../../shared/types/ipc'
import { readTrackingPolicy } from '../../shared/tracking-policy'
import { retainsCanonicalEvent } from './canonical-activity'
import {
  relateCanonicalIntervals,
  canonicalUsageKey,
  canonicalCoverageReferences as references,
  readCanonicalIntervalSnapshot as readInterval,
  sameCanonicalInterval,
  type calculateCanonicalIntervals
} from './canonical-intervals'
import { previewWorkspaceHistory } from './workspace-history-preview'

type Interval = ReturnType<typeof calculateCanonicalIntervals>[number]
type History = ReturnType<typeof previewWorkspaceHistory>
type Mapping = History['saved']['activityMappings'][number]
type ReviewReason =
  | 'invalid-mapping'
  | 'protected-history'
  | 'running-session'
  | 'unresolved-activity'
  | 'changed-or-missing-evidence'
type Transition = {
  mappingId: string
  sessionId: number
  policyRevisionId: string
} & (
  | { status: 'review-required'; reason: ReviewReason }
  | {
      status: 'compared'
      relationship: 'unchanged' | 'one-to-one' | 'split' | 'merge' | 'complex' | 'unmatched'
      successorIndices: number[]
    }
)

/** Read-only predecessor/successor evidence. No successor identities or revisions are persisted. */
export function previewSessionMappingTransitions<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  candidate: unknown,
  conversationKeys?: readonly string[]
) {
  return db.transaction((tx) => {
    const history = previewWorkspaceHistory(tx, candidate, conversationKeys)
    const transitions = new Map<string, Transition>()
    const valid = new Map<string, { mapping: Mapping; interval: Interval }>()
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    for (const mapping of history.saved.activityMappings) {
      const base = {
        mappingId: mapping.id,
        sessionId: mapping.sessionId,
        policyRevisionId: mapping.policyRevisionId
      }
      const review = (reason: ReviewReason) =>
        transitions.set(mapping.id, { ...base, status: 'review-required', reason })
      const saved = history.saved.sessions.find((row) => row.id === mapping.sessionId)
      const comparison = history.comparisons.find((row) => row.sessionId === mapping.sessionId)
      let supportedPolicy = false
      try {
        supportedPolicy =
          JSON.stringify(readTrackingPolicy(JSON.parse(mapping.policyJson))) === mapping.policyJson
      } catch {
        /* Unsupported historical policy stays in review. */
      }
      const interval = readInterval(mapping.intervalJson, mapping.provider)
      if (
        mapping.version !== 1 ||
        !uuid.test(mapping.id) ||
        !uuid.test(mapping.policyRevisionId) ||
        mapping.workspaceId !== history.workspaceId ||
        !supportedPolicy ||
        !interval ||
        !saved ||
        saved.source !== 'auto' ||
        saved.tool !== mapping.provider ||
        saved.claudeSessionId !== mapping.conversationId
      ) {
        review('invalid-mapping')
        continue
      }
      if (
        comparison?.status === 'preserved' ||
        (comparison?.status === 'review-required' && comparison.reason === 'protected-history')
      ) {
        review('protected-history')
        continue
      }
      if (saved.status !== 'completed') {
        review('running-session')
        continue
      }
      const conversation = history.conversations.find(
        (row) => row.provider === mapping.provider && row.conversationId === mapping.conversationId
      )
      if (!conversation || conversation.status !== 'resolved') {
        review('unresolved-activity')
        continue
      }
      const retained = new Map(
        [
          ...conversation.before.flatMap((row) => references(row.coverage)),
          ...conversation.unassigned.before
        ].map((item) => [item.eventId, item])
      )
      if (
        references(interval.coverage).some((item) => {
          const current = retained.get(item.eventId)
          return !current || !retainsCanonicalEvent(item, current)
        }) ||
        (interval.coverage.usage ?? []).some(
          (entry) =>
            ![
              ...conversation.before.flatMap((row) => row.coverage.usage ?? []),
              ...(conversation.unassignedUsage?.before ?? [])
            ].some((current) => canonicalUsageKey(current) === canonicalUsageKey(entry))
        )
      ) {
        review('changed-or-missing-evidence')
        continue
      }
      valid.set(mapping.id, { mapping, interval })
    }
    const conversations = history.conversations.map((conversation) => {
      const mappings = history.saved.activityMappings.filter(
        (mapping) =>
          mapping.provider === conversation.provider &&
          mapping.conversationId === conversation.conversationId
      )
      const predecessors = mappings.flatMap((mapping) => {
        const entry = valid.get(mapping.id)
        return entry ? [entry] : []
      })
      const candidates =
        conversation.status !== 'resolved'
          ? []
          : relateCanonicalIntervals(
              predecessors.map((entry) => entry.interval),
              conversation.after
            ).map((link) => ({
              afterIndex: link.afterIndex,
              predecessors: link.predecessors.map(({ beforeIndex, ...evidence }) => ({
                mappingId: predecessors[beforeIndex].mapping.id,
                sessionId: predecessors[beforeIndex].mapping.sessionId,
                ...evidence
              }))
            }))
      for (const { mapping } of predecessors) {
        const successors = candidates.filter((link) =>
          link.predecessors.some((entry) => entry.mappingId === mapping.id)
        )
        const merge = successors.some((link) => link.predecessors.length > 1)
        const unchanged =
          successors.length === 1 &&
          conversation.status === 'resolved' &&
          sameCanonicalInterval(
            valid.get(mapping.id)!.interval,
            conversation.after[successors[0].afterIndex]
          ) &&
          mapping.policyJson === JSON.stringify(history.candidatePolicy)
        transitions.set(mapping.id, {
          mappingId: mapping.id,
          sessionId: mapping.sessionId,
          policyRevisionId: mapping.policyRevisionId,
          status: 'compared',
          relationship: !successors.length
            ? 'unmatched'
            : successors.length > 1
              ? merge
                ? 'complex'
                : 'split'
              : merge
                ? 'merge'
                : unchanged
                  ? 'unchanged'
                  : 'one-to-one',
          successorIndices: successors.map((link) => link.afterIndex)
        })
      }
      return {
        provider: conversation.provider,
        conversationId: conversation.conversationId,
        // Cardinality describes known adopted predecessors, never complete ownership.
        unmappedSessionIds: conversation.savedSessionIds.filter(
          (id) => !history.saved.activityMappings.some((mapping) => mapping.sessionId === id)
        ),
        blockedMappingIds: mappings
          .filter((mapping) => !valid.has(mapping.id))
          .map((mapping) => mapping.id),
        candidates
      }
    })
    const preview = {
      version: 1 as const,
      scope: 'adopted-mapping-transitions' as const,
      application: 'unavailable' as const,
      relationshipScope: 'retained-adopted-mappings' as const,
      history,
      mappings: history.saved.activityMappings.map((mapping) => transitions.get(mapping.id)!),
      conversations
    }
    const hash = createHash('sha256').update(JSON.stringify(preview)).digest('hex')
    return { ...preview, fingerprint: `session-mapping-transitions:v1:${hash}` }
  })
}

/** Freshness only; this does not authorize applying the proposed relationships. */
export function recheckSessionMappingTransitions<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  candidate: unknown,
  expectedFingerprint: unknown,
  conversationKeys?: readonly string[]
) {
  const current = previewSessionMappingTransitions(db, candidate, conversationKeys)
  if (typeof expectedFingerprint !== 'string' || current.fingerprint !== expectedFingerprint)
    throw new AppError(
      'STALE_MAPPING_TRANSITIONS',
      'Mapping transitions changed. Refresh and review again.'
    )
  return current
}
