import type { activityIdentities, activityObservations } from '../db/schema/activity-evidence'
import type { ParsedMessage, TokenUsage } from '../parsers/types'
import { requireExplicitTimestamp } from '../../shared/tracking-policy'
import type { CanonicalConversation, CanonicalEventReference } from './canonical-activity'

export type OpencodeUnresolvedReason =
  | 'unsupported-version'
  | 'missing-observation'
  | 'conflicting-observations'
  | 'invalid-observation'
  | 'unknown-ancestry'
  | 'missing-predecessor'
  | 'branching-messages'
  | 'nonmonotonic-time'
  | 'no-messages'
  /** A reply still being written: its measured usage and timing can still change. */
  | 'incomplete-activity'

type Observation = typeof activityObservations.$inferSelect
type Row = { identity: typeof activityIdentities.$inferSelect; observation: Observation | null }

type MessageFact = {
  type: 'user' | 'assistant'
  timestamp: string
  parent: string | null
  parentConversation: string | null
  model: string | null
  usage: TokenUsage | null
  toolNames: string[]
  completedAt: string | null
}
type PartFact = {
  kind: string
  parent: string
  parentConversation: string | null
  startedAt: string | null
  endedAt: string | null
}
type MessageNode = MessageFact & { id: string; nativeId: string; observationId: string }

const usageKeys = [
  'inputTokens',
  'outputTokens',
  'cacheCreationInputTokens',
  'cacheReadInputTokens'
] as const
const messageKeys = [
  'type',
  'timestamp',
  'model',
  'usage',
  'isToolResult',
  'hasToolUse',
  'toolNames',
  'parentConversationId'
]
const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0
})

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
function instant(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    requireExplicitTimestamp(value)
  } catch {
    return null
  }
  return new Date(value).toISOString()
}
/** Exactly the keys given, each present. */
function only(value: Record<string, unknown>, required: string[], optional: string[]): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  )
}
function parentConversation(value: unknown): string | null | undefined {
  return value === null ? null : text(value) ? value : undefined
}

/** The captured message projection (activity-evidence.ts), never raw OpenCode files. */
function decodeMessage(value: Record<string, unknown>): MessageFact | null {
  if (!only(value, messageKeys, ['parentEventId', 'timing'])) return null
  const timestamp = instant(value.timestamp)
  const conversation = parentConversation(value.parentConversationId)
  const { type, model, usage, toolNames } = value
  if (
    !timestamp ||
    conversation === undefined ||
    (type !== 'user' && type !== 'assistant') ||
    // The OpenCode parser never records tool output as a prompt.
    value.isToolResult !== false ||
    !(model === null || text(model)) ||
    !Array.isArray(toolNames) ||
    !toolNames.every(text) ||
    new Set(toolNames).size !== toolNames.length ||
    value.hasToolUse !== toolNames.length > 0 ||
    (Object.hasOwn(value, 'parentEventId') && !text(value.parentEventId))
  )
    return null
  if (
    usage !== null &&
    (!object(usage) ||
      Object.keys(usage).length !== usageKeys.length ||
      !usageKeys.every((key) => Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0))
  )
    return null
  let completedAt: string | null = null
  if (Object.hasOwn(value, 'timing')) {
    const timing = value.timing
    if (!object(timing) || !only(timing, ['completedAt'], [])) return null
    completedAt = instant(timing.completedAt)
    if (!completedAt) return null
  }
  // Prompts carry no model, usage, tools, completion or predecessor.
  if (
    type === 'user' &&
    (model !== null ||
      usage !== null ||
      toolNames.length ||
      completedAt ||
      Object.hasOwn(value, 'parentEventId'))
  )
    return null
  return {
    type: type as MessageFact['type'],
    timestamp,
    parent: (value.parentEventId as string | undefined) ?? null,
    parentConversation: conversation,
    model: model as string | null,
    usage: usage as TokenUsage | null,
    toolNames: [...(toolNames as string[])].sort(),
    completedAt
  }
}

function decodePart(value: Record<string, unknown>): PartFact | null {
  if (!only(value, ['kind', 'parentEventId', 'parentConversationId'], ['timing'])) return null
  const conversation = parentConversation(value.parentConversationId)
  if (!text(value.kind) || !text(value.parentEventId) || conversation === undefined) return null
  let startedAt: string | null = null
  let endedAt: string | null = null
  if (Object.hasOwn(value, 'timing')) {
    const timing = value.timing
    // The capture records timing for tool parts only.
    if (value.kind !== 'tool' || !object(timing) || !only(timing, [], ['startedAt', 'endedAt']))
      return null
    startedAt = Object.hasOwn(timing, 'startedAt') ? instant(timing.startedAt) : null
    endedAt = Object.hasOwn(timing, 'endedAt') ? instant(timing.endedAt) : null
    if (
      (Object.hasOwn(timing, 'startedAt') && !startedAt) ||
      (Object.hasOwn(timing, 'endedAt') && !endedAt) ||
      (!startedAt && !endedAt)
    )
      return null
  }
  return {
    kind: value.kind as string,
    parent: value.parentEventId as string,
    parentConversation: conversation,
    startedAt,
    endedAt
  }
}

