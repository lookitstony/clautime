import { and, eq, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import type { ParsedMessage, ParsedSessionData, TokenUsage } from '../parsers/types'
import { requireExplicitTimestamp, type NormalizationVersion } from '../../shared/tracking-policy'
import {
  readCanonicalCodexActivity,
  type CanonicalCodexConversation,
  type CodexCheckpointHold,
  type CodexUnresolvedReason,
  type CodexUsageReference
} from './canonical-codex'
import { projectCanonicalOpencode, type OpencodeUnresolvedReason } from './canonical-opencode'

type UnresolvedReason =
  | 'unsupported-provider'
  | 'unsupported-version'
  | 'missing-observation'
  | 'conflicting-observations'
  | 'invalid-observation'
  | 'unknown-ancestry'
  | 'missing-predecessor'
  | 'ambiguous-roots'
  | 'cyclic-ancestry'
  | 'branching-messages'
  | 'nonmonotonic-time'
  | 'unscoped-progress'
  | 'no-messages'

export interface CanonicalEventReference {
  eventId: string
  observationId: string
  kind: 'message' | 'progress'
  timestamp: string
  /**
   * Codex only: every compatible observation the adapter justified for this fact.
   * observationId is then the least of these, not a winner. Absent for other providers.
   */
  observationIds?: string[]
}

export type CanonicalConversation = {
  provider: string
  conversationId: string
  eventIds: string[]
  observationIds: string[]
} & (
  | {
      status: 'resolved'
      recording: ParsedSessionData
      events: CanonicalEventReference[]
      /** Codex only: checkpoint deltas behind every counted token, including unowned usage. */
      usage?: CodexUsageReference[]
    }
  | {
      status: 'unresolved'
      reason: UnresolvedReason | CodexUnresolvedReason | OpencodeUnresolvedReason
      checkpoint?: CodexCheckpointHold
    }
)

const observations = (event: CanonicalEventReference) => [
  event.observationId,
  ...(event.observationIds ?? [])
]
/**
 * Whether a previously referenced event is still the same retained fact. Later compatible
 * observations may be added (and change the least observationId); none may disappear.
 */
export function retainsCanonicalEvent(
  previous: CanonicalEventReference,
  current: CanonicalEventReference
): boolean {
  const available = new Set(observations(current))
  return (
    previous.eventId === current.eventId &&
    previous.kind === current.kind &&
    previous.timestamp === current.timestamp &&
    observations(previous).every((id) => available.has(id))
  )
}

type Event = {
  id: string
  parent: string | null
  timestamp: string
  message: ParsedMessage | null
}
// Gemini JSON snapshots record array-order predecessors for messages and progress.
// OpenCode (no prompt predecessors; replies link only to their prompt) and Codex
// (checkpoint usage) have their own adapters.
const supportedProviders = ['claude', 'gemini'] as const
type SupportedProvider = (typeof supportedProviders)[number]

const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0
})
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function decode(
  provider: SupportedProvider,
  id: string,
  conversationId: string,
  kind: string,
  json: string
): Event | null {
  const value: unknown = JSON.parse(json)
  if (!object(value) || typeof value.timestamp !== 'string') return null
  requireExplicitTimestamp(value.timestamp)
  if (
    value.parentEventId !== null &&
    (typeof value.parentEventId !== 'string' || !value.parentEventId.trim())
  )
    return null
  const base = {
    id,
    parent: value.parentEventId as string | null,
    timestamp: new Date(value.timestamp).toISOString()
  }
  if (kind === 'activity') {
    // Gemini keeps the recorded non-message type (info/error/...) as its kind.
    const keys =
      provider === 'gemini'
        ? ['kind', 'timestamp', 'parentEventId']
        : ['kind', 'progressType', 'timestamp', 'parentEventId']
    if (
      (provider === 'gemini'
        ? typeof value.kind !== 'string' ||
          !value.kind.trim() ||
          ['user', 'gemini'].includes(value.kind)
        : value.kind !== 'progress' ||
          (value.progressType !== null && typeof value.progressType !== 'string')) ||
      Object.keys(value).some((key) => !keys.includes(key))
    )
      return null
    return { ...base, message: null }
  }
  if (
    kind !== 'message' ||
    typeof value.type !== 'string' ||
    // The Gemini parser projects only user/gemini records, never tool-result prompts.
    !(provider === 'gemini' ? ['user', 'assistant'] : ['user', 'assistant', 'system']).includes(
      value.type
    ) ||
    (provider === 'gemini' && value.isToolResult !== false) ||
    (value.model !== null && typeof value.model !== 'string') ||
    typeof value.isToolResult !== 'boolean' ||
    typeof value.hasToolUse !== 'boolean' ||
    !Array.isArray(value.toolNames) ||
    !value.toolNames.every((name) => typeof name === 'string') ||
    Object.keys(value).some(
      (key) =>
        ![
          'type',
          'timestamp',
          'parentEventId',
          'model',
          'usage',
          'isToolResult',
          'hasToolUse',
          'toolNames'
        ].includes(key)
    )
  )
    return null
  if (value.usage !== null) {
    if (!object(value.usage)) return null
    const keys = Object.keys(emptyUsage())
    if (
      Object.keys(value.usage).length !== keys.length ||
      !keys.every((key) => {
        const count = (value.usage as Record<string, unknown>)[key]
        return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
      })
    )
      return null
  }
  return {
    ...base,
    message: {
      type: value.type as string,
      timestamp: base.timestamp,
      sessionId: conversationId,
      cwd: null,
      gitBranch: null,
      model: value.model as string | null,
      usage: value.usage as TokenUsage | null,
      uuid: id,
      parentUuid: base.parent,
      isToolResult: value.isToolResult,
      hasToolUse: value.hasToolUse,
      toolNames: [...new Set(value.toolNames as string[])].sort()
    }
  }
}

