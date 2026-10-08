import { createHash } from 'node:crypto'
import { journalCapturedActivity } from './folder-sync-capture'
import { activityObservers, sourceMachines } from '../db/schema/activity-observers'
import { getLocalDeviceSession } from './device-context'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import {
  activityIdentities,
  activityObservations,
  activitySources
} from '../db/schema/activity-evidence'
import type { ParsedMessage, ParsedSessionData } from '../parsers/types'

type Identity = NonNullable<ParsedMessage['activityIdentity']>
type EventKey = Pick<
  Identity,
  'eventId' | 'provider' | 'version' | 'conversationId' | 'nativeEventId'
> & {
  basis: string
}
type ObservationKind = typeof activityObservations.$inferInsert.kind

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    )
  return value
}

/** Called inside the raw-message transaction. Never selects a winning correction. */
export function storeActivityEvidence<S extends Record<string, unknown>>(
  tx: BetterSQLite3Database<S>,
  parsed: ParsedSessionData,
  now: string
): void {
  const device = getLocalDeviceSession()
  const capturedObservationIds = new Set<string>()
  function observe(
    identity: EventKey,
    kind: ObservationKind,
    payload: Record<string, unknown>,
    sourceFile = parsed.sourceFile,
    isSubagent = false
  ): void {
    const payloadJson = JSON.stringify(canonical(payload))
    const hash = createHash('sha256')
      .update(JSON.stringify(['activity-observation', 1, identity.eventId, kind, payloadJson]))
      .digest('hex')
    const id = `observation:v1:${hash}`
    capturedObservationIds.add(id)
    tx.insert(activityIdentities)
      .values({
        eventId: identity.eventId,
        provider: identity.provider,
        identityVersion: identity.version,
        conversationId: identity.conversationId,
        basis: identity.basis,
        nativeEventId: identity.nativeEventId
      })
      .onConflictDoNothing()
      .run()
    tx.insert(activityObservations)
      .values({
        id,
        eventId: identity.eventId,
        version: 1,
        kind,
        payloadJson,
        createdAt: now
      })
      .onConflictDoNothing()
      .run()
    tx.insert(sourceMachines)
      .values({ deviceId: device.deviceId, initialName: device.machineName })
      .onConflictDoNothing()
      .run()
    tx.insert(activityObservers)
      .values({ observationId: id, deviceId: device.deviceId, basis: 'observed' })
      .onConflictDoNothing()
      .run()
    tx.insert(activitySources)
      .values({ observationId: id, sourceFile, isSubagent: isSubagent ? 1 : 0 })
      .onConflictDoNothing()
      .run()
  }

  const opencode = parsed.opencodeActivityEvidence
  const messageIds = new Set<string>()
  function message(msg: ParsedMessage, sourceFile: string, isSubagent: boolean): void {
    const identity = msg.activityIdentity
    if (!identity) return
    messageIds.add(identity.eventId)
    // Explicit projection: no original transcript, cwd, git branch or file UUID.
    observe(
      identity,
      'message',
      {
        type: msg.type,
        timestamp: msg.timestamp,
        parentEventId: identity.parentEventId,
        model: msg.model,
        usage: msg.usage
          ? {
              inputTokens: msg.usage.inputTokens,
              outputTokens: msg.usage.outputTokens,
              cacheCreationInputTokens: msg.usage.cacheCreationInputTokens,
              cacheReadInputTokens: msg.usage.cacheReadInputTokens
            }
          : null,
        isToolResult: msg.isToolResult,
        hasToolUse: msg.hasToolUse,
        toolNames: [...new Set(msg.toolNames)].sort(),
        ...(identity.provider === 'opencode'
          ? {
              parentConversationId: opencode?.parentConversationId,
              timing: msg.completedAt ? { completedAt: msg.completedAt } : undefined
            }
          : {})
      },
      sourceFile,
      isSubagent
    )
  }
  for (const msg of parsed.messages) message(msg, parsed.sourceFile, false)
  for (const msg of parsed.subagentMessages ?? [])
    message(
      msg,
      (msg as ParsedMessage & { sourceFile?: string }).sourceFile || parsed.sourceFile,
      true
    )

  for (const activity of parsed.claudeProgressEvidence ?? [])
    observe(
      activity.identity,
      'activity',
      {
        kind: 'progress',
        progressType: activity.progressType,
        timestamp: activity.timestamp,
        parentEventId: activity.identity.parentEventId
      },
      activity.sourceFile,
      activity.isSubagent
    )

  const codex = parsed.codexActivityEvidence
  if (codex?.status === 'captured' && codex.conversationId) {
    for (const activity of codex.activities) {
      if (messageIds.has(activity.identity.eventId)) continue
      observe(activity.identity, 'activity', {
        kind: activity.kind,
        timestamp: activity.timestamp,
        parentEventId: activity.identity.parentEventId
      })
    }
    // A checkpoint can precede the first activity. Use the captured header ID,
    // never the local parser's filename-derived session fallback.
    for (const checkpoint of codex.checkpoints)
      observe(
        {
          eventId: checkpoint.id,
          provider: 'codex',
          version: codex.version,
          conversationId: codex.conversationId,
          basis: 'checkpoint',
          nativeEventId: null
        },
        'checkpoint',
        {
          previousCheckpointId: checkpoint.previousCheckpointId,
          activityEventId: checkpoint.activityEventId,
          timestamp: checkpoint.timestamp,
          totals: checkpoint.totals,
          model: checkpoint.model
        }
      )
    // Anchored progress leaves: event type and time only, never the event payload.
    for (const progress of codex.progress)
      observe(
        {
          eventId: progress.eventId,
          provider: 'codex',
          version: codex.version,
          conversationId: codex.conversationId,
          basis: 'progress',
          nativeEventId: null
        },
        'activity',
        {
          kind: 'progress',
          progressType: progress.progressType,
          timestamp: progress.timestamp,
          parentEventId: progress.parentEventId
        }
      )
  }
  const gemini = parsed.geminiActivityEvidence
  if (gemini?.status === 'captured')
    for (const activity of gemini.activities) {
      if (messageIds.has(activity.identity.eventId)) continue
      observe(activity.identity, 'activity', {
        kind: activity.kind,
        timestamp: activity.timestamp,
        parentEventId: activity.identity.parentEventId
      })
    }
  if (opencode?.status === 'captured')
    for (const activity of opencode.activities) {
      if (messageIds.has(activity.identity.eventId)) continue
      observe(activity.identity, 'activity', {
        kind: activity.kind,
        timing: activity.timing,
        parentEventId: activity.identity.parentEventId,
        parentConversationId: opencode.parentConversationId
      })
    }
  journalCapturedActivity(tx, [...capturedObservationIds])
}
