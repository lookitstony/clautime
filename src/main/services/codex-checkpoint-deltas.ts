import { and, eq, inArray } from 'drizzle-orm'
import type { getDb } from '../db'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import type { CodexTokenCheckpoint } from '../parsers/codex-activity-identity'

type CheckpointPayload = Omit<CodexTokenCheckpoint, 'id'>
type UnresolvedReason =
  | 'missing-observation'
  | 'unsupported-version'
  | 'invalid-checkpoint'
  | 'conflicting-observations'
  | 'missing-predecessor'
  | 'cross-conversation-predecessor'
  | 'cyclic-predecessor'
  | 'unresolved-predecessor'
  | 'counter-fields-changed'
  | 'counter-decrease'
  | 'ambiguous-root-baseline'

export type CodexCheckpointDelta = { checkpointId: string; conversationId: string } & (
  | (Omit<CheckpointPayload, 'totals'> & { status: 'resolved'; delta: Record<string, number> })
  | { status: 'unresolved'; reason: UnresolvedReason }
)

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function reference(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0)
}
function decode(json: string): CheckpointPayload | null {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (
    !object(value) ||
    !reference(value.previousCheckpointId) ||
    !reference(value.activityEventId) ||
    !reference(value.model) ||
    typeof value.timestamp !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
      value.timestamp
    ) ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    !object(value.totals) ||
    !['input_tokens', 'output_tokens', 'cached_input_tokens'].every((key) =>
      Object.hasOwn(value.totals as object, key)
    ) ||
    !Object.values(value.totals).every(
      (count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
    )
  )
    return null
  return value as unknown as CheckpointPayload
}

/** Read-only raw counter deltas. Unresolved ancestry never produces billable usage. */
export function readCodexCheckpointDeltas(
  db: Pick<ReturnType<typeof getDb>, 'select'>,
  conversationIds?: readonly string[]
): CodexCheckpointDelta[] {
  if (conversationIds?.length === 0) return []
  // One statement supplies a consistent view; physical source links never multiply usage.
  const rows = db
    .select({
      checkpointId: activityIdentities.eventId,
      conversationId: activityIdentities.conversationId,
      identityVersion: activityIdentities.identityVersion,
      observationVersion: activityObservations.version,
      payloadJson: activityObservations.payloadJson
    })
    .from(activityIdentities)
    .leftJoin(
      activityObservations,
      and(
        eq(activityObservations.eventId, activityIdentities.eventId),
        eq(activityObservations.kind, 'checkpoint')
      )
    )
    .where(
      and(
        eq(activityIdentities.provider, 'codex'),
        eq(activityIdentities.basis, 'checkpoint'),
        conversationIds
          ? inArray(activityIdentities.conversationId, [...conversationIds])
          : undefined
      )
    )
    .all()
  const groups = new Map<string, typeof rows>()
  for (const row of rows) {
    const group = groups.get(row.checkpointId) ?? []
    group.push(row)
    groups.set(row.checkpointId, group)
  }
  const checkpoints = new Map<string, CheckpointPayload>()
  const rootsByConversation = new Map<string, string[]>()
  const results = new Map<string, CodexCheckpointDelta>()
  function unresolved(checkpointId: string, reason: UnresolvedReason): void {
    results.set(checkpointId, {
      checkpointId,
      conversationId: groups.get(checkpointId)![0].conversationId,
      status: 'unresolved',
      reason
    })
  }
  for (const [id, observations] of groups) {
    // A source's first checkpoint is not proof of disjoint usage. Count each
    // logical root once, even when its measurements are conflicting or invalid.
    const hasRootObservation = observations.some((row) => {
      if (row.payloadJson === null) return false
      try {
        const payload: unknown = JSON.parse(row.payloadJson)
        return object(payload) && payload.previousCheckpointId === null
      } catch {
        return false
      }
    })
    if (hasRootObservation) {
      const conversationId = observations[0].conversationId
      const roots = rootsByConversation.get(conversationId) ?? []
      roots.push(id)
      rootsByConversation.set(conversationId, roots)
    }
    if (
      observations.some(
        (row) =>
          row.identityVersion !== 1 ||
          (row.observationVersion !== null && row.observationVersion !== 1)
      )
    ) {
      unresolved(id, 'unsupported-version')
    } else if (observations[0].payloadJson === null) {
      unresolved(id, 'missing-observation')
    } else if (observations.length !== 1) {
      // Different times, model contexts, counters or parent links are all alternatives.
      unresolved(id, 'conflicting-observations')
    } else {
      const payload = decode(observations[0].payloadJson)
      if (payload) checkpoints.set(id, payload)
      else unresolved(id, 'invalid-checkpoint')
    }
  }

  for (const roots of rootsByConversation.values()) {
    if (roots.length < 2) continue
    for (const id of roots) if (!results.has(id)) unresolved(id, 'ambiguous-root-baseline')
  }

  const ids = [...groups.keys()].sort()
  for (const id of ids) {
    const path: string[] = []
    const positions = new Map<string, number>()
    let current = id
    while (!results.has(current)) {
      const cycleStart = positions.get(current)
      if (cycleStart !== undefined) {
        for (const member of path.slice(cycleStart)) unresolved(member, 'cyclic-predecessor')
        break
      }
      positions.set(current, path.length)
      path.push(current)
      const parent = checkpoints.get(current)!.previousCheckpointId
      if (parent === null) break
      if (!groups.has(parent)) {
        unresolved(current, 'missing-predecessor')
        break
      }
      if (groups.get(parent)![0].conversationId !== groups.get(current)![0].conversationId) {
        unresolved(current, 'cross-conversation-predecessor')
        break
      }
      current = parent
    }
    // Resolve from the nearest known predecessor outward, without recursive stack growth.
    for (const checkpointId of path.reverse()) {
      if (results.has(checkpointId)) continue
      const checkpoint = checkpoints.get(checkpointId)!
      const parent = checkpoint.previousCheckpointId
      if (parent !== null && results.get(parent)?.status !== 'resolved') {
        unresolved(checkpointId, 'unresolved-predecessor')
        continue
      }
      const previous = parent === null ? null : checkpoints.get(parent)!.totals
      const fields = Object.keys(checkpoint.totals).sort()
      if (
        previous &&
        (Object.keys(previous).length !== fields.length ||
          fields.some((field) => !Object.hasOwn(previous, field)))
      ) {
        unresolved(checkpointId, 'counter-fields-changed')
        continue
      }
      const delta = Object.fromEntries(
        fields.map((field) => [field, checkpoint.totals[field] - (previous?.[field] ?? 0)])
      )
      if (Object.values(delta).some((count) => count < 0)) {
        unresolved(checkpointId, 'counter-decrease')
        continue
      }
      results.set(checkpointId, {
        checkpointId,
        conversationId: groups.get(checkpointId)![0].conversationId,
        status: 'resolved',
        previousCheckpointId: parent,
        activityEventId: checkpoint.activityEventId,
        timestamp: checkpoint.timestamp,
        model: checkpoint.model,
        delta
      })
    }
  }
  return ids.map((id) => results.get(id)!)
}