/**
 * Captured ledger only. No source-file/observer ordering or correction winner is inferred.
 * `normalizationVersion` must be the recorded policy version whose results are compared or
 * saved (TrackingPolicy.normalizationVersion); 1 reproduces every mapping recorded before 2.
 */
export function readCanonicalActivity<TSchema extends Record<string, unknown>>(
  db: BetterSQLite3Database<TSchema>,
  conversationKeys?: readonly string[],
  options: { normalizationVersion?: NormalizationVersion } = {}
): CanonicalConversation[] {
  const normalizationVersion = options.normalizationVersion ?? 1
  if (conversationKeys?.length === 0) return []
  const selected = conversationKeys?.map((key) => JSON.parse(key) as [string, string])
  const rows = db
    .select({ identity: activityIdentities, observation: activityObservations })
    .from(activityIdentities)
    .leftJoin(activityObservations, eq(activityObservations.eventId, activityIdentities.eventId))
    .where(
      selected
        ? or(
            ...selected.map(([provider, conversationId]) =>
              and(
                eq(activityIdentities.provider, provider),
                eq(activityIdentities.conversationId, conversationId)
              )
            )
          )
        : undefined
    )
    .orderBy(
      activityIdentities.provider,
      activityIdentities.conversationId,
      activityIdentities.eventId,
      activityObservations.id
    )
    .all()
  const groups = new Map<string, typeof rows>()
  for (const row of rows) {
    const key = JSON.stringify([row.identity.provider, row.identity.conversationId])
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  // The adapter binds its checkpoint deltas to its own evidence read; callers that need
  // one snapshot across providers run this inside a transaction.
  let codex: Map<string, CanonicalCodexConversation> | undefined
  return [...groups.values()].map((group): CanonicalConversation => {
    const { provider, conversationId } = group[0].identity
    const base = {
      provider,
      conversationId,
      eventIds: [...new Set(group.map((row) => row.identity.eventId))],
      observationIds: group.flatMap((row) => (row.observation ? [row.observation.id] : []))
    }
    const unresolved = (
      reason: UnresolvedReason | CodexUnresolvedReason
    ): CanonicalConversation => ({
      ...base,
      status: 'unresolved',
      reason
    })
    if (provider === 'codex') {
      codex ??= new Map(
        readCanonicalCodexActivity(
          db,
          selected?.filter(([provider]) => provider === 'codex').map(([, id]) => id),
          // Normalization 2 is the Codex resumed-turn checkpoint ownership fix.
          { checkpointOwnership: normalizationVersion }
        ).map((entry) => [entry.conversationId, entry])
      )
      return codex.get(conversationId) ?? unresolved('inconsistent-snapshot')
    }
    // Identical under both normalization versions.
    if (provider === 'opencode') return projectCanonicalOpencode(conversationId, group)
    // Other providers need their own checkpoint/timing/fork semantics before adoption.
    const tool = supportedProviders.find((entry) => entry === provider)
    if (!tool) return unresolved('unsupported-provider')
    if (
      group.some(
        (row) =>
          row.identity.identityVersion !== 1 || (row.observation && row.observation.version !== 1)
      )
    )
      return unresolved('unsupported-version')
    if (group.some((row) => !row.observation)) return unresolved('missing-observation')
    if (base.eventIds.length !== group.length) return unresolved('conflicting-observations')
    const events = new Map<string, Event>()
    for (const { identity, observation } of group) {
      if (!['native', 'fingerprint'].includes(identity.basis))
        return unresolved('unsupported-version')
      try {
        const payload: unknown = JSON.parse(observation!.payloadJson)
        if (object(payload) && !Object.hasOwn(payload, 'parentEventId'))
          return unresolved('unknown-ancestry')
        const event = decode(
          tool,
          identity.eventId,
          conversationId,
          observation!.kind,
          observation!.payloadJson
        )
        if (!event) return unresolved('invalid-observation')
        events.set(event.id, event)
      } catch {
        return unresolved('invalid-observation')
      }
    }
    const children = new Map<string, Event[]>()
    const roots: Event[] = []
    for (const event of events.values()) {
      if (event.parent === null) {
        roots.push(event)
        continue
      }
      const parent = events.get(event.parent)
      if (!parent) return unresolved('missing-predecessor')
      if (event.timestamp < parent.timestamp) return unresolved('nonmonotonic-time')
      const siblings = children.get(parent.id) ?? []
      siblings.push(event)
      children.set(parent.id, siblings)
    }
    if (roots.length > 1) return unresolved('ambiguous-roots')
    if (!roots.length) return unresolved('cyclic-ancestry')
    // Progress can be a sibling of the next message. Follow ancestry through it,
    // but never combine two message continuations of the same predecessor.
    const queue = [{ event: roots[0], previousMessage: null as string | null }]
    const nextMessage = new Map<string | null, Event>()
    const progress: string[] = []
    for (let index = 0; index < queue.length; index++) {
      const { event, previousMessage } = queue[index]
      if (event.message) {
        if (nextMessage.has(previousMessage)) return unresolved('branching-messages')
        nextMessage.set(previousMessage, event)
      } else progress.push(event.timestamp)
      for (const child of children.get(event.id) ?? [])
        queue.push({ event: child, previousMessage: event.message ? event.id : previousMessage })
    }
    if (queue.length !== events.size) return unresolved('cyclic-ancestry')
    const messages: ParsedMessage[] = []
    let next = nextMessage.get(null)
    while (next) {
      messages.push(next.message!)
      next = nextMessage.get(next.id)
    }
    if (!messages.length) return unresolved('no-messages')
    for (const { event, previousMessage } of queue) {
      if (event.message) continue
      const following = nextMessage.get(previousMessage)
      if (previousMessage === null || (following && event.timestamp > following.timestamp))
        return unresolved('unscoped-progress')
    }
    const total = emptyUsage()
    for (const message of messages)
      for (const key of Object.keys(total) as Array<keyof TokenUsage>)
        total[key] += message.usage?.[key] ?? 0
    return {
      ...base,
      status: 'resolved',
      events: group.map(({ identity, observation }) => ({
        eventId: identity.eventId,
        observationId: observation!.id,
        kind: events.get(identity.eventId)!.message ? 'message' : 'progress',
        timestamp: events.get(identity.eventId)!.timestamp
      })),
      recording: {
        sessionId: conversationId,
        tool,
        sourceFile: '',
        projectDirectory: null,
        projectPathEncoded: '',
        messages,
        progressTimestamps: progress.sort(),
        firstTimestamp: messages[0].timestamp,
        lastTimestamp: messages[messages.length - 1].timestamp,
        totalTokenUsage: total,
        subagentTokenUsage: emptyUsage(),
        subagentMessages: [],
        subagentProgressTimestamps: [],
        models: [
          ...new Set(messages.flatMap((message) => (message.model ? [message.model] : [])))
        ].sort(),
        messageCount: messages.length,
        summary: null
      }
    }
  })
}