const byInstantThenId = (a: CanonicalEventReference, b: CanonicalEventReference) => {
  const left = a.timestamp + a.eventId
  const right = b.timestamp + b.eventId
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Captured OpenCode ledger only. OpenCode prompts record no predecessor and every reply
 * (including each step of a multi-step reply) names only its prompt, so messages are ordered
 * by recorded creation time, then by the native ascending message ID (the parser's order).
 * A reply that does not answer the latest earlier prompt is a fork or interleaving and holds the
 * conversation. Re-observed messages supersede only their mutable measurements (usage, model,
 * tools, completion); a conversation with a reply not yet completed is held until it is, so a
 * cited observation never changes. Tool parts add progress at their recorded start; other
 * parts are ancestry only. A subagent session is its own conversation naming its parent.
 */
export function projectCanonicalOpencode(
  conversationId: string,
  group: readonly Row[]
): CanonicalConversation {
  const base = {
    provider: 'opencode',
    conversationId,
    eventIds: [...new Set(group.map((row) => row.identity.eventId))],
    observationIds: group.flatMap((row) => (row.observation ? [row.observation.id] : []))
  }
  const unresolved = (reason: OpencodeUnresolvedReason): CanonicalConversation => ({
    ...base,
    status: 'unresolved',
    reason
  })
  if (
    group.some(
      ({ identity, observation }) =>
        identity.identityVersion !== 1 ||
        identity.basis !== 'native' ||
        (observation !== null && observation.version !== 1)
    )
  )
    return unresolved('unsupported-version')
  if (group.some((row) => !row.observation)) return unresolved('missing-observation')

  const byEvent = new Map<string, { nativeId: string | null; observations: Observation[] }>()
  for (const { identity, observation } of group) {
    const entry = byEvent.get(identity.eventId) ?? {
      nativeId: identity.nativeEventId,
      observations: []
    }
    entry.observations.push(observation!)
    byEvent.set(identity.eventId, entry)
  }

  const messages = new Map<string, MessageNode>()
  const parts: Array<{ id: string; fact: PartFact; observationId: string }> = []
  const conversations = new Set<string | null>()
  for (const [id, { nativeId, observations }] of byEvent) {
    const kinds = new Set(observations.map((observation) => observation.kind))
    if (kinds.size > 1) return unresolved('conflicting-observations')
    const kind = observations[0].kind
    if ((kind !== 'message' && kind !== 'activity') || !text(nativeId))
      return unresolved('invalid-observation')
    const decoded: Array<{ observationId: string; fact: MessageFact | PartFact }> = []
    for (const observation of observations) {
      let payload: unknown
      try {
        payload = JSON.parse(observation.payloadJson)
      } catch {
        return unresolved('invalid-observation')
      }
      if (!object(payload)) return unresolved('invalid-observation')
      // A reply without its prompt link has unknown ancestry, not a root.
      if (
        kind === 'message' &&
        payload.type === 'assistant' &&
        !Object.hasOwn(payload, 'parentEventId')
      )
        return unresolved('unknown-ancestry')
      const fact = kind === 'message' ? decodeMessage(payload) : decodePart(payload)
      if (!fact) return unresolved('invalid-observation')
      conversations.add(fact.parentConversation)
      decoded.push({ observationId: observation.id, fact })
    }
    decoded.sort((a, b) => (a.observationId < b.observationId ? -1 : 1))
    const immutable = new Set(
      decoded.map(({ fact }) =>
        'type' in fact
          ? JSON.stringify([fact.type, fact.timestamp, fact.parent])
          : JSON.stringify([fact.kind, fact.parent])
      )
    )
    if (immutable.size !== 1) return unresolved('conflicting-observations')

    if (kind === 'activity') {
      const facts = decoded.map((entry) => entry.fact as PartFact)
      const starts = new Set(facts.flatMap((fact) => fact.startedAt ?? []))
      const ends = new Set(facts.flatMap((fact) => fact.endedAt ?? []))
      if (starts.size > 1 || ends.size > 1) return unresolved('conflicting-observations')
      // Cite the fullest observation: a running tool is superseded by its completed record.
      const rank = (fact: PartFact) => Number(!!fact.startedAt) + Number(!!fact.endedAt)
      const best = Math.max(...facts.map(rank))
      const cited = decoded.find((entry) => rank(entry.fact as PartFact) === best)!
      parts.push({
        id,
        observationId: cited.observationId,
        fact: {
          ...facts[0],
          startedAt: [...starts][0] ?? null,
          endedAt: [...ends][0] ?? null
        }
      })
      continue
    }

    const facts = decoded.map((entry) => entry.fact as MessageFact)
    // Identical payloads share one observation ID, so a second observation of a prompt differs.
    if (facts[0].type === 'user') {
      if (decoded.length !== 1) return unresolved('conflicting-observations')
      messages.set(id, { ...facts[0], id, nativeId, observationId: decoded[0].observationId })
      continue
    }
    const completed = decoded.filter((entry) => (entry.fact as MessageFact).completedAt)
    if (completed.length > 1) return unresolved('conflicting-observations')
    if (!completed.length) return unresolved('incomplete-activity')
    const final = completed[0].fact as MessageFact
    // Earlier in-progress observations may lack usage, model or later tools; never contradict.
    if (
      facts.some(
        (fact) =>
          (fact.model !== null && fact.model !== final.model) ||
          fact.toolNames.some((name) => !final.toolNames.includes(name))
      )
    )
      return unresolved('conflicting-observations')
    messages.set(id, { ...final, id, nativeId, observationId: completed[0].observationId })
  }
  if (conversations.size > 1) return unresolved('conflicting-observations')
  if ([...conversations][0] === conversationId) return unresolved('invalid-observation')
  if (!messages.size) return unresolved('no-messages')

  const ordered = [...messages.values()].sort((a, b) =>
    a.timestamp < b.timestamp
      ? -1
      : a.timestamp > b.timestamp
        ? 1
        : a.nativeId < b.nativeId
          ? -1
          : a.nativeId > b.nativeId
            ? 1
            : 0
  )
  let prompt: MessageNode | null = null
  for (const node of ordered) {
    if (node.type === 'user') {
      prompt = node
      continue
    }
    const parent = messages.get(node.parent!)
    if (!parent) return unresolved('missing-predecessor')
    if (parent.type !== 'user') return unresolved('invalid-observation')
    if (parent !== prompt) return unresolved('branching-messages')
  }

  const progress: CanonicalEventReference[] = []
  for (const part of parts) {
    const owner = messages.get(part.fact.parent)
    if (!owner) return unresolved('missing-predecessor')
    const at = part.fact.startedAt ?? part.fact.endedAt
    if (
      (part.fact.startedAt && part.fact.endedAt && part.fact.endedAt < part.fact.startedAt) ||
      (at && at < owner.timestamp)
    )
      return unresolved('nonmonotonic-time')
    // As in the parser, only reply tool runs are progress evidence.
    if (part.fact.kind !== 'tool' || owner.type !== 'assistant' || !at) continue
    progress.push({
      eventId: part.id,
      observationId: part.observationId,
      kind: 'progress',
      timestamp: at
    })
  }
  progress.sort(byInstantThenId)

  const recorded: ParsedMessage[] = ordered.map((node) => ({
    type: node.type,
    timestamp: node.timestamp,
    ...(node.completedAt ? { completedAt: node.completedAt } : {}),
    sessionId: conversationId,
    cwd: null,
    gitBranch: null,
    model: node.model,
    usage: node.usage ? { ...node.usage } : null,
    uuid: node.id,
    parentUuid: node.parent,
    isToolResult: false,
    hasToolUse: node.toolNames.length > 0,
    toolNames: [...node.toolNames]
  }))
  const total = emptyUsage()
  for (const message of recorded)
    for (const key of usageKeys) total[key] += message.usage?.[key] ?? 0
  const events: CanonicalEventReference[] = [
    ...ordered.map(
      (node): CanonicalEventReference => ({
        eventId: node.id,
        observationId: node.observationId,
        kind: 'message',
        timestamp: node.timestamp
      })
    ),
    ...progress
  ].sort(byInstantThenId)
  return {
    ...base,
    status: 'resolved',
    events,
    recording: {
      sessionId: conversationId,
      tool: 'opencode',
      sourceFile: '',
      projectDirectory: null,
      projectPathEncoded: '',
      messages: recorded,
      progressTimestamps: progress.map((event) => event.timestamp).sort(),
      firstTimestamp: recorded[0].timestamp,
      lastTimestamp: recorded[recorded.length - 1].timestamp,
      totalTokenUsage: total,
      subagentTokenUsage: emptyUsage(),
      subagentMessages: [],
      subagentProgressTimestamps: [],
      models: [
        ...new Set(recorded.flatMap((message) => (message.model ? [message.model] : [])))
      ].sort(),
      messageCount: recorded.length,
      summary: null
    }
  }
}
